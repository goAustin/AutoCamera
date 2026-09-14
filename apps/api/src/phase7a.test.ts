import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import {
  createInMemoryStore,
  type AgentRunRecord,
  type TransactionalStore,
} from '@h3/db';
import {
  DeterministicFakeComfyService,
  FakeComfyClient,
} from '@h3/comfy-client';
import { assertUuid, createUuidV7 } from '@h3/domain';
import {
  hashWorkflowExecutionEnvelope,
  loadMinimaxH3Fixtures,
} from '@h3/workflow-compiler';
import { buildApiApp } from './app.js';
import { DEV_TENANT_ID } from './application.js';
import { DEFAULT_ESTIMATED_ATTEMPT_COST } from './generation.js';

const apps = new Set<Awaited<ReturnType<typeof buildApiApp>>>();

let fixtures: Awaited<ReturnType<typeof loadMinimaxH3Fixtures>>;

beforeAll(async () => {
  fixtures = await loadMinimaxH3Fixtures();
});

function authHeaders(key?: string): Record<string, string> {
  return {
    authorization: 'Bearer test-secret',
    ...(key ? { 'idempotency-key': key } : {}),
  };
}

function createApp(): {
  readonly app: Awaited<ReturnType<typeof buildApiApp>>;
  readonly store: TransactionalStore;
  readonly comfy: DeterministicFakeComfyService;
} {
  const store = createInMemoryStore();
  const comfy = new DeterministicFakeComfyService();
  const app = buildApiApp({
    config: getApiConfig({ NODE_ENV: 'test', DEV_AUTH_TOKEN: 'test-secret' }),
    store,
    comfyClient: new FakeComfyClient(comfy),
  });
  apps.add(app);
  return { app, store, comfy };
}

async function submitRun(
  app: Awaited<ReturnType<typeof buildApiApp>>,
  key: string,
  overrides: Record<string, unknown> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/v1/runs',
    headers: authHeaders(),
    payload: {
      editorGraph: fixtures.editorGraph,
      apiGraph: fixtures.apiGraph,
      idempotencyKey: key,
      ...overrides,
    },
  });
}

afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  apps.clear();
});

