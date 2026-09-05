import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import {
  createDomainEvent,
  createUuidV7,
  type IdGenerator,
  type Uuid,
} from '@h3/domain';
import {
  DeterministicFakeComfyService,
  FakeComfyClient,
} from '@h3/comfy-client';
import {
  createInMemoryStore,
  type OperationalRecommendationRecord,
} from '@h3/db';
import {
  DeterministicFixtureProcessRunner,
  MediaEvaluator,
} from '@h3/evaluator';
import { createLocalArtifactStore } from '@h3/object-store';
import { DEV_TENANT_ID } from './application.js';
import { buildApiApp } from './app.js';
import type { GenerationWorker } from './generation.js';

const auth = { authorization: 'Bearer test-token' };
const apps: Array<Awaited<ReturnType<typeof buildApiApp>>> = [];
const roots: string[] = [];
let idSequence = 1;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function testId(): Uuid {
  const sequence = idSequence++;
  return createUuidV7(
    1_700_000_000_000 + sequence,
    new Uint8Array(10).fill((sequence % 250) + 1),
  );
}

function testIds(): IdGenerator {
  return { next: testId };
}

async function setupApi() {
  const root = await mkdtemp(join(tmpdir(), 'h3-control-plane-test-'));
  roots.push(root);
  const comfy = new DeterministicFakeComfyService();
  const store = createInMemoryStore();
  const artifactStore = createLocalArtifactStore(root);
  const app = buildApiApp({
    config: getApiConfig({
      NODE_ENV: 'test',
      DEV_AUTH_TOKEN: 'test-token',
      ARTIFACT_ROOT: root,
    }),
    store,
    idGenerator: testIds(),
    comfyClient: new FakeComfyClient(comfy),
    artifactStore,
    evaluator: new MediaEvaluator(new DeterministicFixtureProcessRunner()),
  });
  apps.push(app);
  return {
    app,
    store,
    comfy,
    artifactStore,
    worker: (app as unknown as { generationWorker: GenerationWorker })
      .generationWorker,
  };
}

async function request(
  app: Awaited<ReturnType<typeof buildApiApp>>,
  options: InjectOptions,
) {
  return app.inject({ ...options, headers: { ...auth, ...options.headers } });
}

/**
 * Phase 7D removed storyboard planning: `POST /v1/projects/:projectId/plan`
 * and `.../storyboard/approve` no longer exist, and shots are never listed
 * or otherwise addressable from outside. The durable core still requires an
 * `approved_for_generation` shot to accept a scenario-scoped attempt
 * (`generation.ts`'s `createAttemptInTransaction`), so this seeds one the
 * same way a real client now would: submit `POST /v1/runs` with a graph that
 * fails validation. That creates the project's implicit shot and records a
 * `shot.created` domain event before ever reaching attempt creation, so the
 * shot survives, untouched, in `approved_for_generation` -- reusing exactly
 * the "invalid graph creates no attempt" invariant the deleted planner UI's
 * replacement test also exercises. `GET .../events` is the only remaining
 * way to recover the shot's id.
 */
async function createApprovedShot(
  app: Awaited<ReturnType<typeof buildApiApp>>,
  prefix: string,
): Promise<{ projectId: string; shotId: string }> {
  const project = await request(app, {
    method: 'POST',
    url: '/v1/projects',
    headers: { 'idempotency-key': `${prefix}-project` },
    payload: {
      title: `${prefix} project`,
      brief: 'A control-plane API fixture.',
      targetDurationSeconds: 3,
    },
  });
  expect(project.statusCode).toBe(201);
  const projectId = project.json().project.id as string;
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
  expect(events.statusCode).toBe(200);
  const shotCreated = (
    events.json().events as ReadonlyArray<Record<string, unknown>>
  ).find((event) => event.type === 'shot.created');
  const shotId = shotCreated?.shotId as string | undefined;
  if (!shotId) throw new Error('Expected a shot.created event with a shotId.');
  return { projectId, shotId };
}

