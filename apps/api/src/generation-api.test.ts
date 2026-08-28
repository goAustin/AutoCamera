import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import { createInMemoryStore } from '@h3/db';
import {
  DeterministicFakeComfyService,
  FakeComfyClient,
} from '@h3/comfy-client';
import {
  DeterministicFixtureProcessRunner,
  MediaEvaluator,
} from '@h3/evaluator';
import { createLocalArtifactStore } from '@h3/object-store';
import { buildApiApp } from './app.js';
import type { GenerationWorker } from './generation.js';

const auth = { authorization: 'Bearer test-token' };
const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApiApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setupApi() {
  const root = await mkdtemp(join(tmpdir(), 'h3-api-generation-test-'));
  roots.push(root);
  const service = new DeterministicFakeComfyService();
  const app = buildApiApp({
    config: getApiConfig({ NODE_ENV: 'test', ARTIFACT_ROOT: root }),
    store: createInMemoryStore(),
    comfyClient: new FakeComfyClient(service),
    artifactStore: createLocalArtifactStore(root),
    evaluator: new MediaEvaluator(new DeterministicFixtureProcessRunner()),
  });
  apps.push(app);
  return {
    app,
    worker: (app as unknown as { generationWorker: GenerationWorker })
      .generationWorker,
  };
}

describe('Phase 3 generation API', () => {
  it('queues idempotently, exposes evaluation, and accepts a validated attempt', async () => {
    const { app, worker } = await setupApi();
    const projectResponse = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'project-1' },
      payload: {
        title: 'API fixture',
        brief: 'A small synthetic video.',
        targetDurationSeconds: 3,
        budgetUsd: '25.00',
      },
    });
    expect(projectResponse.statusCode).toBe(201);
    const projectId = projectResponse.json().project.id as string;

    const planResponse = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/plan`,
      headers: { ...auth, 'idempotency-key': 'plan-1' },
      payload: {},
    });
    expect(planResponse.statusCode).toBe(200);
    const proposalId = planResponse.json().proposal.id as string;
    const approvalResponse = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/storyboard/approve`,
      headers: { ...auth, 'idempotency-key': 'approve-1' },
      payload: { proposalId },
    });
    expect(approvalResponse.statusCode).toBe(200);
    const shotId = approvalResponse.json().shots[0].id as string;

    const create = await app.inject({
      method: 'POST',
      url: `/v1/shots/${shotId}/attempts`,
      headers: { ...auth, 'idempotency-key': 'attempt-1' },
      payload: { seed: 44, scenario: 'success' },
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/v1/shots/${shotId}/attempts`,
      headers: { ...auth, 'idempotency-key': 'attempt-1' },
      payload: { seed: 44, scenario: 'success' },
    });
    expect(create.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(create.json());
    const attemptId = create.json().attempt.id as string;

    const queued = await app.inject({
      method: 'GET',
      url: `/v1/shots/${shotId}/attempts`,
      headers: auth,
    });
    expect(queued.statusCode).toBe(200);
    expect(queued.json().attempts).toHaveLength(1);

    expect(await worker.processOnce()).toBe(true);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/attempts/${attemptId}`,
      headers: auth,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().attempt.status).toBe('awaiting_review');
    expect(detail.json().evaluation.status).toBe('passed');

    const accepted = await app.inject({
      method: 'POST',
      url: `/v1/attempts/${attemptId}/accept`,
      headers: { ...auth, 'idempotency-key': 'accept-1' },
      payload: {},
    });
    const acceptedReplay = await app.inject({
      method: 'POST',
      url: `/v1/attempts/${attemptId}/accept`,
      headers: { ...auth, 'idempotency-key': 'accept-1' },
      payload: {},
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().attempt.status).toBe('accepted');
    expect(acceptedReplay.json()).toEqual(accepted.json());
  });

  it('rejects and regenerates through the review routes with a derivation link', async () => {
    const { app, worker } = await setupApi();
    const project = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'project-reject' },
      payload: {
        title: 'Reject fixture',
        brief: 'A synthetic rejection flow.',
        targetDurationSeconds: 3,
      },
    });
    const projectId = project.json().project.id as string;
    const plan = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/plan`,
      headers: { ...auth, 'idempotency-key': 'plan-reject' },
      payload: {},
    });
    const approve = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/storyboard/approve`,
      headers: { ...auth, 'idempotency-key': 'approve-reject' },
      payload: { proposalId: plan.json().proposal.id },
    });
    const shotId = approve.json().shots[1].id as string;
    const create = await app.inject({
      method: 'POST',
      url: `/v1/shots/${shotId}/attempts`,
      headers: { ...auth, 'idempotency-key': 'attempt-reject' },
      payload: {},
    });
    const attemptId = create.json().attempt.id as string;
    await worker.processOnce();
    const rejected = await app.inject({
      method: 'POST',
      url: `/v1/attempts/${attemptId}/reject`,
      headers: { ...auth, 'idempotency-key': 'reject-1' },
      payload: { reasonCode: 'too_dark' },
    });
    expect(rejected.statusCode).toBe(200);
    const regenerated = await app.inject({
      method: 'POST',
      url: `/v1/attempts/${attemptId}/regenerate`,
      headers: { ...auth, 'idempotency-key': 'regenerate-1' },
      payload: { seed: 99 },
    });
    expect(regenerated.statusCode).toBe(201);
    expect(regenerated.json().attempt.sourceAttemptId).toBe(attemptId);
    expect(regenerated.json().attempt.seed).toBe(99);
  });

  it('returns problem details for missing authentication and invalid shot IDs', async () => {
    const { app } = await setupApi();
    const unauthorized = await app.inject({
      method: 'GET',
      url: '/v1/projects',
    });
    expect(unauthorized.statusCode).toBe(401);
    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/shots/not-a-uuid/attempts',
      headers: auth,
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().code).toBe('INVALID_REQUEST');
  });
});
