import { createHash } from 'node:crypto';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import {
  DomainError,
  formatMicrousdToUsd,
  assertMicrousd,
  parseUsdToMicrousd,
  toIsoUtc,
  type Clock,
  type DomainEvent,
  type IdGenerator,
  type MicroUsd,
  type Shot,
  type StoryboardProposal,
  type Uuid,
  type VideoProject,
} from '@h3/domain';
import {
  checkDatabaseReady,
  createDatabasePool,
  createInMemoryStore,
  createPostgresStore,
  RepositoryError,
  runMigrations,
  type Repositories,
  type TransactionalStore,
} from '@h3/db';
import { getApiConfig, type ApiConfig } from '@h3/config';
import { createTraceId } from '@h3/telemetry';
import {
  ApplicationError,
  DEV_TENANT_ID,
  ProjectApplicationService,
  StaticStoryboardPlanner,
  type PlanningAgent,
} from './application.js';

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

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly traceId: string;
  readonly retryable: boolean;
}

export interface ApiAppOptions {
  readonly config?: ApiConfig;
  readonly databaseReady?: () => Promise<boolean>;
  readonly store?: TransactionalStore;
  readonly planner?: PlanningAgent;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
}

class HttpProblemError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly exposeDetail: boolean;

  constructor(
    code: string,
    message: string,
    status: number,
    retryable: boolean,
    exposeDetail = true,
  ) {
    super(message);
    this.name = 'HttpProblemError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.exposeDetail = exposeDetail;
  }
}

const createProjectBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    brief: z.string().trim().min(1).max(20_000),
    targetDurationSeconds: z.number().finite().min(3).max(3_600),
    budgetUsd: z.union([z.string(), z.number()]).optional(),
    budgetMicrousd: z.number().int().nonnegative().optional(),
  })
  .strict();

const approveStoryboardBodySchema = z
  .object({ proposalId: z.string().uuid().optional() })
  .strict();

type CreateProjectBody = z.infer<typeof createProjectBodySchema>;
type ApproveStoryboardBody = z.infer<typeof approveStoryboardBodySchema>;

