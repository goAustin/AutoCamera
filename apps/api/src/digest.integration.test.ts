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
  createDomainEvent,
  createUuidV7,
  parseUsdToMicrousd,
  type Uuid,
} from '@h3/domain';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { buildApiApp } from './app.js';
import { DEV_TENANT_ID, ProjectApplicationService } from './application.js';
import { OperationalDigestService } from './digest.js';
import { createOperationalToolServices } from './operator.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const controlPool = createDatabasePool(databaseUrl);
const databaseAvailable = await checkDatabaseReady(controlPool);
const schemaName = `h3_digest_${Date.now()}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;
if (databaseAvailable) {
  await controlPool.query(`CREATE SCHEMA "${schemaName}"`);
}
const pool = databaseAvailable
  ? createDatabasePool(databaseUrl, { searchPath: schemaName })
  : controlPool;
const store = createPostgresStore(pool);

const WINDOW = {
  sinceIso: '2026-01-01T00:00:00.000Z',
  untilIso: '2026-01-01T23:59:59.000Z',
} as const;

const SUMMARY = {
  severity: 'info',
  title: 'The session completed without incident.',
  detail: 'Nothing in the window required attention.',
  referencedRunIds: [],
} as const;

/** A stub provider whose round trip can be held open, to test what a caller racing it sees. */
function gatedStreamFn(gate: Promise<void>): StreamFn {
  const faux = fauxProvider({
    provider: 'deepseek-test-stub',
    models: [{ id: 'stub-model', name: 'stub-model' }],
  });
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('submit_digest', SUMMARY, { id: 'digest-gated-0' }),
    ]),
  ]);
  return async (model, context, options) => {
    await gate;
    return faux.provider.streamSimple(model, context, options);
  };
}

function digestService(streamFnOverride: StreamFn): OperationalDigestService {
  return new OperationalDigestService({
    store,
    tenantId: DEV_TENANT_ID,
    idGenerator: { next: () => createUuidV7() },
    provider: 'deepseek-test-stub',
    streamFnOverride,
    services: (repositories) =>
      createOperationalToolServices(repositories, DEV_TENANT_ID, {
        mode: 'fake',
        getExecutorReadiness: async () => ({
          mode: 'fake',
          ready: true,
          checkedAt: '2026-01-01T00:00:00.000Z',
        }),
      }),
  });
}

function digestApp(streamFnOverride: StreamFn) {
  return buildApiApp({
    config: getApiConfig({
      NODE_ENV: 'test',
      DEV_AUTH_TOKEN: 'test-secret',
      DATABASE_URL: databaseUrl,
    }),
    databaseReady: () => checkDatabaseReady(pool),
    store,
    digestService: digestService(streamFnOverride),
  });
}

async function seedProject(title: string): Promise<Uuid> {
  const projectService = new ProjectApplicationService({
    store,
    defaultBudgetMicrousd: parseUsdToMicrousd('25.00'),
  });
  const project = await projectService.createProject({
    title,
    brief: 'A project for session digest integration tests.',
    targetDurationSeconds: 3,
    budgetMicrousd: parseUsdToMicrousd('0.05'),
  });
  await store.withTransaction((repositories) =>
    repositories.events.append(
      createDomainEvent({
        id: createUuidV7(),
        type: 'attempt.failed',
        producer: 'digest-integration-test',
        tenantId: DEV_TENANT_ID,
        projectId: project.id,
        payload: { status: 'FAILED' },
        clock: { now: () => new Date('2026-01-01T06:00:00.000Z') },
      }),
    ),
  );
  return project.id;
}

beforeAll(async () => {
  if (databaseAvailable) await runMigrations(pool);
});

afterAll(async () => {
  await closeDatabase(pool);
  if (databaseAvailable) {
    await controlPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    await closeDatabase(controlPool);
  }
});

describe.skipIf(!databaseAvailable)(
  'Phase 7E step 4 session digest against real PostgreSQL',
  () => {
    it('persists one agent_runs row whose cost is reported as inference spend', async () => {
      const app = digestApp(gatedStreamFn(Promise.resolve()));
      try {
        const projectId = await seedProject('pg digest project');
        const response = await app.inject({
          method: 'POST',
          url: `/v1/projects/${projectId}/digest`,
          headers: {
            authorization: 'Bearer test-secret',
            'idempotency-key': `pg-digest-${projectId}`,
          },
          payload: WINDOW,
        });
        expect(response.statusCode).toBe(200);

        const persisted = await pool.query<{
          readonly id: string;
          readonly status: string;
          readonly objective: string;
        }>(
          `SELECT id, status, objective FROM agent_runs WHERE project_id = $1`,
          [projectId],
        );
        expect(persisted.rows).toHaveLength(1);
        expect(persisted.rows[0]?.status).toBe('succeeded');
        expect(response.json().digest.agentRunId).toBe(persisted.rows[0]?.id);

        // What the digest cost is monitoring spend, and the $0.05 budget the
        // GPU rental is held to never sees it.
        await pool.query(
          `UPDATE agent_runs SET provider_cost_microusd = 250000 WHERE project_id = $1`,
          [projectId],
        );
        const cost = await app.inject({
          method: 'GET',
          url: `/v1/projects/${projectId}/cost`,
          headers: { authorization: 'Bearer test-secret' },
        });
        expect(cost.json()).toMatchObject({
          budgetMicrousd: 50_000,
          inferenceCostMicrousd: 250_000,
          spentMicrousd: 0,
          remainingMicrousd: 50_000,
        });
      } finally {
        await app.close();
      }
    });

    it('tells a caller racing the same key that the request is in progress, rather than buying a second run', async () => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = digestApp(gatedStreamFn(gate));
      try {
        const projectId = await seedProject('pg digest race project');
        const headers = {
          authorization: 'Bearer test-secret',
          'idempotency-key': `pg-digest-race-${projectId}`,
        };

        // The first request reserves its key, commits that reservation, and
        // is then held inside the provider round trip -- exactly the window
        // in which the reservation has to be visible to another connection.
        const first = app.inject({
          method: 'POST',
          url: `/v1/projects/${projectId}/digest`,
          headers,
          payload: WINDOW,
        });
        await expect
          .poll(async () => {
            const reserved = await pool.query(
              `SELECT 1 FROM idempotency_records
               WHERE idempotency_key = $1 AND response_status IS NULL`,
              [headers['idempotency-key']],
            );
            return reserved.rows.length;
          })
          .toBe(1);

        const racing = await app.inject({
          method: 'POST',
          url: `/v1/projects/${projectId}/digest`,
          headers,
          payload: WINDOW,
        });
        expect(racing.statusCode).toBe(409);
        expect(racing.json().code).toBe('IDEMPOTENCY_IN_PROGRESS');

        release();
        expect((await first).statusCode).toBe(200);

        // One paid round trip, one run row, however many callers asked.
        const runs = await pool.query(
          `SELECT id FROM agent_runs WHERE project_id = $1`,
          [projectId],
        );
        expect(runs.rows).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  },
);
