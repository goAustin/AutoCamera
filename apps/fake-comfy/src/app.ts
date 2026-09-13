import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ComfyHealthResponse,
  type ComfyObjectInfoResponse,
  type ComfyScenario,
  type ComfySystemStatsResponse,
  DeterministicFakeComfyService,
  PINNED_OBJECT_INFO_PATH,
} from '@h3/comfy-client';
import { type FakeComfyConfig, getFakeComfyConfig } from '@h3/config';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

export interface FakeComfyAppOptions {
  readonly config?: FakeComfyConfig;
  readonly service?: DeterministicFakeComfyService;
  readonly objectInfo?: ComfyObjectInfoResponse;
  readonly frontendRoot?: string;
  readonly templateRoot?: string;
  readonly integrationRoot?: string;
  readonly studioOrigin?: string;
}

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
// One contract, owned by @h3/comfy-client — this app and the deterministic
// fake service must not be able to disagree about what the executor requires.
const defaultObjectInfoPath = PINNED_OBJECT_INFO_PATH;
const defaultFrontendRoot = resolve(
  repositoryRoot,
  '.data/comfy-frontend/dist',
);
const defaultTemplateRoot = resolve(repositoryRoot, '.data/workflow-templates');
const h3TemplatePath = 'templates/video_minimax_h3_t2v.json';
const frontendUnavailableMessage =
  'ComfyUI frontend build is not present. Run "pnpm comfy:frontend" to fetch and build the pinned frontend in .data/comfy-frontend/, then retry.';

const h3TemplateIndex = [
  {
    moduleName: 'default',
    category: 'GENERATION TYPE',
    title: 'Video',
    icon: 'icon-[lucide--film]',
    type: 'video',
    templates: [
      {
        name: 'video_minimax_h3_t2v',
        title: 'MiniMax H3: Text to Video',
        description:
          'Generate video with native stereo audio directly from a text prompt.',
        mediaType: 'image',
        mediaSubtype: 'webp',
        tags: ['Text to Video', 'Video'],
        models: ['MiniMax H3'],
        date: '2026-08-02',
        openSource: true,
        size: 56_908_316_672,
        usage: 8_893,
        searchRank: 1_000_000,
        username: 'ComfyUI',
        io: {
          outputs: [
            {
              nodeId: 92,
              nodeType: 'SaveVideo',
              file: 'video_minimax_h3_t2v.mp4',
              mediaType: 'video',
            },
          ],
        },
        thumbnail: ['output/video_minimax_h3_t2v.mp4'],
        minComfyUIVersion: '0.30.0',
      },
    ],
  },
] as const;

function pathFromEnvironment(
  value: string | undefined,
  fallback: string,
): string {
  if (!value) return fallback;
  return resolve(repositoryRoot, value);
}

function loadPinnedObjectInfo(): ComfyObjectInfoResponse {
  const path = pathFromEnvironment(
    process.env.H3_OBJECT_INFO_FIXTURE_PATH,
    defaultObjectInfoPath,
  );
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(value)) throw new Error('fixture is not a JSON object');
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Pinned ComfyUI object-info fixture is unavailable at ${path}: ${detail}`,
    );
  }
}

function hasRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function staticPath(root: string, pathname: string): string | undefined {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, decodedPath.replace(/^\/+/, ''));
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${sep}`)) {
    return undefined;
  }
  return candidate;
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.map':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