describe('Phase 5 control-plane APIs', () => {
  it('replays sanitized SSE events and serves authenticated ranged artifacts', async () => {
    const { app, store, worker, artifactStore } = await setupApi();
    const { projectId, shotId } = await createApprovedShot(app, 'stream');
    const create = await request(app, {
      method: 'POST',
      url: `/v1/shots/${shotId}/attempts`,
      headers: { 'idempotency-key': 'stream-attempt' },
      payload: {},
    });
    const attemptId = create.json().attempt.id as string;
    await worker.processOnce();
    const detail = await request(app, {
      method: 'GET',
      url: `/v1/attempts/${attemptId}`,
    });
    const artifactId = detail.json().attempt.artifactId as string;
    const events = await request(app, {
      method: 'GET',
      url: `/v1/projects/${projectId}/events`,
    });
    const previousSequence = Number(events.json().events.at(-1).eventSequence);

    await store.withTransaction(async (repositories) => {
      await repositories.events.append(
        createDomainEvent({
          id: testId(),
          type: 'attempt.execution_progress',
          producer: 'control-plane-test',
          tenantId: DEV_TENANT_ID,
          projectId: projectId as Uuid,
          shotId: shotId as Uuid,
          attemptId: attemptId as Uuid,
          promptId: 'private-comfy-prompt-handle',
          payload: {
            status: 'running',
            value: 50,
            max: 100,
            privateSecret: 'must-not-be-streamed',
          },
          clock: { now: () => new Date() },
        }),
      );
    });

    const stream = await request(app, {
      method: 'GET',
      url: `/v1/projects/${projectId}/events/stream`,
      headers: { 'last-event-id': String(previousSequence) },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain('event: attempt.execution_progress');
    expect(stream.body).toContain(': heartbeat');
    expect(stream.body).not.toContain('must-not-be-streamed');
    expect(stream.body).not.toContain('private-comfy-prompt-handle');

    const range = await request(app, {
      method: 'GET',
      url: `/v1/artifacts/${artifactId}/content`,
      headers: { range: 'bytes=0-3' },
    });
    expect(range.statusCode).toBe(206);
    expect(range.headers['accept-ranges']).toBe('bytes');
    expect(range.headers['content-range']).toMatch(/^bytes 0-3\//);
    const artifactBytes = await artifactStore.read(artifactId);
    expect(range.body).toBe(
      Buffer.from(artifactBytes.subarray(0, 4)).toString(),
    );
    expect(range.headers['x-content-type-options']).toBe('nosniff');
    expect(range.body).not.toContain('objects/');

    const head = await request(app, {
      method: 'HEAD',
      url: `/v1/artifacts/${artifactId}/content`,
    });
    expect(head.statusCode).toBe(200);
    expect(Number(head.headers['content-length'])).toBeGreaterThan(4);
    expect(head.body).toBe('');

    const invalidRange = await request(app, {
      method: 'GET',
      url: `/v1/artifacts/${artifactId}/content`,
      headers: { range: 'bytes=999999-' },
    });
    expect(invalidRange.statusCode).toBe(416);
    expect(invalidRange.headers['content-range']).toMatch(/^bytes \*\//);

    const unauthorized = await app.inject({
      method: 'GET',
      url: `/v1/artifacts/${artifactId}/content`,
    });
    expect(unauthorized.statusCode).toBe(401);
  });

  it('recovers expired worker state and applies recommendations idempotently', async () => {
    const { app, store, comfy, worker } = await setupApi();
    const { projectId, shotId } = await createApprovedShot(app, 'recovery');
    const create = await request(app, {
      method: 'POST',
      url: `/v1/shots/${shotId}/attempts`,
      headers: { 'idempotency-key': 'recovery-attempt' },
      payload: { scenario: 'execution-failure' },
    });
    const attemptId = create.json().attempt.id as Uuid;
    await store.withTransaction(async (repositories) => {
      const attempt = await repositories.attempts.findById(
        DEV_TENANT_ID,
        attemptId,
      );
      if (!attempt) throw new Error('expected recovery attempt');
      const claimed = {
        ...attempt,
        status: 'claimed' as const,
        leaseOwner: 'crashed-worker',
        leaseExpiresAt: '2025-01-01T00:00:00.000Z' as never,
        version: attempt.version + 1,
        updatedAt: '2025-01-01T00:00:00.000Z' as never,
      };
      await repositories.attempts.update(claimed, attempt.version);
    });
    expect(await worker.processOnce()).toBe(true);
    expect(comfy.submissionCount(`h3-${attemptId}`)).toBe(1);

    const failed = await request(app, {
      method: 'GET',
      url: `/v1/attempts/${attemptId}`,
    });
    expect(failed.json().attempt.status).toBe('failed');
    const event = (
      await store.withTransaction((repositories) =>
        repositories.events.listByProject(projectId as Uuid),
      )
    ).find((candidate) => candidate.attemptId === attemptId);
    if (!event) throw new Error('expected attempt event');
    const recommendation: OperationalRecommendationRecord = {
      id: testId(),
      tenantId: DEV_TENANT_ID,
      projectId: projectId as Uuid,
      shotId: shotId as Uuid,
      attemptId,
      triggerEventId: event.id,
      severity: 'warning',
      recommendationCode: 'RETRY_FAILED_PREVIEW',
      title: 'Retry failed preview',
      detail: 'The preview can be retried after the failed executor run.',
      evidenceReferencesJson: [{ type: 'attempt', resourceId: attemptId }],
      proposedActionType: 'retry_attempt',
      proposedResourceIdsJson: [attemptId],
      status: 'pending',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await store.withTransaction((repositories) =>
      repositories.recommendations.create(recommendation),
    );

    const listed = await request(app, {
      method: 'GET',
      url: `/v1/projects/${projectId}/operator/recommendations`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().recommendations[0].id).toBe(recommendation.id);
    const applied = await request(app, {
      method: 'POST',
      url: `/v1/projects/${projectId}/operator/recommendations/${recommendation.id}/apply`,
      headers: { 'idempotency-key': 'recommendation-apply' },
      payload: {
        expectedVersion: 1,
        actionType: 'no_action',
        seed: 123456,
      },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().recommendation.status).toBe('applied');
    expect(applied.json().attempt.sourceAttemptId).toBe(attemptId);
    const appliedReplay = await request(app, {
      method: 'POST',
      url: `/v1/projects/${projectId}/operator/recommendations/${recommendation.id}/apply`,
      headers: { 'idempotency-key': 'recommendation-apply' },
      payload: {
        expectedVersion: 1,
        actionType: 'no_action',
        seed: 123456,
      },
    });
    expect(appliedReplay.statusCode).toBe(200);
    expect(appliedReplay.json()).toEqual(applied.json());
    const allAttempts = await request(app, {
      method: 'GET',
      url: `/v1/projects/${projectId}/attempts`,
    });
    expect(allAttempts.json().attempts).toHaveLength(2);
  });
});
