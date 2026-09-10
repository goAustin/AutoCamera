import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import {
  checkDatabaseReady,
  closeDatabase,
  createDatabasePool,
  createPostgresStore,
  runMigrations,
  type AgentRunRecord,
} from '@h3/db';
import { createDomainEvent, createUuidV7, type Uuid } from '@h3/domain';
import { loadMinimaxH3Fixtures } from '@h3/workflow-compiler';
import { DEV_TENANT_ID } from './application.js';
import { buildApiApp } from './app.js';
import type { OperationalPiAdapter } from './operator.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const pool = createDatabasePool(databaseUrl);
const store = createPostgresStore(pool);
const app = buildApiApp({
  config: getApiConfig({
    NODE_ENV: 'test',
    DEV_AUTH_TOKEN: 'test-secret',
    DATABASE_URL: databaseUrl,
  }),
  databaseReady: () => checkDatabaseReady(pool),
  store,
});

function authHeaders(key?: string): Record<string, string> {
  return {
    authorization: 'Bearer test-secret',
    ...(key ? { 'idempotency-key': key } : {}),
  };
}

function uniqueKey(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
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

beforeAll(async () => {
  await runMigrations(pool);
});

afterAll(async () => {
  await app.close();
  await closeDatabase(pool);
});

describe('Phase 2 PostgreSQL persistence', () => {
  it('applies the required tables, constraints, and indexes', async () => {
    const requiredTables = [
      'tenants',
      'video_projects',
      'shots',
      'generation_attempts',
      'workflow_versions',
      'artifacts',
      'evaluation_results',
      'agent_runs',
      'domain_events',
      'outbox_events',
      'idempotency_records',
    ];
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [requiredTables],
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual(
      [...requiredTables].sort(),
    );

    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace
         AND conname = ANY($1::text[])`,
      [
        [
          'video_projects_budget_non_negative',
          'video_projects_version_positive',
          'shots_project_ordinal_unique',
          'generation_attempts_steps_positive',
          'shots_accepted_attempt_fk',
        ],
      ],
    );
    expect(constraints.rows.map((row) => row.conname).sort()).toEqual([
      'generation_attempts_steps_positive',
      'shots_accepted_attempt_fk',
      'shots_project_ordinal_unique',
      'video_projects_budget_non_negative',
      'video_projects_version_positive',
    ]);

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
      [
        [
          'generation_attempts_comfy_prompt_id_unique',
          'generation_attempts_one_accepted_per_shot',
          'outbox_events_pending_idx',
        ],
      ],
    );
    expect(indexes.rows.map((row) => row.indexname).sort()).toEqual([
      'generation_attempts_comfy_prompt_id_unique',
      'generation_attempts_one_accepted_per_shot',
      'outbox_events_pending_idx',
    ]);
  });

  it('persists the complete project, shot, revision, attempt, event, outbox, and cost flow', async () => {
    // Phase 7D removed storyboard planning; the durable core is now exercised
    // through `POST /v1/runs`, the graph-first path that replaced it. This
    // still verifies the same thing the deleted plan/approve version did:
    // that project, shot, event, outbox, and cost all round-trip through
    // real PostgreSQL.
    const fixtures = await loadMinimaxH3Fixtures();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders(uniqueKey('pg-create')),
      payload: {
        title: 'PostgreSQL lifecycle project',
        brief: 'A durable lifecycle verification.',
        targetDurationSeconds: 5,
        budgetUsd: '12.50',
      },
    });
    expect(create.statusCode).toBe(201);
    const project = create.json().project as {
      id: string;
      status: string;
      version: number;
    };
    expect(project).toMatchObject({
      status: 'draft',
      version: 1,
    });

    const run = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: authHeaders(uniqueKey('pg-run')),
      payload: {
        projectId: project.id,
        editorGraph: fixtures.editorGraph,
        apiGraph: fixtures.apiGraph,
      },
    });
    expect(run.statusCode).toBe(201);
    const runId = run.json().runId as string;
    expect(run.json().status).toBe('queued');

    const retrieved = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}`,
      headers: authHeaders(),
    });
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json().project).toMatchObject({
      id: project.id,
      status: 'generating',
      budgetMicrousd: 12_500_000,
    });

    const events = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/events`,
      headers: authHeaders(),
    });
    expect(events.statusCode).toBe(200);
    const eventTypes = events
      .json()
      .events.map((event: { type: string }) => event.type);
    expect(eventTypes).toEqual([
      'project.created',
      'project.ready_for_generation',
      'shot.created',
      'attempt.queued',
      'run.created',
    ]);

    const cost = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/cost`,
      headers: authHeaders(),
    });
    expect(cost.statusCode).toBe(200);
    expect(cost.json()).toMatchObject({ budgetMicrousd: 12_500_000 });

    const persistedProject = await pool.query<{ status: string }>(
      'SELECT status FROM video_projects WHERE id = $1',
      [project.id],
    );
    expect(persistedProject.rows).toEqual([{ status: 'generating' }]);

    const persistedShots = await pool.query<{
      ordinal: number;
      status: string;
      implicit: boolean;
    }>(
      `SELECT ordinal, status, implicit
       FROM shots
       WHERE project_id = $1
       ORDER BY ordinal`,
      [project.id],
    );
    expect(persistedShots.rows).toEqual([
      { ordinal: 1, status: 'queued', implicit: true },
    ]);

    const persistedAttempts = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM generation_attempts WHERE project_id = $1',
      [project.id],
    );
    expect(persistedAttempts.rows).toEqual([{ id: runId, status: 'queued' }]);

    const persistedEvents = await pool.query<{ type: string }>(
      `SELECT type
       FROM domain_events
       WHERE project_id = $1
       ORDER BY event_sequence`,
      [project.id],
    );
    expect(persistedEvents.rows.map((row) => row.type)).toEqual(eventTypes);

    const persistedOutbox = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM outbox_events AS outbox
       JOIN domain_events AS event ON event.id = outbox.event_id
       WHERE event.project_id = $1`,
      [project.id],
    );
    expect(persistedOutbox.rows[0]?.count).toBe(eventTypes.length);
  });

  it('serializes concurrent PostgreSQL idempotency and replays or rejects reuse', async () => {
    const key = uniqueKey('pg-concurrent-create');
    const payload = {
      title: 'PostgreSQL idempotency project',
      brief: 'One durable effect for concurrent requests.',
      targetDurationSeconds: 3,
    };
    const request = {
      method: 'POST' as const,
      url: '/v1/projects',
      headers: authHeaders(key),
      payload,
    };
    const responses = await Promise.all([
      app.inject(request),
      app.inject(request),
      app.inject(request),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([
      201, 201, 201,
    ]);
    expect(new Set(responses.map((response) => response.body)).size).toBe(1);

    const projectId = responses[0]?.json().project.id as string;
    const projectRows = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM video_projects WHERE id = $1',
      [projectId],
    );
    expect(projectRows.rows[0]?.count).toBe(1);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders(key),
      payload: { ...payload },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(responses[0]?.json());

    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders(key),
      payload: { ...payload, title: 'Different project' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});

describe('Phase 7E operational event durability', () => {
  it('persists recommendation.created to real domain_events and outbox_events', async () => {
    // The unit suite proves this against the in-memory store. This is the
    // PostgreSQL half: that the new event type survives the real
    // `domain_events` insert, its JSONB payload round-trips, and the outbox
    // row that carries it to a consumer is actually there.
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders(uniqueKey('pg-recommendation')),
      payload: {
        title: 'PostgreSQL operator finding project',
        brief: 'A durable operational finding verification.',
        targetDurationSeconds: 5,
      },
    });
    expect(create.statusCode).toBe(201);
    const projectId = create.json().project.id as Uuid;

    // Driven through the adapter directly rather than through the outbox
    // worker: integration files share one database, so a `pollOnce()` here
    // could claim another file's message and make this test order-dependent.
    // The emit path under test is the same either way.
    const trigger = createDomainEvent({
      id: createUuidV7(),
      type: 'executor.unavailable',
      producer: 'domain-api-integration-test',
      tenantId: DEV_TENANT_ID,
      projectId,
      traceId: `trace-${randomUUID()}`,
      payload: { code: 'COMFY_UNAVAILABLE' },
      clock: { now: () => new Date() },
    });
    await store.withTransaction(async (repositories) => {
      await repositories.events.append(trigger);
    });

    const adapter = (
      app as unknown as { readonly operationalPiAdapter: OperationalPiAdapter }
    ).operationalPiAdapter;
    const processed = await adapter.processEvent(trigger);
    expect(processed.handled).toBe(true);
    expect(processed.duplicate).toBe(false);
    const recommendation = processed.recommendation;
    if (!recommendation) {
      throw new Error('Expected a persisted operational recommendation.');
    }

    const persistedEvents = await pool.query<{
      trace_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT trace_id, payload
       FROM domain_events
       WHERE project_id = $1 AND type = 'recommendation.created'`,
      [projectId],
    );
    expect(persistedEvents.rows).toHaveLength(1);
    expect(persistedEvents.rows[0]?.trace_id).toBe(trigger.traceId);
    expect(persistedEvents.rows[0]?.payload).toEqual({
      recommendationId: recommendation.id,
      severity: recommendation.severity,
      recommendationCode: recommendation.recommendationCode,
      proposedActionType: recommendation.proposedActionType,
      triggeringEventType: 'executor.unavailable',
    });

    const persistedOutbox = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM outbox_events AS outbox
       JOIN domain_events AS event ON event.id = outbox.event_id
       WHERE event.project_id = $1 AND event.type = 'recommendation.created'`,
      [projectId],
    );
    expect(persistedOutbox.rows[0]?.count).toBe(1);

    const persistedRecommendations = await pool.query<{ id: string }>(
      'SELECT id FROM operational_recommendations WHERE project_id = $1',
      [projectId],
    );
    expect(persistedRecommendations.rows).toEqual([{ id: recommendation.id }]);
  });
});

describe('Phase 7E step 5 — inference cost against real PostgreSQL', () => {
  it('returns 0, not null, for a project with no agent runs', async () => {
    // A bare `SUM(provider_cost_microusd)` over zero matching rows is NULL
    // in PostgreSQL; the repository query must COALESCE it. This is the one
    // divergence from the in-memory store that a unit test cannot catch.
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders(uniqueKey('pg-cost-zero-runs')),
      payload: {
        title: 'PostgreSQL project with no agent runs',
        brief: 'Confirms SUM is coalesced to zero.',
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
    expect(cost.json().inferenceCostMicrousd).toBe(0);
  });

  it('sums provider cost across several agent runs through a real BIGINT round trip', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders(uniqueKey('pg-cost-several-runs')),
      payload: {
        title: 'PostgreSQL project with several agent runs',
        brief: 'Confirms SUM aggregates across rows.',
        targetDurationSeconds: 4,
      },
    });
    expect(create.statusCode).toBe(201);
    const projectId = create.json().project.id as Uuid;

    const runCosts = [1_250_000, 2_000_000, 500_000];
    await store.withTransaction(async (repositories) => {
      for (const [index, providerCostMicrousd] of runCosts.entries()) {
        await repositories.agentRuns.create(
          agentRunFixture(
            projectId,
            uniqueKey(`pg-run-${index}`),
            providerCostMicrousd,
          ),
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
    expect(cost.json().inferenceCostMicrousd).toBe(totalMicrousd);

    const persistedSum = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(provider_cost_microusd), 0)::text AS total
       FROM agent_runs WHERE project_id = $1`,
      [projectId],
    );
    expect(Number(persistedSum.rows[0]?.total)).toBe(totalMicrousd);
  });
});
