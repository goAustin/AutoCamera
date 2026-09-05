import { afterEach, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import { HttpWsComfyClient } from '@h3/comfy-client';
import { buildApiApp, createConfiguredComfyClient } from './app.js';

const apps = new Set<Awaited<ReturnType<typeof buildApiApp>>>();

afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  apps.clear();
});

describe('API health routes', () => {
  it('injects the configured HTTP/WebSocket client in both Comfy modes', () => {
    const fakeConfig = getApiConfig({ NODE_ENV: 'test' });
    const remoteConfig = getApiConfig({
      NODE_ENV: 'test',
      COMFY_MODE: 'remote',
      COMFY_BASE_URL: 'https://comfy.example.test',
      COMFY_WS_URL: 'wss://comfy.example.test/ws',
      COMFY_FRONTEND_URL: 'https://comfy.example.test',
    });

    expect(createConfiguredComfyClient(fakeConfig)).toBeInstanceOf(
      HttpWsComfyClient,
    );
    expect(createConfiguredComfyClient(remoteConfig)).toBeInstanceOf(
      HttpWsComfyClient,
    );
  });

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

  it('allows browser preflight for workflow draft updates', async () => {
    const app = buildApiApp({ config: getApiConfig({ NODE_ENV: 'test' }) });
    apps.add(app);

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/projects/00000000-0000-7000-8000-000000000001/shots/00000000-0000-7000-8000-000000000002/workflow-draft',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'PUT',
        'access-control-request-headers':
          'authorization,content-type,idempotency-key',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain('PUT');
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