describe('Phase 7A thin-core runs', () => {
  it('creates one durable queued run with an implicit shot and server-side audit anchors', async () => {
    const { app, store } = createApp();
    const response = await submitRun(app, 'phase7a-create');

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ status: 'queued' });
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.revisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.executionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.validation).toMatchObject({ status: 'validated', errors: [] });

    const run = await app.inject({
      method: 'GET',
      url: `/v1/runs/${body.runId}`,
      headers: authHeaders(),
    });
    expect(run.statusCode).toBe(200);
    const runBody = run.json();
    expect(runBody).toMatchObject({
      runId: body.runId,
      projectId: body.projectId,
      revisionId: body.revisionId,
      status: 'queued',
      pinned: false,
      evaluationStatus: 'not-run',
      project: { autoCreated: true, budgetMicrousd: null },
      cost: {
        projectBudgetMicrousd: null,
        projectBudgetUsd: null,
        projectRemainingMicrousd: null,
        projectRemainingUsd: null,
      },
    });
    expect(runBody.attempt).not.toHaveProperty('shotId');
    expect(runBody.revision).not.toHaveProperty('shotId');
    expect(runBody.revision.executorFingerprint).toEqual(
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
    expect(runBody.events.map((event: { type: string }) => event.type)).toEqual(
      expect.arrayContaining([
        'project.created',
        'shot.created',
        'run.created',
      ]),
    );

    const persisted = await store.withTransaction(async (repositories) => {
      const project = await repositories.projects.findById(
        DEV_TENANT_ID,
        body.projectId,
      );
      const shots = await repositories.shots.listByProject(body.projectId);
      const implicitShot = shots[0];
      if (!implicitShot) throw new Error('Expected an implicit shot.');
      const revisions = await repositories.workflowRevisions.listByShot(
        DEV_TENANT_ID,
        body.projectId,
        implicitShot.id,
      );
      return { project, shots, revisions };
    });
    expect(persisted.project).toMatchObject({
      id: body.projectId,
      autoCreated: true,
      budgetMicrousd: null,
    });
    expect(persisted.shots).toHaveLength(1);
    expect(persisted.shots[0]).toMatchObject({
      implicit: true,
      status: 'queued',
    });
    expect(persisted.revisions).toHaveLength(1);
  });

  it('computes the execution hash and capability fingerprint on the server', async () => {
    const { app } = createApp();
    const wrongHash = '0'.repeat(64);
    const response = await submitRun(app, 'phase7a-audit', {
      executionHash: wrongHash,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.executionHash).not.toBe(wrongHash);
    const run = await app.inject({
      method: 'GET',
      url: `/v1/runs/${body.runId}`,
      headers: authHeaders(),
    });
    const revision = run.json().revision;
    expect(revision.executionHash).toBe(
      hashWorkflowExecutionEnvelope({
        profileId: revision.profileId,
        profileVersion: revision.profileVersion,
        apiGraph: revision.apiGraph,
        parameters: revision.executionParameters,
      }),
    );
    expect(revision.executorFingerprint).toEqual(expect.any(String));
  });

  it('persists an invalid revision while returning 422 and creates no attempt', async () => {
    const { app, store } = createApp();
    const invalidApiGraph = {
      '1': { class_type: 'NotARealNode', inputs: {} },
    };
    const response = await submitRun(app, 'phase7a-invalid', {
      apiGraph: invalidApiGraph,
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.runId).toBeNull();
    expect(body.validation.status).toBe('invalid');
    expect(body.validation.errors.length).toBeGreaterThan(0);

    const persisted = await store.withTransaction(async (repositories) => {
      const projects = await repositories.projects.listByTenant(DEV_TENANT_ID);
      const shots = await repositories.shots.listByProject(body.projectId);
      const revisions = shots[0]
        ? await repositories.workflowRevisions.listByShot(
            DEV_TENANT_ID,
            body.projectId,
            shots[0].id,
          )
        : [];
      const attempts = await repositories.attempts.listByProject(
        DEV_TENANT_ID,
        body.projectId,
      );
      return { projects, shots, revisions, attempts };
    });
    expect(persisted.projects).toHaveLength(1);
    expect(persisted.revisions).toHaveLength(1);
    expect(persisted.revisions[0]?.validationStatus).toBe('invalid');
    expect(persisted.attempts).toHaveLength(0);
  });

  it('replays a run idempotently without creating another attempt', async () => {
    const { app, store } = createApp();
    const first = await submitRun(app, 'phase7a-replay');
    const replay = await submitRun(app, 'phase7a-replay');

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const attempts = await store.withTransaction((repositories) =>
      repositories.attempts.listByProject(
        DEV_TENANT_ID,
        first.json().projectId,
      ),
    );
    expect(attempts).toHaveLength(1);
  });

  it('accepts an existing project as a grouping label without requiring storyboard approval', async () => {
    const { app, store } = createApp();
    const projectResponse = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('phase7a-existing-project'),
      payload: {
        title: 'Existing grouping project',
        brief: 'A direct workflow grouping.',
        targetDurationSeconds: 3,
      },
    });
    expect(projectResponse.statusCode).toBe(201);
    const projectId = assertUuid(projectResponse.json().project.id as string);

    const response = await submitRun(app, 'phase7a-existing-run', {
      projectId,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().projectId).toBe(projectId);

    const project = await store.withTransaction((repositories) =>
      repositories.projects.findById(DEV_TENANT_ID, projectId),
    );
    expect(project).toMatchObject({ status: 'generating', id: projectId });
  });

  it('treats a null budget as no enforcement and records explicit budget denial', async () => {
    const { app, store } = createApp();
    const unbudgeted = await submitRun(app, 'phase7a-no-budget');
    expect(unbudgeted.statusCode).toBe(201);
    const unbudgetedEvents = await store.withTransaction((repositories) =>
      repositories.events.listByProject(unbudgeted.json().projectId),
    );
    expect(unbudgetedEvents.map((event) => event.type)).not.toContain(
      'project.budget_denied',
    );

    const projectResponse = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('phase7a-budget-project'),
      payload: {
        title: 'Budgeted grouping project',
        brief: 'An explicit budget should remain enforced.',
        targetDurationSeconds: 3,
        budgetMicrousd: 0,
      },
    });
    expect(projectResponse.statusCode).toBe(201);
    const projectId = assertUuid(projectResponse.json().project.id as string);

    const denied = await submitRun(app, 'phase7a-budget-denied', {
      projectId,
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ code: 'BUDGET_EXCEEDED' });

    const events = await store.withTransaction((repositories) =>
      repositories.events.listByProject(projectId),
    );
    expect(events.map((event) => event.type)).toContain(
      'project.budget_denied',
    );
  });

  it('admits an attempt against a project whose monitoring cost dwarfs its budget', async () => {
    const { app, store } = createApp();
    const projectResponse = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('phase7a-inference-not-budget'),
      payload: {
        title: 'Heavily monitored project',
        brief: 'Monitoring spend must never deny generation.',
        targetDurationSeconds: 3,
        // Exactly one attempt's worth of budget, so a breaker that summed
        // inference into `nextSpend` would deny over a single microusd.
        budgetMicrousd: DEFAULT_ESTIMATED_ATTEMPT_COST,
      },
    });
    expect(projectResponse.statusCode).toBe(201);
    const projectId = assertUuid(projectResponse.json().project.id as string);

    // Five times the whole budget, spent on watching the project rather than
    // on generating anything.
    const inferenceCostMicrousd = DEFAULT_ESTIMATED_ATTEMPT_COST * 5;
    const startedAt = new Date().toISOString();
    await store.withTransaction((repositories) =>
      repositories.agentRuns.create({
        id: createUuidV7(),
        tenantId: DEV_TENANT_ID,
        projectId,
        runId: 'phase7a-operator-run',
        sessionId: 'session-phase7a-operator-run',
        objective:
          'Recommend a bounded operational action from durable evidence.',
        provider: 'faux',
        model: 'faux-model',
        status: 'succeeded',
        toolCalls: 1,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        providerCostMicrousd: inferenceCostMicrousd,
        startedAt,
        version: 1,
        updatedAt: startedAt,
      } satisfies AgentRunRecord),
    );

    const admitted = await submitRun(app, 'phase7a-inference-admitted', {
      projectId,
    });
    expect(admitted.statusCode).toBe(201);

    const events = await store.withTransaction((repositories) =>
      repositories.events.listByProject(projectId),
    );
    expect(events.map((event) => event.type)).not.toContain(
      'project.budget_denied',
    );

    // The attempt moved attempt spend and nothing else: the two figures stay
    // distinct after a real generation, not only on a freshly created project.
    const cost = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/cost`,
      headers: authHeaders(),
    });
    expect(cost.statusCode).toBe(200);
    expect(cost.json()).toMatchObject({
      budgetMicrousd: DEFAULT_ESTIMATED_ATTEMPT_COST,
      spentMicrousd: DEFAULT_ESTIMATED_ATTEMPT_COST,
      remainingMicrousd: 0,
      inferenceCostMicrousd,
    });
  });

  it('pins failed and running records, reviews without lifecycle transitions, and unpins reversibly', async () => {
    const { app, store } = createApp();
    const first = await submitRun(app, 'phase7a-pin-failed');
    const second = await submitRun(app, 'phase7a-pin-running');
    const firstRunId = assertUuid(first.json().runId as string);
    const secondRunId = assertUuid(second.json().runId as string);

    await store.withTransaction(async (repositories) => {
      const firstAttempt = await repositories.attempts.findById(
        DEV_TENANT_ID,
        firstRunId,
      );
      const secondAttempt = await repositories.attempts.findById(
        DEV_TENANT_ID,
        secondRunId,
      );
      if (!firstAttempt || !secondAttempt) {
        throw new Error('Expected both run attempts.');
      }
      await repositories.attempts.update(
        {
          ...firstAttempt,
          status: 'failed',
          version: firstAttempt.version + 1,
        },
        firstAttempt.version,
      );
      await repositories.attempts.update(
        {
          ...secondAttempt,
          status: 'running',
          version: secondAttempt.version + 1,
        },
        secondAttempt.version,
      );
    });

    const failedPin = await app.inject({
      method: 'POST',
      url: `/v1/runs/${firstRunId}/pin`,
      headers: authHeaders('phase7a-pin-failed-mutation'),
      payload: {},
    });
    expect(failedPin.statusCode).toBe(200);
    expect(failedPin.json()).toMatchObject({
      runId: firstRunId,
      pinned: true,
      evaluationStatus: 'not-run',
    });

    const review = await app.inject({
      method: 'POST',
      url: `/v1/runs/${secondRunId}/review`,
      headers: {
        ...authHeaders('phase7a-review'),
        'x-operator-id': 'operator-1',
      },
      payload: { decision: 'accepted', note: 'Keep this candidate.' },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({
      runId: secondRunId,
      status: 'running',
      review: {
        decision: 'accepted',
        note: 'Keep this candidate.',
        author: 'operator-1',
      },
    });

    const unpin = await app.inject({
      method: 'DELETE',
      url: `/v1/runs/${firstRunId}/pin`,
      headers: authHeaders('phase7a-unpin'),
    });
    expect(unpin.statusCode).toBe(200);
    expect(unpin.json()).toMatchObject({ runId: firstRunId, pinned: false });
  });

  it('filters unreviewed runs and keeps domain events append-only', async () => {
    const { app, store } = createApp();
    const first = await submitRun(app, 'phase7a-filter-reviewed');
    const second = await submitRun(app, 'phase7a-filter-unreviewed');
    const firstBody = first.json();

    const before = await store.withTransaction((repositories) =>
      repositories.events.listByProject(firstBody.projectId),
    );

    await app.inject({
      method: 'POST',
      url: `/v1/runs/${firstBody.runId}/review`,
      headers: authHeaders('phase7a-filter-review'),
      payload: { decision: 'rejected' },
    });

    const unreviewed = await app.inject({
      method: 'GET',
      url: '/v1/runs?reviewed=false',
      headers: authHeaders(),
    });
    expect(unreviewed.statusCode).toBe(200);
    expect(
      unreviewed.json().runs.map((run: { runId: string }) => run.runId),
    ).toEqual([second.json().runId]);

    const page = await app.inject({
      method: 'GET',
      url: '/v1/runs?limit=1',
      headers: authHeaders(),
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().runs).toHaveLength(1);
    expect(page.json().nextSince).toEqual(expect.any(String));
    const nextPage = await app.inject({
      method: 'GET',
      url: `/v1/runs?since=${page.json().nextSince}&limit=1`,
      headers: authHeaders(),
    });
    expect(nextPage.statusCode).toBe(200);
    expect(nextPage.json().runs).toHaveLength(1);
    expect(nextPage.json().runs[0].runId).not.toBe(page.json().runs[0].runId);

    const after = await store.withTransaction((repositories) =>
      repositories.events.listByProject(firstBody.projectId),
    );
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map((event) => event.type)).toContain('run.reviewed');
  });
});

describe('graph-first runs are not capped by the storyboard shot count', () => {
  it('accepts more than three runs grouped under one project', async () => {
    const { app } = createApp();
    const first = await submitRun(app, 'grouped-run-1');
    expect(first.statusCode).toBe(201);
    const projectId = first.json().projectId as string;

    // The three-shot limit belongs to storyboard proposals. A project used to
    // group direct submissions must keep accepting runs past the third.
    for (const index of [2, 3, 4, 5]) {
      const response = await submitRun(app, `grouped-run-${index}`, {
        projectId,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().projectId).toBe(projectId);
    }

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/runs?projectId=${projectId}&limit=100`,
      headers: authHeaders(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().runs).toHaveLength(5);
  });

  it('paginates a project with more runs than the page limit', async () => {
    const { app } = createApp();
    const first = await submitRun(app, 'paged-run-1');
    const projectId = first.json().projectId as string;
    for (const index of [2, 3, 4]) {
      await submitRun(app, `paged-run-${index}`, { projectId });
    }

    const page = await app.inject({
      method: 'GET',
      url: '/v1/runs?limit=2',
      headers: authHeaders(),
    });
    expect(page.statusCode).toBe(200);
    const pageBody = page.json();
    expect(pageBody.runs).toHaveLength(2);
    expect(pageBody.nextSince).toBeDefined();

    const next = await app.inject({
      method: 'GET',
      url: `/v1/runs?limit=2&since=${pageBody.nextSince}`,
      headers: authHeaders(),
    });
    expect(next.statusCode).toBe(200);
    const nextIds = next.json().runs.map((run: { runId: string }) => run.runId);
    const firstIds = pageBody.runs.map((run: { runId: string }) => run.runId);
    expect(nextIds).toHaveLength(2);
    expect(nextIds.some((id: string) => firstIds.includes(id))).toBe(false);
  });
});

