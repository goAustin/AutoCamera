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
  type IdGenerator,
} from '@h3/domain';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { InMemoryTelemetry } from '@h3/telemetry';
import { buildApiApp } from './app.js';
import { DEV_TENANT_ID, ProjectApplicationService } from './application.js';
import {
  createOperationalToolServices,
  OperationalPiAdapter,
} from './operator.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const controlPool = createDatabasePool(databaseUrl);
const databaseAvailable = await checkDatabaseReady(controlPool);
const schemaName = `h3_operator_deferred_${Date.now()}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;
if (databaseAvailable) {
  await controlPool.query(`CREATE SCHEMA "${schemaName}"`);
}
const pool = databaseAvailable
  ? createDatabasePool(databaseUrl, { searchPath: schemaName })
  : controlPool;
// A second pool means a second connection, so it can only ever see rows the
// claim transaction has already committed. That is the whole measurement
// (mirrors apps/api/src/notify.integration.test.ts, for the model call
// instead of the webhook POST -- 75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md
// step 3).
const observerPool = databaseAvailable
  ? createDatabasePool(databaseUrl, { searchPath: schemaName })
  : controlPool;
const store = createPostgresStore(pool);
const telemetry = new InMemoryTelemetry();

// Every model call appends the count of 'running' agent_runs rows a second
// connection could see at that moment. Recording all of them, not just the
// last, is what makes this test fail if the call ever moves back inside the
// claim transaction: the pre-fix ordering would show 0 while the claim
// transaction that inserted the row is still open, and only a later,
// unrelated call might happen to see committed state.
const runningRowsVisiblePerCall: number[] = [];

const faux = fauxProvider({
  provider: 'deepseek-test-stub',
  models: [{ id: 'stub-model', name: 'stub-model' }],
});
const streamFnOverride: StreamFn = async (model, context, options) => {
  const result = await observerPool.query(
    "SELECT count(*)::int AS total FROM agent_runs WHERE status = 'running'",
  );
  runningRowsVisiblePerCall.push(result.rows[0].total as number);
  return faux.provider.streamSimple(model, context, options);
};

const idGenerator: IdGenerator = { next: () => createUuidV7() };

const operationalAdapter = new OperationalPiAdapter({
  store,
  tenantId: DEV_TENANT_ID,
  idGenerator,
  telemetry,
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  apiKey: 'test-deepseek-key',
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

const app = buildApiApp({
  config: getApiConfig({
    NODE_ENV: 'test',
    DEV_AUTH_TOKEN: 'test-secret',
    DATABASE_URL: databaseUrl,
  }),
  databaseReady: () => checkDatabaseReady(pool),
  store,
  telemetry,
  operationalAdapter,
});

function dispatcher(): { pollOnce(): Promise<boolean> } {
  return (
    app as unknown as {
      operationalDispatcher: { pollOnce(): Promise<boolean> };
    }
  ).operationalDispatcher;
}

function validRecommendationCall() {
  return fauxAssistantMessage([
    fauxToolCall('submit_recommendation', {
      severity: 'critical',
      recommendationCode: 'EXECUTOR_UNAVAILABLE',
      title: 'Wait for the executor to recover',
      detail: 'The execution service is unavailable; wait before retrying.',
      proposedActionType: 'wait_for_executor',
    }),
  ]);
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
  'Phase 7E step 3: the non-faux model call runs outside the outbox transaction',
  () => {
    it('has already committed the running agent_runs row when the model call starts, across two separate triggers', async () => {
      const defaultBudgetMicrousd = parseUsdToMicrousd('25.00');
      const project = await new ProjectApplicationService({
        store,
        defaultBudgetMicrousd,
      }).createProject({
        title: 'operator deferred transaction boundary',
        brief: 'The model call must not hold the outbox transaction open.',
        targetDurationSeconds: 3,
        budgetMicrousd: defaultBudgetMicrousd,
      });

      // Drain project-creation traffic before measuring.
      for (let count = 0; count < 50; count += 1) {
        if (!(await dispatcher().pollOnce())) break;
      }
      runningRowsVisiblePerCall.length = 0;
      faux.setResponses([validRecommendationCall(), validRecommendationCall()]);

      const triggerOne = createDomainEvent({
        id: createUuidV7(),
        type: 'executor.unavailable',
        producer: 'operator-deferred-pg-test',
        tenantId: DEV_TENANT_ID,
        projectId: project.id,
        clock: { now: () => new Date() },
      });
      await store.withTransaction(async (repositories) => {
        await repositories.events.append(triggerOne);
        await repositories.outbox.enqueue(triggerOne);
      });

      // pollOnce claims the trigger, commits the 'running' agent_runs row,
      // and only then (afterCommit) calls the model -- which is where
      // streamFnOverride above queries the second connection.
      expect(await dispatcher().pollOnce()).toBe(true);
      // The recommendation.created message the run above enqueued: not a
      // trigger, so this drains it with no further model call.
      expect(await dispatcher().pollOnce()).toBe(true);

      const triggerTwo = createDomainEvent({
        id: createUuidV7(),
        type: 'executor.unavailable',
        producer: 'operator-deferred-pg-test',
        tenantId: DEV_TENANT_ID,
        projectId: project.id,
        clock: { now: () => new Date() },
      });
      await store.withTransaction(async (repositories) => {
        await repositories.events.append(triggerTwo);
        await repositories.outbox.enqueue(triggerTwo);
      });
      expect(await dispatcher().pollOnce()).toBe(true);
      expect(await dispatcher().pollOnce()).toBe(true);

      expect(await dispatcher().pollOnce()).toBe(false);

      // Exactly one model call per trigger, and in every one of them the
      // second connection already saw the committed 'running' row -- never
      // 0, which is what the pre-fix, in-transaction ordering would show.
      expect(runningRowsVisiblePerCall).toEqual([1, 1]);
    });
  },
);
