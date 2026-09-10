import { afterEach, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import {
  createInMemoryStore,
  OutboxDispatcher,
  type AgentRunRecord,
  type TransactionalStore,
} from '@h3/db';
import {
  assertMicrousd,
  createUuidV7,
  formatMicrousdToUsd,
  type Uuid,
} from '@h3/domain';
import { createTraceId } from '@h3/telemetry';
import { DEV_TENANT_ID } from './application.js';
import { buildApiApp } from './app.js';

const apps = new Set<Awaited<ReturnType<typeof buildApiApp>>>();

function createApp(store: TransactionalStore = createInMemoryStore()) {
  const app = buildApiApp({
    config: getApiConfig({ NODE_ENV: 'test', DEV_AUTH_TOKEN: 'test-secret' }),
    store,
  });
  apps.add(app);
  return app;
}

function authHeaders(key?: string): Record<string, string> {
  return {
    authorization: 'Bearer test-secret',
    ...(key ? { 'idempotency-key': key } : {}),
  };
}

function agentRunFixture(
  projectId: Uuid,
  runId: string,
  providerCostMicrousd: number,
): AgentRunRecord {
  const startedAt = new Date().toISOString();
  return {
    id: createUuidV7(),
    tenantId: DEV_TENANT_ID,
    projectId,
    runId,
    sessionId: `session-${runId}`,
    objective: 'Recommend a bounded operational action from durable evidence.',
    provider: 'faux',
    model: 'faux-model',
    status: 'succeeded',
    toolCalls: 1,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerCostMicrousd,
    startedAt,
    version: 1,
    updatedAt: startedAt,
  };
}

afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  apps.clear();
});

describe('Phase 2 project API', () => {
  it('authenticates /v1 routes and returns redacted problem details', async () => {
    const app = createApp();
    const unauthorized = await app.inject({
      method: 'GET',
      url: '/v1/projects',
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(unauthorized.json()).toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
      retryable: false,
    });
    expect(JSON.stringify(unauthorized.json())).not.toContain('test-secret');

    const secret = 'prompt-and-secret-value';
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('invalid-body'),
      payload: { title: '', brief: secret, targetDurationSeconds: 1 },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(JSON.stringify(invalid.json())).not.toContain(secret);
    expect(JSON.stringify(invalid.json())).not.toContain('node_modules');
    expect(JSON.stringify(invalid.json())).not.toContain('SQL');
  });

  it('replays identical mutations and rejects idempotency key reuse', async () => {
    const app = createApp();
    const payload = {
      title: 'Idempotent project',
      brief: 'A repeatable brief.',
      targetDurationSeconds: 6,
    };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('same-create'),
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('same-create'),
      payload: {
        brief: payload.brief,
        title: payload.title,
        targetDurationSeconds: 6,
      },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());

    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('same-create'),
      payload: { ...payload, title: 'Different project' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('serializes concurrent identical create requests to one effect', async () => {
    const app = createApp();
    const request = {
      method: 'POST' as const,
      url: '/v1/projects',
      headers: authHeaders('concurrent-create'),
      payload: {
        title: 'Concurrent project',
        brief: 'One durable effect.',
        targetDurationSeconds: 3,
      },
    };
    const responses = await Promise.all([
      app.inject(request),
      app.inject(request),
      app.inject(request),
    ]);
    expect(responses.every((response) => response.statusCode === 201)).toBe(
      true,
    );
    expect(new Set(responses.map((response) => response.body)).size).toBe(1);
    const projects = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: authHeaders(),
    });
    expect(projects.json().projects).toHaveLength(1);
  });

  it('publishes all implemented routes in OpenAPI and can dispatch the outbox', async () => {
    const store = createInMemoryStore();
    const app = createApp(store);
    const openApi = await app.inject({
      method: 'GET',
      url: '/documentation/json',
    });
    expect(openApi.statusCode).toBe(200);
    const paths = Object.keys(openApi.json().paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/v1/projects',
        '/v1/projects/{projectId}',
        '/v1/projects/{projectId}/events',
        '/v1/projects/{projectId}/cost',
        '/v1/runs',
        '/v1/runs/{runId}',
      ]),
    );
    expect(createTraceId()).toMatch(/^[0-9a-f]{32}$/);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('outbox-create'),
      payload: {
        title: 'Outbox project',
        brief: 'Dispatch me.',
        targetDurationSeconds: 3,
      },
    });
    expect(response.statusCode).toBe(201);
    const dispatcher = new OutboxDispatcher(store);
    expect(await dispatcher.pollOnce()).toBe(true);
    expect(await dispatcher.pollOnce()).toBe(false);
  });
});