describe('pinning is an annotation, not an acceptance', () => {
  async function shotOf(store: TransactionalStore, projectId: string) {
    return store.withTransaction(async (repositories) => {
      const shots = await repositories.shots.listByProject(
        assertUuid(projectId),
      );
      return shots[0];
    });
  }

  it('bumps the shot version on pin and unpin', async () => {
    const { app, store } = createApp();
    const created = await submitRun(app, 'version-run');
    const body = created.json();
    const before = await shotOf(store, body.projectId);

    await app.inject({
      method: 'POST',
      url: `/v1/runs/${body.runId}/pin`,
      headers: authHeaders('pin-op-1'),
    });
    const pinned = await shotOf(store, body.projectId);
    // A write that leaves the version unchanged writes version = expected while
    // matching on it, so two concurrent writers both pass the check.
    expect(pinned?.version).toBe((before?.version ?? 0) + 1);

    await app.inject({
      method: 'DELETE',
      url: `/v1/runs/${body.runId}/pin`,
      headers: authHeaders('pin-op-2'),
    });
    const unpinned = await shotOf(store, body.projectId);
    expect(unpinned?.version).toBe((before?.version ?? 0) + 2);
  });

  it('does not record an acceptance when a run is pinned', async () => {
    const { app, store } = createApp();
    const created = await submitRun(app, 'pin-not-accept');
    const body = created.json();

    const pin = await app.inject({
      method: 'POST',
      url: `/v1/runs/${body.runId}/pin`,
      headers: authHeaders('pin-op-3'),
    });
    expect(pin.statusCode).toBe(200);

    const shot = await shotOf(store, body.projectId);
    expect(shot?.pinnedAttemptId).toBe(body.runId);
    // Pinning a run that was never reviewed must not make the shot look
    // accepted; project completion counts accepted attempts.
    expect(shot?.acceptedAttemptId).toBeUndefined();
    expect(shot?.status).not.toBe('accepted');

    const run = await app.inject({
      method: 'GET',
      url: `/v1/runs/${body.runId}`,
      headers: authHeaders(),
    });
    expect(run.json().pinned).toBe(true);
  });

  it('leaves acceptance intact when the pin is removed', async () => {
    const { app, store } = createApp();
    const created = await submitRun(app, 'unpin-accepted');
    const body = created.json();

    await app.inject({
      method: 'POST',
      url: `/v1/runs/${body.runId}/pin`,
      headers: authHeaders('pin-op-accepted'),
    });

    // Put the shot in the state the legacy review flow produces: accepted, and
    // identifying its accepted attempt.
    await store.withTransaction(async (repositories) => {
      const shots = await repositories.shots.listByProject(
        assertUuid(body.projectId),
      );
      const shot = shots[0];
      if (!shot) throw new Error('shot missing');
      await repositories.shots.update(
        {
          ...shot,
          status: 'accepted',
          acceptedAttemptId: assertUuid(body.runId),
          version: shot.version + 1,
        },
        shot.version,
      );
    });

    const unpin = await app.inject({
      method: 'DELETE',
      url: `/v1/runs/${body.runId}/pin`,
      headers: authHeaders('unpin-op-accepted'),
    });
    expect(unpin.statusCode).toBe(200);

    const after = await shotOf(store, body.projectId);
    expect(after?.pinnedAttemptId).toBeUndefined();
    // Unpin previously cleared `acceptedAttemptId`, leaving the shot `accepted`
    // with no accepted attempt, which assertShot rejects on every later
    // transition and permanently blocks the project.
    expect(after?.status).toBe('accepted');
    expect(after?.acceptedAttemptId).toBe(body.runId);
  });
});
