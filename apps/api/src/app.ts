import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { getApiConfig, type ApiConfig } from '@h3/config';
import { checkDatabaseReady, createDatabasePool } from '@h3/db';

export interface ApiLiveResponse {
  readonly service: 'api';
  readonly status: 'ok';
}

export interface ApiReadyResponse {
  readonly service: 'api';
  readonly status: 'ok' | 'degraded';
  readonly dependencies: {
    readonly postgres: 'ok' | 'unavailable';
  };
}

export interface ApiAppOptions {
  readonly config?: ApiConfig;
  readonly databaseReady?: () => Promise<boolean>;
}

export function buildApiApp(options: ApiAppOptions = {}): FastifyInstance {
  const config = options.config ?? getApiConfig();
  const databaseReady = options.databaseReady ?? (async () => false);

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
      ],
    },
  });

  void app.register(cors, { origin: config.webOrigin });
  void app.register(swagger, {
    openapi: {
      info: {
        title: 'H3 VideoOps API',
        description: 'Phase 1 bootstrap endpoints.',
        version: '0.1.0',
      },
    },
  });
  void app.register(swaggerUi, { routePrefix: '/documentation' });

  app.get(
    '/health/live',
    async (): Promise<ApiLiveResponse> => ({
      service: 'api',
      status: 'ok',
    }),
  );

  app.get(
    '/health/ready',
    async (_request, reply): Promise<ApiReadyResponse | FastifyReply> => {
      let ready = false;

      try {
        ready = await databaseReady();
      } catch {
        ready = false;
      }

      const response: ApiReadyResponse = ready
        ? {
            service: 'api',
            status: 'ok',
            dependencies: { postgres: 'ok' },
          }
        : {
            service: 'api',
            status: 'degraded',
            dependencies: { postgres: 'unavailable' },
          };

      if (!ready) {
        return reply.code(503).send(response);
      }

      return response;
    },
  );

  return app;
}

export async function startApi(
  config: ApiConfig = getApiConfig(),
): Promise<FastifyInstance> {
  const pool = createDatabasePool(config.databaseUrl);
  const app = buildApiApp({
    config,
    databaseReady: () => checkDatabaseReady(pool),
  });

  app.addHook('onClose', async () => {
    await pool.end();
  });

  await app.listen({ host: config.apiHost, port: config.apiPort });
  return app;
}
