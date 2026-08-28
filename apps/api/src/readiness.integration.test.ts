import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import {
  checkDatabaseReady,
  closeDatabase,
  createDatabasePool,
  runMigrations,
} from '@h3/db';
import { buildApiApp } from './app.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const pool = createDatabasePool(databaseUrl);
const app = buildApiApp({
  config: getApiConfig({ NODE_ENV: 'test' }),
  databaseReady: () => checkDatabaseReady(pool),
});

beforeAll(async () => {
  await runMigrations(pool);
});

afterAll(async () => {
  await app.close();
  await closeDatabase(pool);
});

describe('API PostgreSQL readiness integration', () => {
  it('reports ready through the HTTP route when SELECT 1 succeeds', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: 'api',
      status: 'ok',
      dependencies: { postgres: 'ok' },
    });
  });
});
