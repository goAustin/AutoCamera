import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import {
  checkDatabaseReady,
  closeDatabase,
  createDatabasePool,
  createPostgresStore,
  runMigrations,
} from '@h3/db';
import { buildApiApp } from './app.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const pool = createDatabasePool(databaseUrl);
const app = buildApiApp({
  config: getApiConfig({
    NODE_ENV: 'test',
    DEV_AUTH_TOKEN: 'test-secret',
    DATABASE_URL: databaseUrl,
  }),
  databaseReady: () => checkDatabaseReady(pool),
  store: createPostgresStore(pool),
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
      'storyboard_proposals',
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
       WHERE conname = ANY($1::text[])`,
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

  it('persists the complete project, storyboard, shot, event, outbox, and cost flow', async () => {
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

    const plan = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/plan`,
      headers: authHeaders(uniqueKey('pg-plan')),
      payload: {},
    });
    expect(plan.statusCode).toBe(200);
    const plannedProject = plan.json().project as { status: string };
    const proposal = plan.json().proposal as {
      id: string;
      shots: Array<{ ordinal: number; durationSeconds: number }>;
    };
    expect(plannedProject.status).toBe('awaiting_storyboard_approval');
    expect(proposal.shots.map((shot) => shot.ordinal)).toEqual([1, 2, 3]);
    expect(
      proposal.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0),
    ).toBeCloseTo(5, 6);

    const approval = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/storyboard/approve`,
      headers: authHeaders(uniqueKey('pg-approve')),
      payload: { proposalId: proposal.id },
    });
    expect(approval.statusCode).toBe(200);
    expect(approval.json().project.status).toBe('ready_for_generation');
    expect(approval.json().shots).toHaveLength(3);

    const retrieved = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}`,
      headers: authHeaders(),
    });
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json().project).toMatchObject({
      id: project.id,
      status: 'ready_for_generation',
      budgetMicrousd: 12_500_000,
      spentMicrousd: 0,
      version: 4,
    });

    const shots = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/shots`,
      headers: authHeaders(),
    });
    expect(shots.statusCode).toBe(200);
    expect(shots.json().shots).toHaveLength(3);
    expect(
      shots.json().shots.map((shot: { ordinal: number }) => shot.ordinal),
    ).toEqual([1, 2, 3]);
    expect(
      shots
        .json()
        .shots.every(
          (shot: { status: string }) =>
            shot.status === 'approved_for_generation',
        ),
    ).toBe(true);

    const events = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/events`,
      headers: authHeaders(),
    });
    expect(events.statusCode).toBe(200);
    expect(
      events.json().events.map((event: { type: string }) => event.type),
    ).toEqual([
      'project.created',
      'project.planning_started',
      'storyboard.proposed',
      'project.planned',
      'storyboard.approved',
      'shot.created',
      'shot.created',
      'shot.created',
      'project.ready_for_generation',
    ]);

    const cost = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/cost`,
      headers: authHeaders(),
    });
    expect(cost.statusCode).toBe(200);
    expect(cost.json()).toMatchObject({
      budgetMicrousd: 12_500_000,
      spentMicrousd: 0,
      remainingMicrousd: 12_500_000,
    });

    const persistedProject = await pool.query<{
      status: string;
      version: number;
    }>('SELECT status, version FROM video_projects WHERE id = $1', [
      project.id,
    ]);
    expect(persistedProject.rows).toEqual([
      { status: 'ready_for_generation', version: 4 },
    ]);

    const persistedProposal = await pool.query<{ status: string }>(
      'SELECT status FROM storyboard_proposals WHERE id = $1',
      [proposal.id],
    );
    expect(persistedProposal.rows).toEqual([{ status: 'approved' }]);

    const persistedShots = await pool.query<{
      ordinal: number;
      status: string;
    }>(
      `SELECT ordinal, status
       FROM shots
       WHERE project_id = $1
       ORDER BY ordinal`,
      [project.id],
    );
    expect(persistedShots.rows).toEqual([
      { ordinal: 1, status: 'approved_for_generation' },
      { ordinal: 2, status: 'approved_for_generation' },
      { ordinal: 3, status: 'approved_for_generation' },
    ]);

    const persistedEvents = await pool.query<{ type: string }>(
      `SELECT type
       FROM domain_events
       WHERE project_id = $1
       ORDER BY event_sequence`,
      [project.id],
    );
    expect(persistedEvents.rows.map((row) => row.type)).toEqual(
      events.json().events.map((event: { type: string }) => event.type),
    );

    const persistedOutbox = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM outbox_events AS outbox
       JOIN domain_events AS event ON event.id = outbox.event_id
       WHERE event.project_id = $1`,
      [project.id],
    );
    expect(persistedOutbox.rows[0]?.count).toBe(9);
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