const projectJsonSchema = {
  type: 'object',
  required: [
    'id',
    'tenantId',
    'title',
    'brief',
    'status',
    'targetDurationSeconds',
    'budgetMicrousd',
    'spentMicrousd',
    'version',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    brief: { type: 'string' },
    status: { type: 'string' },
    targetDurationSeconds: { type: 'number' },
    budgetMicrousd: { type: 'integer' },
    budgetUsd: { type: 'string' },
    spentMicrousd: { type: 'integer' },
    spentUsd: { type: 'string' },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const shotJsonSchema = {
  type: 'object',
  required: [
    'id',
    'projectId',
    'storyboardProposalId',
    'ordinal',
    'purpose',
    'prompt',
    'durationSeconds',
    'mode',
    'qualityTier',
    'status',
    'version',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    storyboardProposalId: { type: 'string', format: 'uuid' },
    ordinal: { type: 'integer', minimum: 1, maximum: 3 },
    purpose: { type: 'string' },
    prompt: { type: 'string' },
    durationSeconds: { type: 'number', exclusiveMinimum: 0 },
    mode: { type: 'string', enum: ['t2v'] },
    qualityTier: { type: 'string', enum: ['preview'] },
    status: { type: 'string' },
    acceptedAttemptId: { type: 'string', format: 'uuid' },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const eventJsonSchema = {
  type: 'object',
  required: [
    'id',
    'type',
    'version',
    'occurredAt',
    'observedAt',
    'producer',
    'tenantId',
    'payload',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    type: { type: 'string' },
    version: { type: 'integer' },
    occurredAt: { type: 'string', format: 'date-time' },
    observedAt: { type: 'string', format: 'date-time' },
    producer: { type: 'string' },
    tenantId: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    shotId: { type: 'string', format: 'uuid' },
    attemptId: { type: 'string', format: 'uuid' },
    promptId: { type: 'string' },
    traceId: { type: 'string' },
    payload: { type: 'object' },
  },
} as const;

const proposalJsonSchema = {
  type: 'object',
  required: [
    'id',
    'projectId',
    'revision',
    'status',
    'shots',
    'totalDurationSeconds',
    'durationToleranceSeconds',
    'version',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    revision: { type: 'integer' },
    status: { type: 'string' },
    shots: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'ordinal',
          'purpose',
          'prompt',
          'durationSeconds',
          'mode',
          'qualityTier',
        ],
        properties: {
          ordinal: { type: 'integer', minimum: 1, maximum: 3 },
          purpose: { type: 'string' },
          prompt: { type: 'string' },
          durationSeconds: { type: 'number', exclusiveMinimum: 0 },
          mode: { type: 'string', enum: ['t2v'] },
          qualityTier: { type: 'string', enum: ['preview'] },
        },
      },
    },
    totalDurationSeconds: { type: 'number' },
    durationToleranceSeconds: { type: 'number' },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

function requestHash(operation: string, body: unknown): string {
  return createHash('sha256')
    .update(`${operation}\n${canonicalize(body)}`)
    .digest('hex');
}

function projectResponse(project: VideoProject): Record<string, unknown> {
  return {
    id: project.id,
    tenantId: project.tenantId,
    title: project.title,
    brief: project.brief,
    status: project.status,
    targetDurationSeconds: project.targetDurationSeconds,
    budgetMicrousd: project.budgetMicrousd,
    budgetUsd: formatMicrousdToUsd(project.budgetMicrousd),
    spentMicrousd: project.spentMicrousd,
    spentUsd: formatMicrousdToUsd(project.spentMicrousd),
    version: project.version,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function proposalResponse(
  proposal: StoryboardProposal,
): Record<string, unknown> {
  return {
    id: proposal.id,
    projectId: proposal.projectId,
    revision: proposal.revision,
    status: proposal.status,
    shots: proposal.shots,
    totalDurationSeconds: proposal.totalDurationSeconds,
    durationToleranceSeconds: proposal.durationToleranceSeconds,
    version: proposal.version,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  };
}

function shotResponse(shot: Shot): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: shot.id,
    projectId: shot.projectId,
    storyboardProposalId: shot.storyboardProposalId,
    ordinal: shot.ordinal,
    purpose: shot.purpose,
    prompt: shot.prompt,
    durationSeconds: shot.durationSeconds,
    mode: shot.mode,
    qualityTier: shot.qualityTier,
    status: shot.status,
    version: shot.version,
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
  };
  if (shot.acceptedAttemptId) {
    response.acceptedAttemptId = shot.acceptedAttemptId;
  }
  return response;
}

function eventResponse(event: DomainEvent): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: event.id,
    type: event.type,
    version: event.version,
    occurredAt: event.occurredAt,
    observedAt: event.observedAt,
    producer: event.producer,
    tenantId: event.tenantId,
    payload: event.payload,
  };
  if (event.projectId) response.projectId = event.projectId;
  if (event.shotId) response.shotId = event.shotId;
  if (event.attemptId) response.attemptId = event.attemptId;
  if (event.promptId) response.promptId = event.promptId;
  if (event.traceId) response.traceId = event.traceId;
  return response;
}

function params(request: FastifyRequest): { readonly projectId: string } {
  const candidate = request.params as { projectId?: unknown };
  if (typeof candidate.projectId !== 'string') {
    throw new HttpProblemError(
      'INVALID_PATH_PARAMETER',
      'The project identifier is invalid.',
      400,
      false,
    );
  }
  return { projectId: candidate.projectId };
}

function parseProjectId(request: FastifyRequest): Uuid {
  const { projectId } = params(request);
  try {
    return assertProjectUuid(projectId);
  } catch {
    throw new HttpProblemError(
      'INVALID_PATH_PARAMETER',
      'The project identifier is invalid.',
      400,
      false,
    );
  }
}

function assertProjectUuid(value: string): Uuid {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error('invalid uuid');
  }
  return value as Uuid;
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new HttpProblemError(
      'INVALID_REQUEST',
      'The request body is invalid.',
      422,
      false,
    );
  }
  return result.data;
}

function parseApprovalBody(value: unknown): ApproveStoryboardBody {
  const body = parseBody(approveStoryboardBodySchema, value);
  if (!body.proposalId) {
    return body;
  }
  try {
    return { proposalId: assertProjectUuid(body.proposalId) };
  } catch {
    throw new HttpProblemError(
      'INVALID_REQUEST',
      'The storyboard proposal identifier is invalid.',
      422,
      false,
    );
  }
}

function parseBudget(
  body: CreateProjectBody,
  defaultBudgetMicrousd: MicroUsd,
): MicroUsd {
  if (body.budgetMicrousd !== undefined && body.budgetUsd !== undefined) {
    throw new HttpProblemError(
      'INVALID_REQUEST',
      'Specify either budgetUsd or budgetMicrousd, not both.',
      422,
      false,
    );
  }
  let budget = defaultBudgetMicrousd;
  try {
    if (body.budgetMicrousd !== undefined) {
      budget = assertMicrousd(body.budgetMicrousd);
    } else if (body.budgetUsd !== undefined) {
      budget = parseUsdToMicrousd(body.budgetUsd);
    }
  } catch (error) {
    if (error instanceof DomainError) {
      throw new HttpProblemError(
        'INVALID_BUDGET',
        'The project budget is invalid.',
        422,
        false,
      );
    }
    throw error;
  }
  if (budget > defaultBudgetMicrousd) {
    throw new HttpProblemError(
      'BUDGET_EXCEEDS_DEFAULT',
      'The requested budget cannot exceed the configured development budget.',
      422,
      false,
    );
  }
  return budget;
}

