import Fastify, { type FastifyInstance } from 'fastify';
import {
  EMPTY_OBJECT_INFO,
  type ComfyHealthResponse,
  type ComfyObjectInfoResponse,
} from '@h3/comfy-client';
import { getFakeComfyConfig, type FakeComfyConfig } from '@h3/config';

export interface FakeComfyAppOptions {
  readonly config?: FakeComfyConfig;
}

export function buildFakeComfyApp(
  options: FakeComfyAppOptions = {},
): FastifyInstance {
  const config = options.config ?? getFakeComfyConfig();
  const app = Fastify({ logger: { level: config.logLevel } });

  const health = async (): Promise<ComfyHealthResponse> => ({
    service: 'fake-comfy',
    status: 'ok',
  });

  app.get('/health', health);
  app.get('/health/live', health);
  app.get(
    '/object_info',
    async (): Promise<ComfyObjectInfoResponse> => EMPTY_OBJECT_INFO,
  );

  return app;
}
