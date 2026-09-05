import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import {
  createDomainEvent,
  createUuidV7,
  type DomainEvent,
  type IdGenerator,
  type Uuid,
} from '@h3/domain';
import {
  createInMemoryStore,
  type OutboxDispatcher,
  type TransactionalStore,
} from '@h3/db';
import {
  DeterministicFakeComfyService,
  FakeComfyClient,
} from '@h3/comfy-client';
import { InMemoryTelemetry } from '@h3/telemetry';
import { DEV_TENANT_ID } from './application.js';
import { buildApiApp } from './app.js';
import {
  createOperationalToolServices,
  OperationalPiAdapter,
  type FauxOperationalScript,
} from './operator.js';

const auth = { authorization: 'Bearer test-token' };
const apps: Array<Awaited<ReturnType<typeof buildApiApp>>> = [];
let idSequence = 1;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function testId(): Uuid {
  const value = idSequence++;
  return createUuidV7(
    1_700_000_000_000 + value,
    new Uint8Array(10).fill((value % 250) + 1),
  );
}

function testIds(): IdGenerator {
  return { next: testId };
}

interface TestApp {
  readonly app: Awaited<ReturnType<typeof buildApiApp>>;
  readonly store: ReturnType<typeof createInMemoryStore>;
  readonly telemetry: InMemoryTelemetry;
  readonly dispatcher: OutboxDispatcher;
  readonly adapter: OperationalPiAdapter;
}

function internals(app: Awaited<ReturnType<typeof buildApiApp>>): {
  readonly operationalDispatcher: OutboxDispatcher;
  readonly operationalPiAdapter: OperationalPiAdapter;
} {
  return app as unknown as {
    readonly operationalDispatcher: OutboxDispatcher;
    readonly operationalPiAdapter: OperationalPiAdapter;
  };
}

async function setup(script?: FauxOperationalScript): Promise<TestApp> {
  const store = createInMemoryStore();
  const telemetry = new InMemoryTelemetry();
  const comfy = new DeterministicFakeComfyService();
  const adapter = script
    ? new OperationalPiAdapter({
        store,
        tenantId: DEV_TENANT_ID,
        idGenerator: testIds(),
        telemetry,
        script,
        services: (repositories) =>
          createOperationalToolServices(repositories, DEV_TENANT_ID, {
            mode: 'fake',
            getExecutorReadiness: async () => ({
              mode: 'fake',
              ready: true,
              checkedAt: '2026-01-01T00:00:00.000Z',
              capabilityFingerprint: 'test-fingerprint',
            }),
          }),
      })
    : undefined;
  const app = buildApiApp({
    store,
    telemetry,
    idGenerator: testIds(),
    config: getApiConfig({ NODE_ENV: 'test', DEV_AUTH_TOKEN: 'test-token' }),
    comfyClient: new FakeComfyClient(comfy),
    ...(adapter ? { operationalAdapter: adapter } : {}),
  });
  apps.push(app);
  const values = internals(app);
  return {
    app,
    store,
    telemetry,
    dispatcher: values.operationalDispatcher,
    adapter: values.operationalPiAdapter,
  };
}

async function request(
  app: Awaited<ReturnType<typeof buildApiApp>>,
  options: InjectOptions,
) {
  return app.inject({ ...options, headers: { ...auth, ...options.headers } });
}