function headerValue(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function idempotencyKey(request: FastifyRequest): string {
  const key = headerValue(request, 'idempotency-key')?.trim();
  if (!key) {
    throw new HttpProblemError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'Mutating requests require an Idempotency-Key header.',
      400,
      false,
    );
  }
  if (key.length > 200) {
    throw new HttpProblemError(
      'INVALID_IDEMPOTENCY_KEY',
      'The Idempotency-Key header is too long.',
      422,
      false,
    );
  }
  return key;
}

interface IdempotentResponse {
  readonly status: number;
  readonly body: unknown;
}

async function executeIdempotent(
  request: FastifyRequest,
  service: ProjectApplicationService,
  operation: string,
  body: unknown,
  mutation: (repositories: Repositories) => Promise<IdempotentResponse>,
): Promise<IdempotentResponse> {
  const key = idempotencyKey(request);
  const hash = requestHash(operation, body);
  return service.withTransaction(async (repositories) => {
    const reservation = await repositories.idempotency.reserve(
      service.tenantId,
      key,
      operation,
      hash,
      toIsoUtc(service.clock.now()),
    );
    if (reservation.kind === 'conflict') {
      throw new HttpProblemError(
        'IDEMPOTENCY_KEY_REUSED',
        'The Idempotency-Key was already used for a different request.',
        409,
        false,
      );
    }
    if (reservation.kind === 'in_progress') {
      throw new HttpProblemError(
        'IDEMPOTENCY_IN_PROGRESS',
        'The original request is still being processed.',
        409,
        true,
      );
    }
    if (reservation.kind === 'replay') {
      return { status: reservation.status, body: reservation.body };
    }
    const response = await mutation(repositories);
    await repositories.idempotency.complete(
      service.tenantId,
      key,
      response.status,
      response.body,
      toIsoUtc(service.clock.now()),
    );
    return response;
  });
}

function problemTitle(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function traceIdFor(request: FastifyRequest): string {
  const supplied = headerValue(request, 'x-trace-id');
  return supplied && /^[0-9a-f]{32}$/i.test(supplied)
    ? supplied
    : createTraceId();
}

function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let retryable = false;
  let detail: string | undefined;

  if (error instanceof HttpProblemError) {
    status = error.status;
    code = error.code;
    retryable = error.retryable;
    if (error.exposeDetail) detail = error.message;
  } else if (error instanceof ApplicationError) {
    status = error.status;
    code = error.code;
    retryable = error.retryable;
    detail = error.message;
  } else if (error instanceof DomainError) {
    status = 422;
    code = error.code;
    detail = error.message;
  } else if (error instanceof RepositoryError) {
    status = error.code === 'OPTIMISTIC_CONFLICT' ? 409 : 503;
    code =
      error.code === 'OPTIMISTIC_CONFLICT'
        ? 'OPTIMISTIC_CONFLICT'
        : 'PERSISTENCE_UNAVAILABLE';
    retryable = true;
    detail =
      code === 'OPTIMISTIC_CONFLICT'
        ? 'The resource changed; retry the operation with fresh state.'
        : 'The persistence operation could not be completed.';
  } else if (
    typeof error === 'object' &&
    error !== null &&
    'validation' in error
  ) {
    status = 422;
    code = 'INVALID_REQUEST';
    detail = 'The request is invalid.';
  }

  const problem: ProblemDetails = {
    type: `https://h3.videoops/problems/${code.toLowerCase()}`,
    title: problemTitle(code),
    status,
    code,
    traceId: traceIdFor(request),
    retryable,
  };
  if (detail) {
    return reply
      .code(status)
      .type('application/problem+json')
      .send({ ...problem, detail });
  }
  return reply.code(status).type('application/problem+json').send(problem);
}

