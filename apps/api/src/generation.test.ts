import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createUuidV7,
  parseUsdToMicrousd,
  transitionGenerationAttempt,
  type GenerationAttempt,
  type IdGenerator,
  type Uuid,
} from '@h3/domain';
import { createInMemoryStore } from '@h3/db';
import {
  DeterministicFakeComfyService,
  FakeComfyClient,
  HttpWsComfyClient,
  type ComfyClient,
  type ComfyHistoryRecord,
  type ComfyScenario,
} from '@h3/comfy-client';
import {
  DeterministicFixtureProcessRunner,
  MediaEvaluator,
} from '@h3/evaluator';
import { createLocalArtifactStore } from '@h3/object-store';
import { DEV_TENANT_ID, ProjectApplicationService } from './application.js';
import {
  ComfyObserver,
  GenerationApplicationService,
  GenerationWorker,
  redactFailureMessage,
} from './generation.js';

const timestamp = '2026-01-01T00:00:00.000Z';

function officialHistory(record: ComfyHistoryRecord): Record<string, unknown> {
  return {
    prompt: [0, record.extraData, {}, {}, []],
    extra_data: record.extraData,
    outputs:
      record.outputs.length > 0 ? { '4': { videos: record.outputs } } : {},
    status: {
      completed: record.completed,
      status_str: record.status,
    },
    ...(record.errorCode ? { exception_type: record.errorCode } : {}),
    ...(record.errorMessage ? { exception_message: record.errorMessage } : {}),
  };
}

function createInProcessHttpWsClient(
  service: DeterministicFakeComfyService,
): ComfyClient {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname === '/prompt' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        readonly extra_data?: Readonly<Record<string, unknown>>;
      };
      try {
        const request = {
          workflow: {},
          extraData: body.extra_data ?? {},
        } as Parameters<DeterministicFakeComfyService['submit']>[0];
        const scenario = body.extra_data?.scenario as ComfyScenario | undefined;
        const seed = body.extra_data?.seed;
        const requestWithMetadata = {
          ...request,
          ...(scenario !== undefined ? { scenario } : {}),
          ...(typeof seed === 'number' ? { seed } : {}),
        };
        const submission = service.submit(requestWithMetadata);
        return json({ prompt_id: submission.promptId });
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === 'ComfySubmissionUncertainError'
        ) {
          return json({ error: 'submission outcome uncertain' }, 504);
        }
        throw error;
      }
    }
    if (url.pathname === '/prompt') {
      const queue = service.queue();
      return json({
        queue_pending: queue.queuePending,
        queue_running: queue.queueRunning,
      });
    }
    if (url.pathname === '/history') {
      return json(
        Object.fromEntries(
          Object.entries(service.histories()).map(([promptId, record]) => [
            promptId,
            officialHistory(record),
          ]),
        ),
      );
    }
    if (url.pathname.startsWith('/history/')) {
      const promptId = decodeURIComponent(
        url.pathname.slice('/history/'.length),
      );
      const record = service.history(promptId);
      return record
        ? json({ [promptId]: officialHistory(record) })
        : json({}, 404);
    }
    if (url.pathname === '/view') {
      const filename = url.searchParams.get('filename') ?? '';
      try {
        const bytes = service.output({
          filename,
          subfolder: url.searchParams.get('subfolder') ?? '',
          type: url.searchParams.get('type') ?? 'output',
          mimeType: 'video/mp4',
        });
        return new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        });
      } catch {
        return json({}, 404);
      }
    }
    throw new Error(`Unhandled fake HTTP path: ${method} ${url.pathname}`);
  };

  class InProcessWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { readonly data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    private unsubscribe: (() => void) | undefined;

    constructor(_url: string) {
      setTimeout(() => {
        this.onopen?.();
        for (const event of service.eventsSnapshot()) {
          this.onmessage?.({ data: JSON.stringify(event.message) });
        }
        this.unsubscribe = service.addListener((_promptId, message) => {
          this.onmessage?.({ data: JSON.stringify(message) });
        });
      }, 0);
    }

    close(): void {
      this.unsubscribe?.();
      this.onclose?.();
    }

    send(_data: string): void {}
  }

  return new HttpWsComfyClient({
    baseUrl: 'http://fake-comfy.test',
    wsUrl: 'ws://fake-comfy.test/ws',
    clientId: 'generation-http-test',
    fetchImpl,
    webSocket: InProcessWebSocket,
  });
}

function ids(): IdGenerator {
  let sequence = 1;
  return {
    next: () =>
      createUuidV7(
        1_700_000_000_000 + sequence,
        new Uint8Array(10).fill(sequence++ % 255),
      ),
  };
}

