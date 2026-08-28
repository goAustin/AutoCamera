import { afterEach, describe, expect, it } from 'vitest';
import { getFakeComfyConfig } from '@h3/config';
import { buildFakeComfyApp } from './app.js';

describe('fake ComfyUI shell', () => {
  let app: ReturnType<typeof buildFakeComfyApp> | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('returns stable health and object information responses', async () => {
    app = buildFakeComfyApp({
      config: getFakeComfyConfig({ NODE_ENV: 'test' }),
    });

    const health = await app.inject({ method: 'GET', url: '/health' });
    const objectInfo = await app.inject({ method: 'GET', url: '/object_info' });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ service: 'fake-comfy', status: 'ok' });
    expect(objectInfo.statusCode).toBe(200);
    expect(objectInfo.json()).toEqual({ nodes: {} });
  });
});