async function sendStaticFile(
  reply: FastifyReply,
  root: string,
  pathname: string,
): Promise<FastifyReply | undefined> {
  const path = staticPath(root, pathname);
  if (!path) return undefined;
  try {
    if (!statSync(path).isFile()) return undefined;
    return reply
      .type(contentType(path))
      .header(
        'cache-control',
        pathname.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      )
      .send(createReadStream(path));
  } catch {
    return undefined;
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function sendFrontendIndex(
  reply: FastifyReply,
  frontendRoot: string,
  studioOrigin: string | undefined,
): FastifyReply | undefined {
  const path = staticPath(frontendRoot, '/index.html');
  if (!path) return undefined;
  try {
    let html = readFileSync(path, 'utf8');
    if (studioOrigin) {
      const meta = `<meta name="videoops-studio-origin" content="${escapeHtmlAttribute(studioOrigin)}">`;
      html = /<head[^>]*>/iu.test(html)
        ? html.replace(/<head[^>]*>/iu, (head) => `${head}${meta}`)
        : `${meta}${html}`;
    }
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(html);
  } catch {
    return undefined;
  }
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

/**
 * Validate a submitted prompt against the pinned `object_info` the way the real
 * executor does. Checking only `class_type` lets a graph that ComfyUI rejects
 * pass here: `workflows/minimax-h3/api.json` was missing `UNETLoader`'s
 * required `weight_dtype` and every offline suite stayed green while the real
 * executor answered 400. The fixture already carries `input.required`, so the
 * contract to enforce is the one we captured, not a second-guess of it.
 */
function collectNodeErrors(
  objectInfo: Readonly<Record<string, unknown>>,
  prompt: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const nodeErrors: Record<string, unknown> = {};
  for (const [nodeId, node] of Object.entries(prompt)) {
    if (!isRecord(node) || typeof node.class_type !== 'string') {
      nodeErrors[nodeId] = { errors: ['node class_type is required'] };
      continue;
    }
    const spec = objectInfo[node.class_type];
    if (!isRecord(spec)) {
      nodeErrors[nodeId] = {
        class_type: node.class_type,
        errors: ['node class is not available'],
      };
      continue;
    }
    const required = isRecord(spec.input) ? spec.input.required : undefined;
    if (!isRecord(required)) continue;
    const inputs = isRecord(node.inputs) ? node.inputs : {};
    const missing = Object.keys(required).filter((name) => !(name in inputs));
    if (missing.length === 0) continue;
    nodeErrors[nodeId] = {
      class_type: node.class_type,
      errors: missing.map((name) => ({
        type: 'required_input_missing',
        message: 'Required input is missing',
        details: name,
        extra_info: { input_name: name },
      })),
    };
  }
  return nodeErrors;
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

function isBrowserMutation(request: {
  readonly headers: { readonly origin?: string | undefined };
}): boolean {
  return (
    typeof request.headers.origin === 'string' &&
    request.headers.origin.length > 0
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
    if (!request.url?.startsWith('/ws') && !request.url?.startsWith('/api/ws'))
      return;
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
  const objectInfo =
    options.objectInfo ??
    (options.service
      ? options.service.getObjectInfo()
      : loadPinnedObjectInfo());
  const service =
    options.service ?? new DeterministicFakeComfyService({ objectInfo });
  const frontendRoot = pathFromEnvironment(
    options.frontendRoot ?? process.env.COMFY_FRONTEND_DIST,
    defaultFrontendRoot,
  );
  const templateRoot = pathFromEnvironment(
    options.templateRoot ?? process.env.H3_WORKFLOW_TEMPLATE_ROOT,
    defaultTemplateRoot,
  );
  const integrationRoot = pathFromEnvironment(
    options.integrationRoot,
    resolve(repositoryRoot, 'integrations/comfyui-videoops/web'),
  );
  const studioOrigin =
    options.studioOrigin ??
    process.env.VIDEOOPS_STUDIO_ORIGIN ??
    'http://127.0.0.1:5173';
  const frontendAvailable = hasRegularFile(resolve(frontendRoot, 'index.html'));
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
  app.get('/', async (_request, reply) => {
    if (!frontendAvailable) {
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send(frontendUnavailableMessage);
    }
    return sendFrontendIndex(reply, frontendRoot, studioOrigin);
  });
  app.get('/features', async () => ({}));
  app.get('/api/features', async () => ({}));
  app.get('/extensions', async () => [
    '/extensions/comfyui-videoops/web/videoops.js',
  ]);
  app.get('/api/extensions', async () => [
    '/extensions/comfyui-videoops/web/videoops.js',
  ]);
  app.get('/extensions/comfyui-videoops/web/:file', async (request, reply) => {
    const params = request.params as { file?: string };
    const file = params.file;
    if (
      !file ||
      !['videoops.js', 'bridge-runtime.js', 'bridge-contract.js'].includes(file)
    ) {
      return reply.code(404).send({ error: 'extension asset not found' });
    }
    const response = await sendStaticFile(reply, integrationRoot, `/${file}`);
    return (
      response ?? reply.code(404).send({ error: 'extension asset not found' })
    );
  });
  app.get('/settings', async () => ({}));
  app.get('/api/settings', async () => ({}));
  app.get('/users', async () => ({}));
  app.get('/api/users', async () => ({}));
  app.get('/workflow_templates', async () => ({}));
  app.get('/api/workflow_templates', async () => ({}));
  app.get('/templates/index.json', async (_request, reply) =>
    reply.type('application/json; charset=utf-8').send(h3TemplateIndex),
  );
  app.get('/api/templates/index.json', async (_request, reply) =>
    reply.type('application/json; charset=utf-8').send(h3TemplateIndex),
  );
  app.get('/templates/video_minimax_h3_t2v.json', async (_request, reply) => {
    const response = await sendStaticFile(
      reply,
      templateRoot,
      `/${h3TemplatePath}`,
    );
    if (response) return response;
    return reply.code(404).send({ error: 'H3 workflow template not found.' });
  });
  app.get(
    '/api/templates/video_minimax_h3_t2v.json',
    async (_request, reply) => {
      const response = await sendStaticFile(
        reply,
        templateRoot,
        `/${h3TemplatePath}`,
      );
      if (response) return response;
      return reply.code(404).send({ error: 'H3 workflow template not found.' });
    },
  );
  app.get(
    '/system_stats',
    async (): Promise<ComfySystemStatsResponse> => service.getSystemStats(),
  );
  app.get(
    '/api/system_stats',
    async (): Promise<ComfySystemStatsResponse> => service.getSystemStats(),
  );
  app.get(
    '/object_info',
    async (): Promise<ComfyObjectInfoResponse> => objectInfo,
  );
  app.get(
    '/api/object_info',
    async (): Promise<ComfyObjectInfoResponse> => objectInfo,
  );

  app.post('/prompt', async (request, reply) => {
    if (isBrowserMutation(request)) {
      return reply.code(405).send({ error: 'browser queue disabled' });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const prompt = body.prompt;
    if (!isRecord(prompt)) {
      return reply.code(400).send({
        error: 'Prompt must be an object.',
        node_errors: {},
      });
    }
    const nodeErrors = collectNodeErrors(objectInfo, prompt);
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

  app.get('/api/prompt', async () => {
    return service.queueProtocol();
  });

  app.get('/queue', async () => service.queueProtocol());
  app.get('/api/queue', async () => service.queueProtocol());

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
  app.get('/api/history', async () =>
    Object.fromEntries(
      Object.values(service.histories()).flatMap((record) =>
        Object.entries(historyResponse(record)),
      ),
    ),
  );
  app.get('/api/history/:promptId', async (request, reply) => {
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
  app.get('/api/view', async (request, reply) => {
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
  app.post('/api/interrupt', async (request) => {
    const body = (request.body ?? {}) as { prompt_id?: unknown };
    service.cancel(
      typeof body.prompt_id === 'string' ? body.prompt_id : undefined,
    );
    return { ok: true };
  });

  app.post('/api/prompt', async (request, reply) => {
    if (isBrowserMutation(request)) {
      return reply.code(405).send({ error: 'browser queue disabled' });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const prompt = body.prompt;
    if (!isRecord(prompt)) {
      return reply.code(400).send({
        error: 'Prompt must be an object.',
        node_errors: {},
      });
    }
    const nodeErrors = collectNodeErrors(objectInfo, prompt);
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

  app.get('/ws', async (_request, reply) =>
    reply.code(426).send({ error: 'websocket upgrade required' }),
  );
  app.get('/api/ws', async (_request, reply) =>
    reply.code(426).send({ error: 'websocket upgrade required' }),
  );
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD') {
      let pathname: string;
      try {
        pathname = new URL(request.url, 'http://fake-comfy.local').pathname;
      } catch {
        pathname = request.url.split('?', 1)[0] ?? request.url;
      }
      if (frontendAvailable) {
        const staticResponse = await sendStaticFile(
          reply,
          frontendRoot,
          pathname,
        );
        if (staticResponse) return staticResponse;
      }
      if (frontendAvailable && !pathname.startsWith('/api/')) {
        const fallbackResponse = await sendStaticFile(
          reply,
          frontendRoot,
          '/index.html',
        );
        if (fallbackResponse) return fallbackResponse;
      }
    }
    return reply.code(404).send({ error: 'not found' });
  });
  attachWebSocket(app, service, config.authToken);

  return app;
}
