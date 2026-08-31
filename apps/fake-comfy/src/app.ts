import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  DeterministicFakeComfyService,
  type ComfyHealthResponse,
  type ComfyScenario,
  type ComfyObjectInfoResponse,
  type ComfySystemStatsResponse,
} from '@h3/comfy-client';
import { getFakeComfyConfig, type FakeComfyConfig } from '@h3/config';

export interface FakeComfyAppOptions {
  readonly config?: FakeComfyConfig;
  readonly service?: DeterministicFakeComfyService;
}

function scenario(value: unknown): ComfyScenario {
  if (
    value === 'success' ||
    value === 'duplicate-events' ||
    value === 'disconnect-reconcile' ||
    value === 'execution-failure' ||
    value === 'timeout' ||
    value === 'uncertain-submission'
  ) {
    return value;
  }
  return 'success';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function historyResponse(
  record: ReturnType<DeterministicFakeComfyService['history']>,
): Record<string, unknown> {
  if (!record) return {};
  const outputs =
    record.outputs.length > 0
      ? {
          '4': {
            videos: record.outputs.map(
              ({ filename, subfolder, type, format }) => ({
                filename,
                subfolder,
                type,
                ...(format ? { format } : {}),
              }),
            ),
          },
        }
      : {};
  return {
    [record.promptId]: {
      prompt: [0, record.promptId, record.workflow ?? {}, record.extraData, []],
      extra_data: record.extraData,
      outputs,
      status: {
        completed: record.completed,
        status_str: record.status,
      },
      ...(record.errorCode ? { exception_type: record.errorCode } : {}),
      ...(record.errorMessage
        ? { exception_message: record.errorMessage }
        : {}),
    },
  };
}

function authorizeUpgrade(
  request: {
    readonly headers: {
      readonly authorization?: string | string[] | undefined;
    };
  },
  authToken: string | undefined,
): boolean {
  return (
    !authToken ||
    (typeof request.headers.authorization === 'string' &&
      request.headers.authorization === `Bearer ${authToken}`)
  );
}

function writeWebSocketFrame(
  socket: NodeJS.WritableStream,
  value: string,
): void {
  const payload = Buffer.from(value, 'utf8');
  if (payload.length < 126) {
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    return;
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  socket.write(Buffer.concat([header, payload]));
}

function attachWebSocket(
  app: FastifyInstance,
  service: DeterministicFakeComfyService,
  authToken: string | undefined,
): void {
  app.server.on('upgrade', (request, socket) => {
    if (!request.url?.startsWith('/ws')) return;
    if (!authorizeUpgrade(request, authToken)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = Buffer.from(
      `${key.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
      'utf8',
    );
    const digest = createHash('sha1').update(accept).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${digest}`,
        '\r\n',
      ].join('\r\n'),
    );
    const query = new URL(request.url, 'http://fake-comfy.local').searchParams;
    const queue = service.queue();
    writeWebSocketFrame(
      socket,
      JSON.stringify({
        type: 'status',
        data: {
          status: {
            exec_info: {
              queue_remaining:
                queue.queuePending.length + queue.queueRunning.length,
            },
          },
          sid: query.get('clientId'),
        },
      }),
    );
    for (const event of service.eventsSnapshot()) {
      writeWebSocketFrame(socket, JSON.stringify(event.message));
    }
    const unsubscribe = service.addListener((_promptId, message) => {
      writeWebSocketFrame(socket, JSON.stringify(message));
    });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
    socket.on('data', (chunk: Buffer) => {
      if (chunk.length >= 2 && (chunk[0] ?? 0) === 0x88) {
        unsubscribe();
        socket.end();
      }
    });
  });
}

export function buildFakeComfyApp(
  options: FakeComfyAppOptions = {},
): FastifyInstance {
  const config = options.config ?? getFakeComfyConfig();
  const service = options.service ?? new DeterministicFakeComfyService();
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

  const health = async (): Promise<ComfyHealthResponse> => ({
    service: 'fake-comfy',
    status: 'ok',
  });

  app.get('/health', health);
  app.get('/health/live', health);
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/health')) return;
    if (authorizeUpgrade(request, config.authToken)) return;
    return reply.code(401).send({ error: 'unauthorized' });
  });
  app.get(
    '/system_stats',
    async (): Promise<ComfySystemStatsResponse> => service.getSystemStats(),
  );
  app.get(
    '/object_info',
    async (): Promise<ComfyObjectInfoResponse> => service.getObjectInfo(),
  );

  app.post('/prompt', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const prompt = body.prompt;
    if (!isRecord(prompt)) {
      return reply.code(400).send({
        error: 'Prompt must be an object.',
        node_errors: {},
      });
    }
    const availableClasses = new Set(Object.keys(service.getObjectInfo()));
    const nodeErrors: Record<string, unknown> = {};
    for (const [nodeId, node] of Object.entries(prompt)) {
      if (!isRecord(node) || typeof node.class_type !== 'string') {
        nodeErrors[nodeId] = { errors: ['node class_type is required'] };
      } else if (!availableClasses.has(node.class_type)) {
        nodeErrors[nodeId] = {
          class_type: node.class_type,
          errors: ['node class is not available'],
        };
      }
    }
    if (Object.keys(nodeErrors).length > 0) {
      return reply.code(400).send({
        error: 'Prompt validation failed.',
        node_errors: nodeErrors,
      });
    }
    const extraData =
      typeof body.extra_data === 'object' && body.extra_data !== null
        ? (body.extra_data as Record<string, unknown>)
        : {};
    try {
      const submission = service.submit({
        workflow: prompt,
        extraData,
        ...(typeof body.client_id === 'string'
          ? { clientId: body.client_id }
          : {}),
        scenario: scenario(extraData.scenario ?? body.scenario),
        ...(typeof extraData.seed === 'number' ? { seed: extraData.seed } : {}),
      });
      return reply.send({
        prompt_id: submission.promptId,
        number: submission.queueNumber ?? 0,
        node_errors: {},
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'ComfySubmissionUncertainError'
      ) {
        return reply.code(504).send({ error: 'submission outcome uncertain' });
      }
      throw error;
    }
  });

  app.get('/prompt', async () => {
    return service.queueProtocol();
  });

  app.get('/queue', async () => service.queueProtocol());

  app.get('/history', async () =>
    Object.fromEntries(
      Object.values(service.histories()).flatMap((record) =>
        Object.entries(historyResponse(record)),
      ),
    ),
  );
  app.get('/history/:promptId', async (request, reply) => {
    const params = request.params as { promptId?: string };
    const record = params.promptId ? service.history(params.promptId) : null;
    if (!record) return reply.send({});
    return reply.send(historyResponse(record));
  });

  app.get('/view', async (request, reply) => {
    const query = request.query as {
      filename?: string;
      subfolder?: string;
      type?: string;
    };
    if (!query.filename)
      return reply.code(400).send({ error: 'filename required' });
    try {
      const output = service.output({
        filename: query.filename,
        subfolder: query.subfolder ?? '',
        type: query.type ?? 'output',
        mimeType: 'video/mp4',
      });
      return reply.type('video/mp4').send(Buffer.from(output));
    } catch {
      return reply.code(404).send({ error: 'output not found' });
    }
  });

  app.post('/interrupt', async (request) => {
    const body = (request.body ?? {}) as { prompt_id?: unknown };
    service.cancel(
      typeof body.prompt_id === 'string' ? body.prompt_id : undefined,
    );
    return { ok: true };
  });

  app.get('/ws', async (_request, reply) =>
    reply.code(426).send({ error: 'websocket upgrade required' }),
  );
  attachWebSocket(app, service, config.authToken);

  return app;
}
