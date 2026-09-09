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
} from '@h3/domain';
import { buildApiApp } from './app.js';
import { DEV_TENANT_ID, ProjectApplicationService } from './application.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const controlPool = createDatabasePool(databaseUrl);
const databaseAvailable = await checkDatabaseReady(controlPool);
const schemaName = `h3_notify_${Date.now()}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;
if (databaseAvailable) {
  await controlPool.query(`CREATE SCHEMA "${schemaName}"`);
}
const pool = databaseAvailable
  ? createDatabasePool(databaseUrl, { searchPath: schemaName })
  : controlPool;
// A second pool means a second connection, so it can only ever see rows the
// claim transaction has already committed. That is the whole measurement.
const observerPool = databaseAvailable
  ? createDatabasePool(databaseUrl, { searchPath: schemaName })
  : controlPool;
const store = createPostgresStore(pool);

// Every delivery appends what a second connection could see at that moment.
// Recording all of them, not just the last, is what makes this test fail if
// delivery ever moves back inside the claim transaction: the pre-fix ordering
// delivers twice, and only the later one sees a committed row.
const rowsVisiblePerDelivery: number[] = [];

const app = buildApiApp({
  config: getApiConfig({
    NODE_ENV: 'test',
    DEV_AUTH_TOKEN: 'test-secret',
    DATABASE_URL: databaseUrl,
    NOTIFY_WEBHOOK_URL: 'https://hooks.example.test/h3',
  }),
  databaseReady: () => checkDatabaseReady(pool),
  store,
  notifyFetchImpl: (async () => {
    const result = await observerPool.query(
      'SELECT count(*)::int AS total FROM operational_recommendations',
    );
    rowsVisiblePerDelivery.push(result.rows[0].total as number);
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch,
});

function dispatcher(): { pollOnce(): Promise<boolean> } {
  return (
    app as unknown as {
      operationalDispatcher: { pollOnce(): Promise<boolean> };
    }
  ).operationalDispatcher;
}

beforeAll(async () => {
  if (databaseAvailable) await runMigrations(pool);
});

afterAll(async () => {
  await app.close();
  await closeDatabase(pool);
  if (databaseAvailable) {
    await closeDatabase(observerPool);
    await controlPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    await closeDatabase(controlPool);
  }
});

describe.skipIf(!databaseAvailable)(
  'Phase 7E step 2 prerequisite: the webhook POST runs outside the outbox transaction',
  () => {
    it('has already committed the finding when delivery reaches the webhook', async () => {
      // Before the fix, delivery ran inside the claim transaction and this
      // count was 0 -- the finding was invisible to every other connection
      // for the whole round trip, and the outbox row stayed locked behind it.
      const defaultBudgetMicrousd = parseUsdToMicrousd('25.00');
      const project = await new ProjectApplicationService({
        store,
        defaultBudgetMicrousd,
      }).createProject({
        title: 'notify transaction boundary',
        brief: 'Delivery must not hold the outbox transaction open.',
        targetDurationSeconds: 3,
        budgetMicrousd: defaultBudgetMicrousd,
      });

      // Drain the project-creation traffic before measuring.
      for (let count = 0; count < 50; count += 1) {
        if (!(await dispatcher().pollOnce())) break;
      }
      rowsVisiblePerDelivery.length = 0;

      const trigger = createDomainEvent({
        id: createUuidV7(),
        type: 'executor.unavailable',
        producer: 'notify-pg-test',
        tenantId: DEV_TENANT_ID,
        projectId: project.id,
        clock: { now: () => new Date() },
      });
      await store.withTransaction(async (repositories) => {
        await repositories.events.append(trigger);
        await repositories.outbox.enqueue(trigger);
      });

      // Message 1: the trigger. The operator writes the finding, the
      // transaction commits, and only then does executor.unavailable notify.
      expect(await dispatcher().pollOnce()).toBe(true);
      expect(rowsVisiblePerDelivery).toEqual([1]);

      // Message 2: recommendation.created, whose body reads the finding back
      // through the consumer's own store rather than a claim transaction.
      rowsVisiblePerDelivery.length = 0;
      expect(await dispatcher().pollOnce()).toBe(true);
      expect(rowsVisiblePerDelivery).toEqual([1]);

      expect(await dispatcher().pollOnce()).toBe(false);
    });
  },
);