async function setupProject(
  budgetUsd = '25',
  comfyClientFactory?: (service: DeterministicFakeComfyService) => ComfyClient,
) {
  const store = createInMemoryStore();
  const idGenerator = ids();
  const projectService = new ProjectApplicationService({
    store,
    tenantId: DEV_TENANT_ID,
    idGenerator,
    clock: { now: () => new Date(timestamp) },
    defaultBudgetMicrousd: parseUsdToMicrousd('25'),
  });
  const project = await projectService.createProject({
    title: 'Fixture campaign',
    brief: 'A moving synthetic product story.',
    targetDurationSeconds: 3,
    budgetMicrousd: parseUsdToMicrousd(budgetUsd),
  });
  const planned = await projectService.planProject(project.id);
  const approved = await projectService.approveStoryboard(
    project.id,
    planned.proposal.id,
  );
  const root = await mkdtemp(join(tmpdir(), 'h3-generation-test-'));
  const fakeService = new DeterministicFakeComfyService();
  const fake = new FakeComfyClient(fakeService);
  const generation = new GenerationApplicationService({
    store,
    tenantId: DEV_TENANT_ID,
    idGenerator,
    clock: { now: () => new Date(timestamp) },
    comfyClient: comfyClientFactory?.(fakeService) ?? fake,
    artifactStore: createLocalArtifactStore(root),
    evaluator: new MediaEvaluator(new DeterministicFixtureProcessRunner()),
  });
  return {
    store,
    fake,
    idGenerator,
    projectService,
    generation,
    worker: new GenerationWorker({
      service: generation,
      workerId: 'worker-test',
      timeoutSeconds: 1,
      sleep: async () => undefined,
    }),
    shots: approved.shots,
    root,
  };
}

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Phase 3 durable generation worker', () => {
  it.each([
    'success',
    'duplicate-events',
    'disconnect-reconcile',
    'uncertain-submission',
  ] as ComfyScenario[])(
    'moves %s to awaiting_review exactly once',
    async (scenario) => {
      const context = await setupProject();
      cleanups.push(context.root);
      const attempt = await context.generation.createAttempt(
        context.shots[0]?.id as Uuid,
        {
          idempotencyKey: `attempt-${scenario}`,
          scenario,
        },
      );
      expect(await context.worker.processOnce()).toBe(true);
      const result = await context.generation.getAttempt(attempt.id);
      expect(result.status).toBe('awaiting_review');
      expect(result.artifactId).toBeDefined();
      const evaluation = await context.store.withTransaction((repositories) =>
        repositories.evaluations.findByAttempt(DEV_TENANT_ID, attempt.id),
      );
      expect(evaluation?.status).toBe('passed');
      expect(await context.worker.processOnce()).toBe(false);
    },
  );

  it('moves an attempt through the fake HTTP and WebSocket adapters', async () => {
    const context = await setupProject('25', createInProcessHttpWsClient);
    cleanups.push(context.root);
    const attempt = await context.generation.createAttempt(
      context.shots[0]?.id as Uuid,
      {
        idempotencyKey: 'http-ws-attempt',
        scenario: 'disconnect-reconcile',
      },
    );

    expect(await context.worker.processOnce()).toBe(true);
    expect((await context.generation.getAttempt(attempt.id)).status).toBe(
      'awaiting_review',
    );
  });

  it('classifies execution failure and timeout without automatic regeneration', async () => {
    for (const scenario of ['execution-failure', 'timeout'] as const) {
      const context = await setupProject();
      cleanups.push(context.root);
      const attempt = await context.generation.createAttempt(
        context.shots[0]?.id as Uuid,
        {
          idempotencyKey: `attempt-${scenario}`,
          scenario,
        },
      );
      const worker = new GenerationWorker({
        service: context.generation,
        workerId: `worker-${scenario}`,
        timeoutSeconds: scenario === 'timeout' ? 0 : 1,
        sleep: async () => undefined,
      });
      expect(await worker.processOnce()).toBe(true);
      const result = await context.generation.getAttempt(attempt.id);
      expect(result.status).toBe(
        scenario === 'timeout' ? 'timed_out' : 'failed',
      );
      expect(result.failureCode).toBeDefined();
      expect(result.failureMessage).toBeDefined();
      expect(result.failureMessage).not.toContain('Bearer ');
      const attempts = await context.generation.listAttempts(
        context.shots[0]?.id as Uuid,
      );
      expect(attempts).toHaveLength(1);
    }
  });

  it('accepts one validated attempt per shot and completes the project atomically', async () => {
    const context = await setupProject();
    cleanups.push(context.root);
    const accepted: string[] = [];
    for (const [index, shot] of context.shots.entries()) {
      const attempt = await context.generation.createAttempt(shot.id, {
        idempotencyKey: `attempt-${index}`,
      });
      await context.worker.processOnce();
      const review = await context.generation.acceptAttempt(attempt.id);
      accepted.push(review.attempt.id);
    }
    expect(accepted).toHaveLength(3);
    const project = await context.projectService.getProject(
      context.shots[0]?.projectId as Uuid,
    );
    expect(project.status).toBe('completed');
    const shots = await context.projectService.listShots(project.id);
    expect(shots.every((shot) => shot.status === 'accepted')).toBe(true);
  });

  it('rejects and regenerates with immutable source history and a new seed', async () => {
    const context = await setupProject();
    cleanups.push(context.root);
    const first = await context.generation.createAttempt(
      context.shots[0]?.id as Uuid,
      {
        idempotencyKey: 'first-attempt',
      },
    );
    await context.worker.processOnce();
    const rejected = await context.generation.rejectAttempt(
      first.id,
      'too_dark',
    );
    const regenerated = await context.generation.regenerateAttempt(first.id, {
      idempotencyKey: 'second-attempt',
      seed: first.seed + 1,
    });
    expect(rejected.attempt.status).toBe('rejected');
    expect(regenerated.sourceAttemptId).toBe(first.id);
    expect(regenerated.seed).not.toBe(first.seed);
    const history = await context.generation.listAttempts(
      context.shots[0]?.id as Uuid,
    );
    expect(history.map((attempt) => attempt.status)).toEqual([
      'rejected',
      'queued',
    ]);
  });

  it('recovers a durable submitting intent by correlation without resubmitting', async () => {
    const context = await setupProject();
    cleanups.push(context.root);
    const attempt = await context.generation.createAttempt(
      context.shots[0]?.id as Uuid,
      {
        idempotencyKey: 'crash-after-submit',
      },
    );
    const submitted = context.fake.service.submit({
      workflow: {},
      extraData: { correlation_id: attempt.correlationId, seed: attempt.seed },
      seed: attempt.seed,
    });
    await context.store.withTransaction(async (repositories) => {
      const current = await repositories.attempts.findById(
        DEV_TENANT_ID,
        attempt.id,
      );
      if (!current) throw new Error('attempt missing');
      const claimed = transitionGenerationAttempt(current, 'claimed');
      const submitting = transitionGenerationAttempt(claimed, 'submitting');
      await repositories.attempts.update(
        {
          ...submitting,
          leaseOwner: 'crashed-worker',
          leaseExpiresAt: '2025-12-31T23:59:00.000Z' as NonNullable<
            GenerationAttempt['leaseExpiresAt']
          >,
        },
        current.version,
      );
    });

    expect(await context.worker.processOnce()).toBe(true);
    expect((await context.generation.getAttempt(attempt.id)).status).toBe(
      'awaiting_review',
    );
    expect(context.fake.service.submissionCount(attempt.correlationId)).toBe(1);
    expect(submitted.promptId).toBeDefined();
  });

  it('denies budget before any Comfy submission', async () => {
    const context = await setupProject('0.05');
    cleanups.push(context.root);
    await expect(
      context.generation.createAttempt(context.shots[0]?.id as Uuid, {
        idempotencyKey: 'budget-denied',
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(context.fake.service.submissionCount('')).toBe(0);
  });

  it('allows exactly one concurrent acceptance of a validated attempt', async () => {
    const context = await setupProject();
    cleanups.push(context.root);
    const attempt = await context.generation.createAttempt(
      context.shots[0]?.id as Uuid,
      {
        idempotencyKey: 'concurrent-accept',
      },
    );
    await context.worker.processOnce();
    const results = await Promise.allSettled([
      context.generation.acceptAttempt(attempt.id),
      context.generation.acceptAttempt(attempt.id),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const stored = await context.generation.getAttempt(attempt.id);
    expect(stored.status).toBe('accepted');
    const shot = await context.projectService.listShots(stored.projectId);
    expect(
      shot.find((value) => value.id === stored.shotId)?.acceptedAttemptId,
    ).toBe(attempt.id);
  });

  it('deduplicates terminal observer effects, ignores late progress, and records orphan prompts', async () => {
    const observer = new ComfyObserver();
    const progress = {
      type: 'progress' as const,
      data: { prompt_id: 'prompt-1', value: 50, max: 100 },
    };
    expect(observer.observe(progress)?.kind).toBe('progress');
    expect(observer.observe(progress)).toBeNull();
    expect(
      observer.observe({
        type: 'progress',
        data: { prompt_id: 'prompt-1', value: 25, max: 100 },
      }),
    ).not.toBeNull();
    expect(
      observer.observe({
        type: 'execution_success',
        data: { prompt_id: 'prompt-1' },
      })?.kind,
    ).toBe('succeeded');
    expect(observer.observe(progress)).toBeNull();
    expect(
      redactFailureMessage('Bearer secret-token at /private/tmp/internal.mp4'),
    ).toBe('Bearer [redacted] at [path redacted]');

    const context = await setupProject();
    cleanups.push(context.root);
    const orphan = {
      type: 'execution_error' as const,
      data: {
        prompt_id: 'unknown-prompt',
        exception_message: 'internal stack',
      },
    };
    expect(await context.generation.recordOrphanComfyMessage(orphan)).toBe(
      true,
    );
    expect(await context.generation.recordOrphanComfyMessage(orphan)).toBe(
      false,
    );
    const orphans = await context.store.withTransaction((repositories) =>
      repositories.events.listOrphans(DEV_TENANT_ID),
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.projectId).toBeUndefined();
    const projects = await context.projectService.listProjects();
    expect(projects[0]?.status).toBe('ready_for_generation');
  });
});
