import { afterEach, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import { buildApiApp } from './app.js';

const apps = new Set<Awaited<ReturnType<typeof buildApiApp>>>();

afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  apps.clear();
});

describe('API health routes', () => {
  it('serves live health without touching PostgreSQL', async () => {
    let databaseWasChecked = false;
    const app = buildApiApp({
      config: getApiConfig({ NODE_ENV: 'test' }),
      databaseReady: async () => {
        databaseWasChecked = true;
        return true;
      },
    });
    apps.add(app);

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: 'api', status: 'ok' });
    expect(databaseWasChecked).toBe(false);
  });

  it('reflects database readiness and recovers when the database returns', async () => {
    let available = false;
    const app = buildApiApp({
      config: getApiConfig({ NODE_ENV: 'test' }),
      databaseReady: async () => available,
    });
    apps.add(app);

    const unavailable = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({
      service: 'api',
      status: 'degraded',
      dependencies: { postgres: 'unavailable' },
    });

    available = true;
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      service: 'api',
      status: 'ok',
      dependencies: { postgres: 'ok' },
    });
  });
});