async function createProject(
  app: Awaited<ReturnType<typeof buildApiApp>>,
  prefix: string,
): Promise<Uuid> {
  const response = await request(app, {
    method: 'POST',
    url: '/v1/projects',
    headers: { 'idempotency-key': `${prefix}-project` },
    payload: {
      title: `${prefix} project`,
      brief: 'A project for operational Pi tests.',
      targetDurationSeconds: 3,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().project.id as Uuid;
}

/**
 * Phase 7D removed `POST /v1/projects/:projectId/plan` and
 * `.../storyboard/approve`; shots are no longer listed or otherwise
 * addressable. Seed one the way a real client now must: submit `POST
 * /v1/runs` with a graph that fails validation, which creates the project's
 * implicit shot (and a `shot.created` domain event) without ever reaching
 * attempt creation, leaving the shot in `approved_for_generation`.
 */
async function createApprovedShot(
  app: Awaited<ReturnType<typeof buildApiApp>>,
  prefix: string,
): Promise<{ readonly projectId: Uuid; readonly shotId: Uuid }> {
  const projectId = await createProject(app, prefix);
  const invalidRun = await request(app, {
    method: 'POST',
    url: '/v1/runs',
    headers: { 'idempotency-key': `${prefix}-seed-run` },
    payload: { projectId, editorGraph: {}, apiGraph: {} },
  });
  expect(invalidRun.statusCode).toBe(422);
  const events = await request(app, {
    method: 'GET',
    url: `/v1/projects/${projectId}/events`,
  });
  const shotCreated = (
    events.json().events as ReadonlyArray<Record<string, unknown>>
  ).find((event) => event.type === 'shot.created');
  const shotId = shotCreated?.shotId as Uuid | undefined;
  if (!shotId) throw new Error('Expected a shot.created event with a shotId.');
  return { projectId, shotId };
}

async function appendEvent(
  store: TransactionalStore,
  input: {
    readonly tenantId?: Uuid;
    readonly projectId: Uuid;
    readonly type: DomainEvent['type'];
    readonly shotId?: Uuid;
    readonly attemptId?: Uuid;
    readonly payload?: Readonly<Record<string, unknown>>;
  },
): Promise<DomainEvent> {
  const event = createDomainEvent({
    id: testId(),
    type: input.type,
    producer: 'operator-test',
    tenantId: input.tenantId ?? DEV_TENANT_ID,
    projectId: input.projectId,
    ...(input.shotId ? { shotId: input.shotId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
    clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
  });
  await store.withTransaction(async (repositories) => {
    await repositories.events.append(event);
    await repositories.outbox.enqueue(event);
  });
  return event;
}

async function drain(dispatcher: OutboxDispatcher): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (!(await dispatcher.pollOnce())) return;
  }
  throw new Error('Outbox did not drain in the test bound.');
}

async function recommendations(
  store: ReturnType<typeof createInMemoryStore>,
  projectId: Uuid,
) {
  return store.withTransaction((repositories) =>
    repositories.recommendations.listByProject(DEV_TENANT_ID, projectId),
  );
}

describe('Checkpoint 5 operational Pi adapter', () => {
  it('consumes a durable event, persists a bounded recommendation, and reuses it on duplicate delivery', async () => {
    const { app, store, telemetry, dispatcher, adapter } = await setup();
    const projectId = await createProject(app, 'duplicate');
    await drain(dispatcher);
    const event = await appendEvent(store, {
      projectId,
      type: 'executor.unavailable',
      payload: {
        prompt: 'must never reach Pi or telemetry',
        secret: 'private-value',
      },
    });

    expect(await dispatcher.pollOnce()).toBe(true);
    const first = (await recommendations(store, projectId))[0];
    if (!first) throw new Error('Expected an operational recommendation.');
    expect(first).toMatchObject({
      triggerEventId: event.id,
      recommendationCode: 'EXECUTOR_UNAVAILABLE',
      proposedActionType: 'wait_for_executor',
      status: 'pending',
      evidenceReferencesJson: [{ type: 'domain_event', resourceId: event.id }],
    });
    expect(JSON.stringify(first)).not.toContain('private-value');

    const duplicate = await adapter.processEvent(event);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.recommendation?.id).toBe(first.id);
    const runs = await store.withTransaction((repositories) =>
      repositories.agentRuns.listByProject(DEV_TENANT_ID, projectId),
    );
    expect(runs).toHaveLength(1);
    expect(duplicate.agentRun?.id).toBe(first.piAgentRunId);
    expect(telemetry.getSpans().map((span) => span.name)).toEqual(
      expect.arrayContaining(['agent.operator.run', 'agent.operator.tool']),
    );
    expect(JSON.stringify(telemetry.getSpans())).not.toContain('private-value');
    expect(JSON.stringify(telemetry.getSpans())).not.toContain(
      'must never reach',
    );
  });

  it('does not process a trigger from another tenant or leak cross-project evidence', async () => {
    const { app, store, dispatcher } = await setup();
    const projectId = await createProject(app, 'scope');
    await drain(dispatcher);
    const foreignTenant = testId();
    const event = await appendEvent(store, {
      tenantId: foreignTenant,
      projectId,
      type: 'attempt.failed',
      payload: { code: 'COMFY_EXECUTION_FAILED' },
    });

    expect(await dispatcher.pollOnce()).toBe(true);
    expect(await recommendations(store, projectId)).toEqual([]);
    const runs = await store.withTransaction((repositories) =>
      repositories.agentRuns.listByProject(DEV_TENANT_ID, projectId),
    );
    expect(runs).toEqual([]);
    expect(
      (await internals(app).operationalPiAdapter.processEvent(event)).reason,
    ).toBe('out_of_scope');
  });

  it('normalizes an unsafe model action and requires the human API action', async () => {
    const { app, store, adapter } = await setup({
      output: {
        severity: 'critical',
        recommendationCode: 'MODEL_SUPPLIED_CODE',
        title: 'Unsafe retry proposal',
        detail: 'The model asked for a retry before executor readiness.',
        proposedActionType: 'retry_attempt',
      },
    });
    const projectId = await createProject(app, 'policy');
    const event = await appendEvent(store, {
      projectId,
      type: 'executor.unavailable',
    });
    const processed = await adapter.processEvent(event);
    const recommendation = processed.recommendation;
    if (!recommendation) throw new Error('Expected recommendation.');
    expect(recommendation.proposedActionType).toBe('wait_for_executor');
    expect(
      await store.withTransaction((repositories) =>
        repositories.attempts.listByProject(DEV_TENANT_ID, projectId),
      ),
    ).toEqual([]);

    const applied = await request(app, {
      method: 'POST',
      url: `/v1/projects/${projectId}/operator/recommendations/${recommendation.id}/apply`,
      headers: { 'idempotency-key': 'policy-apply' },
      payload: {
        expectedVersion: 1,
        actionType: 'retry_attempt',
        seed: 987654,
      },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().recommendation.status).toBe('applied');
    expect(applied.json().attempt).toBeUndefined();

    const dismissEvent = await appendEvent(store, {
      projectId,
      type: 'executor.unavailable',
    });
    const dismissResult = await adapter.processEvent(dismissEvent);
    const dismissRecommendation = dismissResult.recommendation;
    if (!dismissRecommendation)
      throw new Error('Expected dismiss recommendation.');
    const dismissed = await request(app, {
      method: 'POST',
      url: `/v1/projects/${projectId}/operator/recommendations/${dismissRecommendation.id}/dismiss`,
      headers: { 'idempotency-key': 'policy-dismiss' },
      payload: { expectedVersion: 1 },
    });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json().recommendation.status).toBe('dismissed');
  });

  it('recommends a retry for a failed attempt but spends budget only after human apply', async () => {
    const { app, store, dispatcher } = await setup();
    const { projectId, shotId } = await createApprovedShot(app, 'retry');
    const created = await request(app, {
      method: 'POST',
      url: `/v1/shots/${shotId}/attempts`,
      headers: { 'idempotency-key': 'retry-attempt' },
      payload: { scenario: 'execution-failure' },
    });
    expect(created.statusCode).toBe(201);
    const sourceAttemptId = created.json().attempt.id as Uuid;
    const worker = (
      app as unknown as {
        generationWorker: { processOnce(): Promise<boolean> };
      }
    ).generationWorker;
    expect(await worker.processOnce()).toBe(true);
    expect(
      (
        await request(app, {
          method: 'GET',
          url: `/v1/attempts/${sourceAttemptId}`,
        })
      ).json().attempt.status,
    ).toBe('failed');
    await drain(dispatcher);

    const recommendation = (await recommendations(store, projectId)).find(
      (candidate) => candidate.attemptId === sourceAttemptId,
    );
    if (!recommendation)
      throw new Error('Expected failed-attempt recommendation.');
    expect(recommendation.proposedActionType).toBe('retry_attempt');
    const staleApply = await request(app, {
      method: 'POST',
      url: `/v1/projects/${projectId}/operator/recommendations/${recommendation.id}/apply`,
      headers: { 'idempotency-key': 'retry-stale-apply' },
      payload: { expectedVersion: recommendation.version + 1 },
    });
    expect(staleApply.statusCode).toBe(409);
    expect(
      (
        await request(app, {
          method: 'GET',
          url: `/v1/projects/${projectId}/attempts`,
        })
      ).json().attempts,
    ).toHaveLength(1);

    const applied = await request(app, {
      method: 'POST',
      url: `/v1/projects/${projectId}/operator/recommendations/${recommendation.id}/apply`,
      headers: { 'idempotency-key': 'retry-recommendation-apply' },
      payload: { expectedVersion: recommendation.version },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().recommendation.status).toBe('applied');
    expect(applied.json().attempt.sourceAttemptId).toBe(sourceAttemptId);
    expect(
      (
        await request(app, {
          method: 'GET',
          url: `/v1/projects/${projectId}/attempts`,
        })
      ).json().attempts,
    ).toHaveLength(2);
  });
});
