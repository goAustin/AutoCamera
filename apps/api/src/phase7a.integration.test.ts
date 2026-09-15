import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import {
  checkDatabaseReady,
  closeDatabase,
  createDatabasePool,
  createPostgresStore,
  runMigrations,
} from '@h3/db';
import {
  DeterministicFakeComfyService,
  FakeComfyClient,
} from '@h3/comfy-client';
import { loadMinimaxH3Fixtures } from '@h3/workflow-compiler';
import { assertUuid, transitionGenerationAttempt } from '@h3/domain';
import { buildApiApp } from './app.js';
import { DEV_TENANT_ID } from './application.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const controlPool = createDatabasePool(databaseUrl);
const databaseAvailable = await checkDatabaseReady(controlPool);
const schemaName = `h3_phase7a_${Date.now()}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;
if (databaseAvailable) {
  await controlPool.query(`CREATE SCHEMA "${schemaName}"`);
}
const pool = databaseAvailable
  ? createDatabasePool(databaseUrl, { searchPath: schemaName })
  : controlPool;
const store = createPostgresStore(pool);
const comfy = new DeterministicFakeComfyService();
const app = buildApiApp({
  config: getApiConfig({
    NODE_ENV: 'test',
    DEV_AUTH_TOKEN: 'test-secret',
    DATABASE_URL: databaseUrl,
  }),
  databaseReady: () => checkDatabaseReady(pool),
  store,
  comfyClient: new FakeComfyClient(comfy),
});
let fixtures: Awaited<ReturnType<typeof loadMinimaxH3Fixtures>>;

function authHeaders(key?: string): Record<string, string> {
  return {
    authorization: 'Bearer test-secret',
    ...(key ? { 'idempotency-key': key } : {}),
  };
}

beforeAll(async () => {
  if (databaseAvailable) await runMigrations(pool);
  fixtures = await loadMinimaxH3Fixtures();
});

afterAll(async () => {
  await app.close();
  await closeDatabase(pool);
  if (databaseAvailable) {
    await controlPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    await closeDatabase(controlPool);
  }
});

describe.skipIf(!databaseAvailable)('Phase 7A PostgreSQL thin core', () => {
  // Each direct run creates one implicit shot, so the fourth against a project
  // is the first with an ordinal past 3. Migration 0007 dropped the 1-3 range
  // check and the domain type is any positive integer, but the row mapper kept
  // enforcing 1|2|3 -- so the fourth run wrote its shot, failed mapping the row
  // back, and rolled back. Every subsequent run against that project failed the
  // same way, permanently, with INVALID_SHOT.
  it('accepts direct runs past the third against one project', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: authHeaders('phase7a-ordinal-1'),
      payload: {
        editorGraph: fixtures.editorGraph,
        apiGraph: fixtures.apiGraph,
        idempotencyKey: 'phase7a-ordinal-1',
      },
    });
    expect(first.statusCode).toBe(201);
    const projectId = assertUuid(first.json().projectId as string);

    for (const ordinal of [2, 3, 4, 5]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: authHeaders(`phase7a-ordinal-${ordinal}`),
        payload: {
          projectId,
          editorGraph: fixtures.editorGraph,
          apiGraph: fixtures.apiGraph,
          idempotencyKey: `phase7a-ordinal-${ordinal}`,
        },
      });
      expect(
        response.statusCode,
        `run ${ordinal} against the same project: ${response.body}`,
      ).toBe(201);
    }

    const shots = await pool.query<{ ordinal: number }>(
      'SELECT ordinal FROM shots WHERE project_id = $1 ORDER BY ordinal',
      [projectId],
    );
    expect(shots.rows.map((row) => row.ordinal)).toEqual([1, 2, 3, 4, 5]);
  });

  it('persists direct runs and allows review annotations after lifecycle terminality', async () => {
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: authHeaders('phase7a-pg-run'),
      payload: {
        editorGraph: fixtures.editorGraph,
        apiGraph: fixtures.apiGraph,
        idempotencyKey: 'phase7a-pg-run',
      },
    });
    expect(submitted.statusCode).toBe(201);
    const runId = assertUuid(submitted.json().runId as string);
    const projectId = assertUuid(submitted.json().projectId as string);

    await store.withTransaction(async (repositories) => {
      const attempt = await repositories.attempts.findById(
        DEV_TENANT_ID,
        runId,
      );
      if (!attempt) throw new Error('Expected a persisted run attempt.');
      const running = transitionGenerationAttempt(attempt, 'running');
      await repositories.attempts.update(running, attempt.version);
    });

    const runningReview = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/review`,
      headers: authHeaders('phase7a-pg-running-review'),
      payload: { decision: 'accepted', note: 'Running annotation.' },
    });
    expect(runningReview.statusCode).toBe(200);
    expect(runningReview.json()).toMatchObject({
      status: 'running',
      review: { decision: 'accepted', note: 'Running annotation.' },
    });

    await store.withTransaction(async (repositories) => {
      const attempt = await repositories.attempts.findById(
        DEV_TENANT_ID,
        runId,
      );
      if (!attempt) throw new Error('Expected the reviewed attempt.');
      const failed = transitionGenerationAttempt(attempt, 'failed');
      await repositories.attempts.update(failed, attempt.version);
    });

    const terminalReview = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/review`,
      headers: authHeaders('phase7a-pg-terminal-review'),
      payload: { decision: 'rejected', note: 'Terminal annotation.' },
    });
    expect(terminalReview.statusCode).toBe(200);
    expect(terminalReview.json()).toMatchObject({
      status: 'failed',
      review: { decision: 'rejected', note: 'Terminal annotation.' },
    });

    const pinned = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/pin`,
      headers: authHeaders('phase7a-pg-pin-failed'),
      payload: {},
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json()).toMatchObject({ status: 'failed', pinned: true });

    const persisted = await store.withTransaction(async (repositories) => ({
      attempts: await repositories.attempts.listByProject(
        DEV_TENANT_ID,
        projectId,
      ),
      shots: await repositories.shots.listByProject(projectId),
    }));
    expect(persisted.attempts).toHaveLength(1);
    expect(persisted.attempts[0]).toMatchObject({
      id: runId,
      status: 'failed',
      reviewDecision: 'rejected',
    });
    expect(persisted.shots).toHaveLength(1);
    expect(persisted.shots[0]).toMatchObject({
      implicit: true,
      pinnedAttemptId: runId,
    });
    // Pin marks the keeper only; it must not write `acceptedAttemptId`,
    // which records human acceptance and is what project completion counts.
    // This run was only reviewed (an annotation) and pinned, never accepted
    // through the legacy accept route, so acceptance must stay unset.
    expect(persisted.shots[0]?.acceptedAttemptId).toBeUndefined();
  });
});
