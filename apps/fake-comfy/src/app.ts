import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  DeterministicFakeComfyService,
  type ComfyHealthResponse,
  type ComfyScenario,
  type ComfyObjectInfoResponse,
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

function historyResponse(
  record: ReturnType<DeterministicFakeComfyService['history']>,
): Record<string, unknown> {
  if (!record) return {};
  const outputs =
    record.outputs.length > 0 ? { '4': { videos: record.outputs } } : {};
  return {
    [record.promptId]: {
      prompt: [0, record.extraData, {}, {}, []],
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
): void {
  app.server.on('upgrade', (request, socket) => {
    if (!request.url?.startsWith('/ws')) return;
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
  const app = Fastify({ logger: { level: config.logLevel } });

  const health = async (): Promise<ComfyHealthResponse> => ({
    service: 'fake-comfy',
    status: 'ok',
  });

  app.get('/health', health);
  app.get('/health/live', health);
  app.get(
    '/object_info',
    async (): Promise<ComfyObjectInfoResponse> => service.getObjectInfo(),
  );

  app.post('/prompt', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const extraData =
      typeof body.extra_data === 'object' && body.extra_data !== null
        ? (body.extra_data as Record<string, unknown>)
        : {};
    try {
      const submission = service.submit({
        workflow:
          typeof body.prompt === 'object' && body.prompt !== null
            ? (body.prompt as Record<string, unknown>)
            : {},
        extraData,
        ...(typeof body.client_id === 'string'
          ? { clientId: body.client_id }
          : {}),
        scenario: scenario(extraData.scenario ?? body.scenario),
        ...(typeof extraData.seed === 'number' ? { seed: extraData.seed } : {}),
      });
      return reply.send({
        prompt_id: submission.promptId,
        number: 0,
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
    const queue = service.queue();
    return {
      queue_pending: queue.queuePending,
      queue_running: queue.queueRunning,
    };
  });

  app.get('/history', async () => service.histories());
  app.get('/history/:promptId', async (request, reply) => {
    const params = request.params as { promptId?: string };
    const record = params.promptId ? service.history(params.promptId) : null;
    if (!record) return reply.code(404).send({ error: 'not found' });
    return reply.send(historyResponse(record));
  });

  app.get('/view', async (request, reply) => {
    const query = request.query as { filename?: string };
    if (!query.filename)
      return reply.code(400).send({ error: 'filename required' });
    try {
      const output = service.output({
        filename: query.filename,
        subfolder: '',
        type: 'output',
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
  attachWebSocket(app, service);

  return app;
}
