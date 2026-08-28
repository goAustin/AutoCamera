import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDatabaseReady,
  closeDatabase,
  createDatabasePool,
  runMigrations,
} from './index.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const pool = createDatabasePool(databaseUrl);

beforeAll(async () => {
  await runMigrations(pool);
});

afterAll(async () => {
  await closeDatabase(pool);
});

describe('PostgreSQL readiness', () => {
  it('answers SELECT 1 and remains usable after the migration placeholder', async () => {
    expect(await checkDatabaseReady(pool)).toBe(true);
  });
});