describe('Phase 7E step 5 — inference cost on GET /cost', () => {
  it('reports zero inference cost for a project with no agent runs', async () => {
    const app = createApp();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('cost-zero-runs'),
      payload: {
        title: 'No agent runs yet',
        brief: 'A fresh project with nothing to sum.',
        targetDurationSeconds: 4,
      },
    });
    expect(create.statusCode).toBe(201);
    const projectId = create.json().project.id as Uuid;

    const cost = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/cost`,
      headers: authHeaders(),
    });
    expect(cost.statusCode).toBe(200);
    expect(cost.json()).toMatchObject({
      inferenceCostMicrousd: 0,
      inferenceCostUsd: formatMicrousdToUsd(assertMicrousd(0)),
    });
  });

  it('sums provider cost across several agent runs into a separate inference figure', async () => {
    const store = createInMemoryStore();
    const app = createApp(store);
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('cost-several-runs'),
      payload: {
        title: 'Several agent runs',
        brief: 'Provider cost from more than one run must sum.',
        targetDurationSeconds: 4,
      },
    });
    expect(create.statusCode).toBe(201);
    const projectId = create.json().project.id as Uuid;

    const runCosts = [500_000, 750_000, 500_000];
    await store.withTransaction(async (repositories) => {
      for (const [index, providerCostMicrousd] of runCosts.entries()) {
        await repositories.agentRuns.create(
          agentRunFixture(projectId, `run-${index}`, providerCostMicrousd),
        );
      }
    });
    const totalMicrousd = runCosts.reduce((sum, value) => sum + value, 0);

    const cost = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/cost`,
      headers: authHeaders(),
    });
    expect(cost.statusCode).toBe(200);
    expect(cost.json()).toMatchObject({
      inferenceCostMicrousd: totalMicrousd,
      inferenceCostUsd: formatMicrousdToUsd(assertMicrousd(totalMicrousd)),
    });
  });

  it('never lets inference cost move spentMicrousd or remainingMicrousd', async () => {
    const store = createInMemoryStore();
    const app = createApp(store);
    const budgetMicrousd = 1_000_000;
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('cost-isolation'),
      payload: {
        title: 'Budget stays attempt-only',
        brief: 'Inference cost must never move spend or remaining.',
        targetDurationSeconds: 4,
        budgetMicrousd,
      },
    });
    expect(create.statusCode).toBe(201);
    const projectId = create.json().project.id as Uuid;

    const before = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/cost`,
      headers: authHeaders(),
    });
    expect(before.json()).toMatchObject({
      budgetMicrousd,
      spentMicrousd: 0,
      remainingMicrousd: budgetMicrousd,
    });

    // Five times the project's whole budget, and never an attempt: a
    // subtractMicrousd(budget, inference) bug would throw NEGATIVE_MONEY
    // here instead of leaving spend alone.
    const overBudgetInferenceCost = budgetMicrousd * 5;
    await store.withTransaction(async (repositories) => {
      await repositories.agentRuns.create(
        agentRunFixture(projectId, 'run-over-budget', overBudgetInferenceCost),
      );
    });

    const after = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/cost`,
      headers: authHeaders(),
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({
      budgetMicrousd,
      spentMicrousd: 0,
      remainingMicrousd: budgetMicrousd,
      inferenceCostMicrousd: overBudgetInferenceCost,
    });
  });
});
