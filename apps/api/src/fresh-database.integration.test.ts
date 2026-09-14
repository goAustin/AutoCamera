import { describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import {
  checkDatabaseReady,
  createDatabasePool,
  createPostgresStore,
  runMigrations,
} from '@h3/db';
import { buildApiApp } from './app.js';

// CI failed on every push from 2026-09-04 onward and nothing here reproduced
// it, because a developer database has been mutated at least once and the row
// this exercises therefore already exists. `idempotency_records.tenant_id`
// references `tenants`, so the reservation that opens every mutation is the
// first write against that tenant -- and on a database where nothing has run
// yet, it failed the foreign key and returned 500 instead of creating the
// project. `startApi` seeds the tenant at boot and hid it; `buildApiApp` has
// no such prologue, which is what CI and every integration test build.
//
// A scratch schema is the only honest fixture for "nothing has run yet": it
// is empty the way a newly provisioned database is, and it is dropped again
// without touching the shared one. Same pattern as migration-0009's tests.

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const controlPool = createDatabasePool(databaseUrl);
const databaseAvailable = await checkDatabaseReady(controlPool);

describe.skipIf(!databaseAvailable)('a freshly provisioned database', () => {
  it('accepts the first mutation it is ever asked to perform', async () => {
    const schemaName = `h3_fresh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await controlPool.query(`CREATE SCHEMA "${schemaName}"`);
    const pool = createDatabasePool(databaseUrl, { searchPath: schemaName });
    try {
      await runMigrations(pool);
      const app = buildApiApp({
        config: getApiConfig({
          NODE_ENV: 'test',
          DEV_AUTH_TOKEN: 'test-secret',
          DATABASE_URL: databaseUrl,
        }),
        databaseReady: () => checkDatabaseReady(pool),
        store: createPostgresStore(pool),
      });

      const created = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: {
          authorization: 'Bearer test-secret',
          'idempotency-key': 'fresh-database-first-project',
        },
        payload: {
          title: 'First project on a new database',
          brief: 'The first mutation a newly provisioned deployment receives.',
          targetDurationSeconds: 15,
          budgetUsd: '25.00',
        },
      });
      expect(created.statusCode).toBe(201);

      // The tenants row is created once and reused, not re-created per
      // request: a second mutation must still be a normal 201, not a
      // duplicate-key failure from the ensure above.
      const second = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: {
          authorization: 'Bearer test-secret',
          'idempotency-key': 'fresh-database-second-project',
        },
        payload: {
          title: 'Second project on the same database',
          brief: 'Proves the tenant prologue is an upsert, not an insert.',
          targetDurationSeconds: 15,
          budgetUsd: '25.00',
        },
      });
      expect(second.statusCode).toBe(201);

      const tenants = await pool.query<{ count: string }>(
        'SELECT count(*) FROM tenants',
      );
      expect(Number(tenants.rows[0]?.count)).toBe(1);

      await app.close();
    } finally {
      await pool.end();
      await controlPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    }
  });
});
