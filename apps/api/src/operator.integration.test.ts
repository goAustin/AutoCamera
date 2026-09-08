import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import {
  checkDatabaseReady,
  closeDatabase,
  createDatabasePool,
  createPostgresStore,
  runMigrations,
  type OperationalRecommendationRepository,
  type Repositories,
} from '@h3/db';
import {
  createDomainEvent,
  createUuidV7,
  parseUsdToMicrousd,
} from '@h3/domain';
import { buildApiApp } from './app.js';
import { DEV_TENANT_ID, ProjectApplicationService } from './application.js';
import type { OperationalPiAdapter } from './operator.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const controlPool = createDatabasePool(databaseUrl);
const databaseAvailable = await checkDatabaseReady(controlPool);
const schemaName = `h3_operator_${Date.now()}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;
if (databaseAvailable) {
  await controlPool.query(`CREATE SCHEMA "${schemaName}"`);
}
const pool = databaseAvailable
  ? createDatabasePool(databaseUrl, { searchPath: schemaName })
  : controlPool;
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

function internals(): { readonly operationalPiAdapter: OperationalPiAdapter } {
  return app as unknown as {
    readonly operationalPiAdapter: OperationalPiAdapter;
  };
}

beforeAll(async () => {
  if (databaseAvailable) await runMigrations(pool);
});

afterAll(async () => {
  await app.close();
  await closeDatabase(pool);
  if (databaseAvailable) {
    await controlPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    await closeDatabase(controlPool);
  }
});

describe.skipIf(!databaseAvailable)(
  'Phase 7E step 2 prerequisite: PostgreSQL UNIQUE_VIOLATION on operational_recommendations',
  () => {
    it('raises a genuine 23505 from create() with no recovery branch to catch it, and a later retry resolves cleanly', async () => {
      // `docs/75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md` step 2 prerequisite
      // finding: `operator.ts`'s UNIQUE_VIOLATION recovery branch was dead
      // code on PostgreSQL and has been deleted (operator.ts:774). This is
      // the PostgreSQL-side test step 1 could not write -- it proves the raw
      // error shape and the retry-based recovery this repository actually
      // relies on now.
      const defaultBudgetMicrousd = parseUsdToMicrousd('25.00');
      const projectService = new ProjectApplicationService({
        store,
        defaultBudgetMicrousd,
      });
      const project = await projectService.createProject({
        title: 'operator race project',
        brief: 'PostgreSQL UNIQUE_VIOLATION prerequisite test.',
        targetDurationSeconds: 3,
        budgetMicrousd: defaultBudgetMicrousd,
      });
      const projectId = project.id;

      const adapter = internals().operationalPiAdapter;
      const trigger = createDomainEvent({
        id: createUuidV7(),
        type: 'executor.unavailable',
        producer: 'operator-pg-test',
        tenantId: DEV_TENANT_ID,
        projectId,
        clock: { now: () => new Date() },
      });
      await store.withTransaction((repositories) =>
        repositories.events.append(trigger),
      );

      // A concurrent operator instance wins the race and commits first, for
      // real, against this PostgreSQL database.
      const winner = await adapter.processEvent(trigger);
      expect(winner.duplicate).toBe(false);
      const winnerId = winner.recommendation?.id;
      if (!winnerId) {
        throw new Error('Expected a persisted winning recommendation.');
      }

      // This instance's own existence check ran *before* the winner
      // committed -- the real TOCTOU window the deleted recovery branch used
      // to guard. Patching only that check (not `create`) reproduces the
      // race precisely: `create()` below is the real
      // `PostgresOperationalRecommendationRepository`, and it collides with
      // a row that genuinely exists in this database, not a fabricated
      // error.
      const raced = store.withTransaction(async (repositories) => {
        // A plain spread drops `PostgresOperationalRecommendationRepository`'s
        // methods -- they live on its prototype, not as own properties, so
        // `{...instance}` silently loses `create` and everything else. A
        // Proxy delegates every other member through untouched.
        const patchedRecommendations = new Proxy(
          repositories.operationalRecommendations,
          {
            get(target, prop, receiver) {
              if (prop === 'findByTriggerEventAndCode') {
                return async () => null;
              }
              return Reflect.get(target, prop, receiver);
            },
          },
        ) as OperationalRecommendationRepository;
        const patched: Repositories = {
          ...repositories,
          operationalRecommendations: patchedRecommendations,
        };
        return adapter.processEventInTransaction(patched, trigger);
      });
      await expect(raced).rejects.toMatchObject({ code: '23505' });

      // Nothing from the raced attempt survived its transaction's rollback:
      // still exactly the one winner, one recommendation.created event, and
      // one agent run.
      const recommendations = await store.withTransaction((repositories) =>
        repositories.recommendations.listByProject(DEV_TENANT_ID, projectId),
      );
      expect(recommendations).toHaveLength(1);
      expect(recommendations[0]?.id).toBe(winnerId);

      const events = await store.withTransaction((repositories) =>
        repositories.events.listByProject(projectId),
      );
      expect(
        events.filter(
          (candidate) => candidate.type === 'recommendation.created',
        ),
      ).toHaveLength(1);

      const runs = await store.withTransaction((repositories) =>
        repositories.agentRuns.listByProject(DEV_TENANT_ID, projectId),
      );
      expect(runs).toHaveLength(1);

      // A genuine retry -- unpatched -- takes the early `existing` return
      // and recovers cleanly, without re-running the model.
      const retried = await adapter.processEvent(trigger);
      expect(retried.duplicate).toBe(true);
      expect(retried.recommendation?.id).toBe(winnerId);
      const recommendationsAfterRetry = await store.withTransaction(
        (repositories) =>
          repositories.recommendations.listByProject(DEV_TENANT_ID, projectId),
      );
      expect(recommendationsAfterRetry).toHaveLength(1);
    });
  },
);
