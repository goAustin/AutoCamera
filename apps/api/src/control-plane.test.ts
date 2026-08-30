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
import {
  MINIMAX_H3_PROFILE_ID,
  MINIMAX_H3_PROFILE_VERSION,
  loadMinimaxH3Fixtures,
} from '@h3/workflow-compiler';
import { DEV_TENANT_ID, StaticStoryboardPlanner } from './application.js';
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
    planner: new StaticStoryboardPlanner(),
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
  const plan = await request(app, {
    method: 'POST',
    url: `/v1/projects/${projectId}/plan`,
    headers: { 'idempotency-key': `${prefix}-plan` },
    payload: {},
  });
  expect(plan.statusCode).toBe(200);
  const approve = await request(app, {
    method: 'POST',
    url: `/v1/projects/${projectId}/storyboard/approve`,
    headers: { 'idempotency-key': `${prefix}-approve` },
    payload: { proposalId: plan.json().proposal.id },
  });
  expect(approve.statusCode).toBe(200);
  return { projectId, shotId: approve.json().shots[0].id as string };
}

describe('Phase 5 control-plane APIs', () => {
  it('creates scoped drafts and immutable validated revisions, then queues exact managed data', async () => {
    const { app, worker, comfy } = await setupApi();
    const { projectId, shotId } = await createApprovedShot(app, 'managed');
    const fixtures = await loadMinimaxH3Fixtures();

    const draft = await request(app, {
      method: 'PUT',
      url: `/v1/projects/${projectId}/shots/${shotId}/workflow-draft`,
      headers: { 'idempotency-key': 'managed-draft-1' },
      payload: {
        editorGraph: fixtures.editorGraph,
        lastApiGraph: fixtures.apiGraph,
      },
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().draft.version).toBe(1);

    const draftReplay = await request(app, {
      method: 'PUT',
      url: `/v1/projects/${projectId}/shots/${shotId}/workflow-draft`,
      headers: { 'idempotency-key': 'managed-draft-1' },
      payload: {
        editorGraph: fixtures.editorGraph,
        lastApiGraph: fixtures.apiGraph,
      },
    });
    expect(draftReplay.statusCode).toBe(200);
    expect(draftReplay.json()).toEqual(draft.json());

    const draftUpdate = await request(app, {
      method: 'PUT',
      url: `/v1/projects/${projectId}/shots/${shotId}/workflow-draft`,
      headers: { 'idempotency-key': 'managed-draft-2' },
      payload: {
        editorGraph: fixtures.editorGraph,
        lastApiGraph: fixtures.apiGraph,
        expectedVersion: 1,
      },
    });
    expect(draftUpdate.statusCode).toBe(200);
    expect(draftUpdate.json().draft.version).toBe(2);

    const staleDraft = await request(app, {
      method: 'PUT',
      url: `/v1/projects/${projectId}/shots/${shotId}/workflow-draft`,
      headers: { 'idempotency-key': 'managed-draft-stale' },
      payload: {
        editorGraph: fixtures.editorGraph,
        expectedVersion: 1,
      },
    });
    expect(staleDraft.statusCode).toBe(409);

    const revision = await request(app, {
      method: 'POST',
      url: `/v1/projects/${projectId}/shots/${shotId}/workflow-revisions`,
      headers: { 'idempotency-key': 'managed-revision-1' },
      payload: {
        editorGraph: fixtures.editorGraph,
        apiGraph: fixtures.apiGraph,
        profileId: MINIMAX_H3_PROFILE_ID,
        profileVersion: MINIMAX_H3_PROFILE_VERSION,
        source: 'comfy_editor',
        frontendVersion: 'bridge-test',
        frontendCommit: 'bridge-test-commit',
      },
    });
    expect(revision.statusCode).toBe(201);
    expect(revision.json().validation.valid).toBe(true);
    expect(revision.json().revision.validationStatus).toBe('validated');
    expect(revision.json().revision.frontendVersion).toBe('bridge-test');
    expect(revision.json().revision.frontendCommit).toBe('bridge-test-commit');
    const revisionId = revision.json().revision.id as string;

    const listed = await request(app, {
      method: 'GET',
      url: `/v1/projects/${projectId}/shots/${shotId}/workflow-revisions`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().revisions[0].id).toBe(revisionId);
    const global = await request(app, {
      method: 'GET',
      url: `/v1/workflow-revisions/${revisionId}`,
    });
    expect(global.statusCode).toBe(200);

    const revalidated = await request(app, {
      method: 'POST',
      url: `/v1/workflow-revisions/${revisionId}/validate`,
      headers: { 'idempotency-key': 'managed-revision-validate' },
      payload: {},
    });
    expect(revalidated.statusCode).toBe(200);
    expect(revalidated.json().validation.valid).toBe(true);

    const override = await request(app, {
      method: 'POST',
      url: `/v1/projects/${projectId}/shots/${shotId}/managed-attempts`,
      headers: { 'idempotency-key': 'managed-override' },
      payload: { workflowRevisionId: revisionId, seed: 999 },
    });
    expect(override.statusCode).toBeGreaterThanOrEqual(400);
    expect(override.statusCode).toBeLessThan(500);

    const managed = await request(app, {
      method: 'POST',
      url: `/v1/projects/${projectId}/shots/${shotId}/managed-attempts`,
      headers: { 'idempotency-key': 'managed-attempt-1' },
      payload: { workflowRevisionId: revisionId },
    });
    expect(managed.statusCode).toBe(201);
    const attempt = managed.json().attempt as {
      id: string;
      workflowRevisionId: string;
      seed: number;
      steps: number;
      requestedWidth: number;
      requestedHeight: number;
      requestedDurationSeconds: number;
      scenario?: string;
    };
    expect(attempt.workflowRevisionId).toBe(revisionId);
    expect(attempt.scenario).toBeUndefined();
    expect(attempt.seed).toBe(
      revision.json().revision.executionParameters.seed,
    );
    expect(attempt.steps).toBe(
      revision.json().revision.executionParameters.steps,
    );

    const replay = await request(app, {
      method: 'POST',
      url: `/v1/projects/${projectId}/shots/${shotId}/managed-attempts`,
      headers: { 'idempotency-key': 'managed-attempt-1' },
      payload: { workflowRevisionId: revisionId },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(managed.json());
    const attempts = await request(app, {
      method: 'GET',
      url: `/v1/projects/${projectId}/attempts`,
    });
    expect(attempts.json().attempts).toHaveLength(1);

    expect(await worker.processOnce()).toBe(true);
    const detail = await request(app, {
      method: 'GET',
      url: `/v1/attempts/${attempt.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().attempt.status).toBe('awaiting_review');
    const history = Object.values(comfy.histories())[0];
    expect(history).toBeDefined();
    const saveVideo = Object.values(history?.workflow ?? {}).find(
      (node) =>
        typeof node === 'object' &&
        node !== null &&
        !Array.isArray(node) &&
        (node as { class_type?: unknown }).class_type === 'SaveVideo',
    ) as { inputs?: { filename_prefix?: string } } | undefined;
    expect(saveVideo?.inputs?.filename_prefix).toContain(attempt.id);
    expect(history?.extraData.scenario).toBeUndefined();
  });

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