function baseRouteSchemas() {
  return {
    projectResponse: {
      type: 'object',
      properties: { project: projectJsonSchema },
    },
    projectsResponse: {
      type: 'object',
      properties: { projects: { type: 'array', items: projectJsonSchema } },
    },
    proposalResponse: {
      type: 'object',
      properties: { project: projectJsonSchema, proposal: proposalJsonSchema },
    },
    approvalResponse: {
      type: 'object',
      properties: {
        project: projectJsonSchema,
        shots: { type: 'array', items: shotJsonSchema },
      },
    },
    shotsResponse: {
      type: 'object',
      properties: { shots: { type: 'array', items: shotJsonSchema } },
    },
    eventsResponse: {
      type: 'object',
      properties: { events: { type: 'array', items: eventJsonSchema } },
    },
    costResponse: {
      type: 'object',
      properties: {
        budgetMicrousd: { type: 'integer' },
        budgetUsd: { type: 'string' },
        spentMicrousd: { type: 'integer' },
        spentUsd: { type: 'string' },
        remainingMicrousd: { type: 'integer' },
        remainingUsd: { type: 'string' },
      },
    },
  } as const;
}

export function buildApiApp(options: ApiAppOptions = {}): FastifyInstance {
  const config = options.config ?? getApiConfig();
  const databaseReady = options.databaseReady ?? (async () => false);
  const store = options.store ?? createInMemoryStore();
  let defaultBudgetMicrousd: MicroUsd;
  try {
    defaultBudgetMicrousd = parseUsdToMicrousd(config.projectDefaultBudgetUsd);
  } catch {
    defaultBudgetMicrousd = parseUsdToMicrousd('25.00');
  }
  const service = new ProjectApplicationService({
    store,
    planner: options.planner ?? new StaticStoryboardPlanner(),
    defaultBudgetMicrousd,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
  });
  const authToken =
    config.devAuthToken || (config.nodeEnv === 'test' ? 'test-token' : '');
  const schemas = baseRouteSchemas();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
        'req.body.brief',
        'req.body.budgetUsd',
      ],
    },
    requestIdHeader: 'x-request-id',
  });

  void app.register(cors, { origin: config.webOrigin });
  void app.register(swagger, {
    openapi: {
      info: {
        title: 'H3 VideoOps API',
        description: 'Phase 2 domain, persistence, and project API.',
        version: '0.2.0',
      },
      tags: [
        { name: 'projects', description: 'Project and storyboard operations' },
      ],
    },
  });
  void app.register(swaggerUi, { routePrefix: '/documentation' });

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/v1/')) {
      return;
    }
    if (!authToken) {
      throw new HttpProblemError(
        'AUTH_NOT_CONFIGURED',
        'Development authentication is not configured.',
        503,
        false,
        false,
      );
    }
    if (headerValue(request, 'authorization') !== `Bearer ${authToken}`) {
      throw new HttpProblemError(
        'UNAUTHORIZED',
        'A valid bearer token is required.',
        401,
        false,
        false,
      );
    }
  });

  app.setErrorHandler((error, request, reply) =>
    sendProblem(request, reply, error),
  );

  void app.register(async (routes) => {
    routes.get(
      '/health/live',
      async (): Promise<ApiLiveResponse> => ({
        service: 'api',
        status: 'ok',
      }),
    );

    routes.get(
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
        return ready ? response : reply.code(503).send(response);
      },
    );

    routes.post(
      '/v1/projects',
      {
        schema: {
          tags: ['projects'],
          summary: 'Create a draft project',
          body: {
            type: 'object',
            required: ['title', 'brief', 'targetDurationSeconds'],
            properties: {
              title: { type: 'string', minLength: 1 },
              brief: { type: 'string', minLength: 1 },
              targetDurationSeconds: { type: 'number', minimum: 3 },
              budgetUsd: { anyOf: [{ type: 'string' }, { type: 'number' }] },
              budgetMicrousd: { type: 'integer', minimum: 0 },
            },
            additionalProperties: false,
          },
          response: { 201: schemas.projectResponse },
        },
      },
      async (request, reply) => {
        const body = parseBody(createProjectBodySchema, request.body);
        const response = await executeIdempotent(
          request,
          service,
          'project.create',
          body,
          async (repositories) => {
            const project = await service.createProjectInTransaction(
              repositories,
              {
                title: body.title,
                brief: body.brief,
                targetDurationSeconds: body.targetDurationSeconds,
                budgetMicrousd: parseBudget(
                  body,
                  service.defaultBudgetMicrousd,
                ),
              },
            );
            return { status: 201, body: { project: projectResponse(project) } };
          },
        );
        return reply.code(response.status as 201).send(response.body);
      },
    );

    routes.get(
      '/v1/projects',
      {
        schema: {
          tags: ['projects'],
          summary: 'List projects',
          response: { 200: schemas.projectsResponse },
        },
      },
      async () => ({
        projects: (await service.listProjects()).map(projectResponse),
      }),
    );

    routes.get(
      '/v1/projects/:projectId',
      {
        schema: {
          tags: ['projects'],
          summary: 'Get a project',
          params: {
            type: 'object',
            required: ['projectId'],
            properties: { projectId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: schemas.projectResponse },
        },
      },
      async (request) => ({
        project: projectResponse(
          await service.getProject(parseProjectId(request)),
        ),
      }),
    );

    routes.post(
      '/v1/projects/:projectId/plan',
      {
        schema: {
          tags: ['projects'],
          summary: 'Generate a deterministic storyboard proposal',
          params: {
            type: 'object',
            required: ['projectId'],
            properties: { projectId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: schemas.proposalResponse },
        },
      },
      async (request, reply) => {
        const projectId = parseProjectId(request);
        const body = request.body ?? {};
        const response = await executeIdempotent(
          request,
          service,
          `project.plan:${projectId}`,
          body,
          async (repositories) => {
            const result = await service.planProjectInTransaction(
              repositories,
              projectId,
            );
            return {
              status: 200,
              body: {
                project: projectResponse(result.project),
                proposal: proposalResponse(result.proposal),
              },
            };
          },
        );
        return reply.code(response.status as 200).send(response.body);
      },
    );

    routes.post(
      '/v1/projects/:projectId/storyboard/approve',
      {
        schema: {
          tags: ['projects'],
          summary: 'Approve the current storyboard and materialize three shots',
          params: {
            type: 'object',
            required: ['projectId'],
            properties: { projectId: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            properties: { proposalId: { type: 'string', format: 'uuid' } },
            additionalProperties: false,
          },
          response: { 200: schemas.approvalResponse },
        },
      },
      async (request, reply) => {
        const projectId = parseProjectId(request);
        const body = parseApprovalBody(request.body);
        const response = await executeIdempotent(
          request,
          service,
          `project.storyboard.approve:${projectId}`,
          body,
          async (repositories) => {
            const result = await service.approveStoryboardInTransaction(
              repositories,
              projectId,
              body.proposalId as Uuid | undefined,
            );
            return {
              status: 200,
              body: {
                project: projectResponse(result.project),
                shots: result.shots.map(shotResponse),
              },
            };
          },
        );
        return reply.code(response.status as 200).send(response.body);
      },
    );

    routes.get(
      '/v1/projects/:projectId/shots',
      {
        schema: {
          tags: ['projects'],
          summary: 'List materialized shots',
          params: {
            type: 'object',
            required: ['projectId'],
            properties: { projectId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: schemas.shotsResponse },
        },
      },
      async (request) => ({
        shots: (await service.listShots(parseProjectId(request))).map(
          shotResponse,
        ),
      }),
    );

    routes.get(
      '/v1/projects/:projectId/events',
      {
        schema: {
          tags: ['projects'],
          summary: 'List project domain events',
          params: {
            type: 'object',
            required: ['projectId'],
            properties: { projectId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: schemas.eventsResponse },
        },
      },
      async (request) => ({
        events: (await service.listEvents(parseProjectId(request))).map(
          eventResponse,
        ),
      }),
    );

    routes.get(
      '/v1/projects/:projectId/cost',
      {
        schema: {
          tags: ['projects'],
          summary: 'Get project cost totals',
          params: {
            type: 'object',
            required: ['projectId'],
            properties: { projectId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: schemas.costResponse },
        },
      },
      async (request) => {
        const cost = await service.getCost(parseProjectId(request));
        return {
          budgetMicrousd: cost.budgetMicrousd,
          budgetUsd: formatMicrousdToUsd(cost.budgetMicrousd),
          spentMicrousd: cost.spentMicrousd,
          spentUsd: formatMicrousdToUsd(cost.spentMicrousd),
          remainingMicrousd: cost.remainingMicrousd,
          remainingUsd: formatMicrousdToUsd(cost.remainingMicrousd),
        };
      },
    );
  });

  return app;
}

export async function startApi(
  config: ApiConfig = getApiConfig(),
): Promise<FastifyInstance> {
  const pool = createDatabasePool(config.databaseUrl);
  await runMigrations(pool);
  const store = createPostgresStore(pool);
  const now = toIsoUtc(new Date());
  await store.withTransaction((repositories) =>
    repositories.tenants.ensure(DEV_TENANT_ID, 'Development tenant', now),
  );
  const app = buildApiApp({
    config,
    databaseReady: () => checkDatabaseReady(pool),
    store,
  });

  app.addHook('onClose', async () => {
    await pool.end();
  });

  await app.listen({ host: config.apiHost, port: config.apiPort });
  return app;
}
