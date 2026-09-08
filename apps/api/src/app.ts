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
  subtractMicrousd,
  systemClock,
  systemIdGenerator,
  toIsoUtc,
  type Clock,
  type ArtifactRecord,
  type DomainEvent,
  type EvaluationResult,
  type GenerationAttempt,
  type IdGenerator,
  type MicroUsd,
  type Shot,
  type Uuid,
  type VideoProject,
  isGenerationAttemptStatus,
} from '@h3/domain';
import {
  checkDatabaseReady,
  createDatabasePool,
  createInMemoryStore,
  createPostgresStore,
  OutboxDispatcher,
  RepositoryError,
  runMigrations,
  type OutboxConsumer,
  type Repositories,
  type OperationalRecommendationRecord,
  type TransactionalStore,
  type WorkflowRevisionRecord,
} from '@h3/db';
import { getApiConfig, type ApiConfig } from '@h3/config';
import type { OperationalExecutorToolView } from '@h3/agent-tools';
import {
  createTraceId,
  createBufferedTelemetry,
  initializeCoreMetrics,
  MetricsRegistry,
  TraceContextRegistry,
  type AgentTelemetry,
  type TelemetrySpanHandle,
  type TraceId,
} from '@h3/telemetry';
import { createLocalArtifactStore, type ArtifactStore } from '@h3/object-store';
import {
  HttpWsComfyClient,
  type ComfyClient,
  type ComfyQueueResponse,
  type ComfyReadiness,
} from '@h3/comfy-client';
import type { MediaEvaluator } from '@h3/evaluator';
import { MINIMAX_H3_PROFILE_ID } from '@h3/workflow-compiler';
import {
  ApplicationError,
  DEV_TENANT_ID,
  ProjectApplicationService,
} from './application.js';
import {
  GenerationApplicationService,
  GenerationApplicationError,
  GenerationWorker,
  PREVIEW_DURATION_SECONDS,
  type CreateAttemptCommand,
  type RetryAttemptCommand,
} from './generation.js';
import {
  WorkflowApplicationError,
  WorkflowApplicationService,
  type WorkflowGraph,
} from './workflow.js';
import {
  createOperationalToolServices,
  OperationalOutboxConsumer,
  OperationalOutboxWorker,
  OperationalPiAdapter,
} from './operator.js';
import {
  NotifyingOutboxConsumer,
  WebhookNotificationDelivery,
} from './notify.js';

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
  readonly telemetry?: AgentTelemetry;
  readonly metrics?: MetricsRegistry;
  readonly traceContexts?: TraceContextRegistry;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly comfyClient?: ComfyClient;
  readonly artifactStore?: ArtifactStore;
  readonly evaluator?: MediaEvaluator;
  readonly generationWorker?: GenerationWorker;
  readonly startGenerationWorker?: boolean;
  readonly operationalAdapter?: OperationalPiAdapter;
  readonly operationalDispatcher?: OutboxDispatcher;
  readonly startOperationalWorker?: boolean;
  /** Test injection point for the notify webhook's HTTP client. */
  readonly notifyFetchImpl?: typeof fetch;
}

export interface StartApiOptions {
  readonly comfyClient?: ComfyClient;
}

export function createConfiguredComfyClient(config: ApiConfig): ComfyClient {
  switch (config.comfyMode) {
    case 'fake':
    case 'remote':
      return new HttpWsComfyClient({
        baseUrl: config.comfyBaseUrl,
        wsUrl: config.comfyWsUrl,
        clientId: `${config.comfyClientIdPrefix}-${config.gpuWorkerId}`,
        requestTimeoutMs: config.comfyRequestTimeoutMs,
        ...(config.comfyAuthToken ? { authToken: config.comfyAuthToken } : {}),
      });
    default: {
      const mode: never = config.comfyMode;
      throw new Error(`Unsupported ComfyUI mode: ${mode}`);
    }
  }
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

const createAttemptBodySchema = z
  .object({
    seed: z.number().int().optional(),
    steps: z.number().int().positive().max(100).optional(),
    scenario: z
      .enum([
        'success',
        'duplicate-events',
        'disconnect-reconcile',
        'execution-failure',
        'timeout',
        'uncertain-submission',
      ])
      .optional(),
  })
  .strict();

const rejectAttemptBodySchema = z
  .object({ reasonCode: z.string().trim().min(1).max(64) })
  .strict();

const retryAttemptBodySchema = z
  .object({ resolveUncertain: z.literal(true).optional() })
  .strict();

const recommendationActionBodySchema = z
  .object({ expectedVersion: z.number().int().positive().optional() })
  // Action and execution fields in the body are deliberately ignored; the
  // persisted recommendation is the only source of truth for the operation.
  .passthrough();

const runBodySchema = z
  .object({
    editorGraph: z.unknown(),
    apiGraph: z.unknown(),
    label: z.string().trim().min(1).max(200).optional(),
    projectId: z.string().uuid().optional(),
    profileId: z.string().trim().min(1).max(128).optional(),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
    // Accepted for compatibility with graph clients, but deliberately ignored.
    executionHash: z.string().optional(),
  })
  .strict();

const runReviewBodySchema = z
  .object({
    decision: z.enum(['accepted', 'rejected']),
    note: z.string().max(2_000).optional(),
  })
  .strict();

type CreateAttemptBody = z.infer<typeof createAttemptBodySchema>;
type RejectAttemptBody = z.infer<typeof rejectAttemptBodySchema>;
type RetryAttemptBody = z.infer<typeof retryAttemptBodySchema>;
type RecommendationActionBody = z.infer<typeof recommendationActionBodySchema>;
type RunBody = z.infer<typeof runBodySchema>;
type RunReviewBody = z.infer<typeof runReviewBodySchema>;

type CreateProjectBody = z.infer<typeof createProjectBodySchema>;
export interface WorkflowRunMetadata {
  readonly prompt: string;
  readonly durationSeconds: number;
}

const DIRECT_RUN_PLACEHOLDER = 'Direct workflow submission.';

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function normalizedKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/** Derives only safe grouping metadata; introspection failures do not reject a run. */
export function deriveWorkflowRunMetadata(
  apiGraph: unknown,
): WorkflowRunMetadata {
  const promptKeys = new Set([
    'text',
    'prompt',
    'positive',
    'positiveprompt',
    'positive_prompt',
    'positiveprompttext',
  ]);
  const frameKeys = new Set([
    'frames',
    'framecount',
    'numframes',
    'videolength',
    'length',
    'durationframes',
  ]);
  const fpsKeys = new Set(['fps', 'framerate', 'framespersecond']);
  let prompt: string | undefined;
  let explicitDuration: number | undefined;
  let frameCount: number | undefined;
  let fps: number | undefined;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizedKey(key);
      if (
        prompt === undefined &&
        promptKeys.has(normalized) &&
        typeof child === 'string' &&
        child.trim()
      ) {
        prompt = child.trim().slice(0, 20_000);
      }
      const number = positiveNumber(child);
      if (number !== undefined) {
        if (normalized === 'durationseconds' || normalized === 'duration') {
          explicitDuration ??= number;
        } else if (frameKeys.has(normalized)) {
          frameCount ??= number;
        } else if (fpsKeys.has(normalized)) {
          fps ??= number;
        }
      }
      visit(child);
    }
  };
  visit(apiGraph);
  const derivedDuration =
    explicitDuration ??
    (frameCount !== undefined && fps !== undefined
      ? frameCount / fps
      : undefined);
  const durationSeconds =
    derivedDuration !== undefined &&
    Number.isFinite(derivedDuration) &&
    derivedDuration >= 3 &&
    derivedDuration <= 3_600
      ? derivedDuration
      : PREVIEW_DURATION_SECONDS;
  return {
    prompt: prompt ?? DIRECT_RUN_PLACEHOLDER,
    durationSeconds,
  };
}

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
    budgetMicrousd: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    budgetUsd: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    spentMicrousd: { type: 'integer' },
    spentUsd: { type: 'string' },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    autoCreated: { type: 'boolean' },
  },
} as const;

const shotJsonSchema = {
  type: 'object',
  required: [
    'id',
    'projectId',
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
    visualDescription: { type: 'string' },
    cameraDirection: { type: 'string' },
    audioDirection: { type: 'string' },
    dialogue: { type: 'string' },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    requiredAssetIds: {
      type: 'array',
      items: { type: 'string', maxLength: 0 },
    },
    status: { type: 'string' },
    acceptedAttemptId: { type: 'string', format: 'uuid' },
    implicit: { type: 'boolean' },
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
    eventSequence: { type: 'integer', minimum: 1 },
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
          visualDescription: { type: 'string' },
          cameraDirection: { type: 'string' },
          audioDirection: { type: 'string' },
          dialogue: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          requiredAssetIds: {
            type: 'array',
            items: { type: 'string', maxLength: 0 },
          },
        },
      },
    },
    totalDurationSeconds: { type: 'number' },
    durationToleranceSeconds: { type: 'number' },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    objective: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    agentRunId: { type: 'string', format: 'uuid' },
  },
} as const;

const attemptJsonSchema = {
  type: 'object',
  required: [
    'id',
    'tenantId',
    'projectId',
    'shotId',
    'idempotencyKey',
    'status',
    'seed',
    'steps',
    'requestedWidth',
    'requestedHeight',
    'requestedDurationSeconds',
    'workflowHash',
    'correlationId',
    'estimatedCostMicrousd',
    'version',
    'queuedAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    shotId: { type: 'string', format: 'uuid' },
    idempotencyKey: { type: 'string' },
    status: { type: 'string' },
    seed: { type: 'integer' },
    steps: { type: 'integer' },
    requestedWidth: { type: 'integer' },
    requestedHeight: { type: 'integer' },
    requestedDurationSeconds: { type: 'number' },
    workflowVersionId: { type: 'string', format: 'uuid' },
    workflowRevisionId: { type: 'string', format: 'uuid' },
    workflowHash: { type: 'string' },
    correlationId: { type: 'string' },
    traceId: { type: 'string' },
    scenario: { type: 'string' },
    comfyPromptId: { type: 'string' },
    leaseOwner: { type: 'string' },
    leaseExpiresAt: { type: 'string', format: 'date-time' },
    queuedAt: { type: 'string', format: 'date-time' },
    submittedAt: { type: 'string', format: 'date-time' },
    finishedAt: { type: 'string', format: 'date-time' },
    computeSeconds: { type: 'number' },
    estimatedCostMicrousd: { type: 'integer' },
    failureCode: { type: 'string' },
    failureMessage: { type: 'string' },
    sourceAttemptId: { type: 'string', format: 'uuid' },
    artifactId: { type: 'string', format: 'uuid' },
    reviewDecision: { type: 'string', enum: ['accepted', 'rejected'] },
    reviewNote: { type: 'string' },
    reviewAuthor: { type: 'string' },
    reviewedAt: { type: 'string', format: 'date-time' },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const evaluationJsonSchema = {
  type: 'object',
  required: [
    'id',
    'attemptId',
    'evaluatorVersion',
    'status',
    'checks',
    'details',
    'evaluatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    attemptId: { type: 'string', format: 'uuid' },
    evaluatorVersion: { type: 'string' },
    status: { type: 'string', enum: ['passed', 'failed'] },
    checks: { type: 'object' },
    details: { type: 'object' },
    evaluatedAt: { type: 'string', format: 'date-time' },
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
  const response: Record<string, unknown> = {
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
  if (project.autoCreated) response.autoCreated = true;
  return response;
}

function shotResponse(shot: Shot): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: shot.id,
    projectId: shot.projectId,
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
  if (shot.storyboardProposalId) {
    response.storyboardProposalId = shot.storyboardProposalId;
  }
  for (const key of [
    'visualDescription',
    'cameraDirection',
    'audioDirection',
    'dialogue',
    'acceptanceCriteria',
    'requiredAssetIds',
  ] as const) {
    const value = shot[key];
    if (value !== undefined) response[key] = value;
  }
  if (shot.acceptedAttemptId) {
    response.acceptedAttemptId = shot.acceptedAttemptId;
  }
  if (shot.implicit) response.implicit = true;
  return response;
}

function attemptResponse(attempt: GenerationAttempt): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: attempt.id,
    tenantId: attempt.tenantId,
    projectId: attempt.projectId,
    shotId: attempt.shotId,
    idempotencyKey: attempt.idempotencyKey,
    status: attempt.status,
    seed: attempt.seed,
    steps: attempt.steps,
    requestedWidth: attempt.requestedWidth,
    requestedHeight: attempt.requestedHeight,
    requestedDurationSeconds: attempt.requestedDurationSeconds,
    workflowHash: attempt.workflowHash,
    correlationId: attempt.correlationId,
    estimatedCostMicrousd: attempt.estimatedCostMicrousd,
    estimatedCostUsd: formatMicrousdToUsd(attempt.estimatedCostMicrousd),
    queuedAt: attempt.queuedAt,
    version: attempt.version,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  };
  const optional: ReadonlyArray<[string, unknown]> = [
    ['workflowVersionId', attempt.workflowVersionId],
    ['workflowRevisionId', attempt.workflowRevisionId],
    ['traceId', attempt.traceId],
    ['scenario', attempt.scenario],
    ['comfyPromptId', attempt.comfyPromptId],
    ['leaseOwner', attempt.leaseOwner],
    ['leaseExpiresAt', attempt.leaseExpiresAt],
    ['submittedAt', attempt.submittedAt],
    ['finishedAt', attempt.finishedAt],
    ['computeSeconds', attempt.computeSeconds],
    ['failureCode', attempt.failureCode],
    ['failureMessage', attempt.failureMessage],
    ['sourceAttemptId', attempt.sourceAttemptId],
    ['artifactId', attempt.artifactId],
    ['reviewDecision', attempt.reviewDecision],
    ['reviewNote', attempt.reviewNote],
    ['reviewAuthor', attempt.reviewAuthor],
    ['reviewedAt', attempt.reviewedAt],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) response[key] = value;
  }
  return response;
}

function evaluationResponse(result: EvaluationResult): Record<string, unknown> {
  return {
    id: result.id,
    tenantId: result.tenantId,
    projectId: result.projectId,
    shotId: result.shotId,
    attemptId: result.attemptId,
    evaluatorVersion: result.evaluatorVersion,
    status: result.status,
    checks: result.checks,
    details: result.details,
    evaluatedAt: result.evaluatedAt,
  };
}

interface RunAggregate {
  readonly attempt: GenerationAttempt;
  readonly project: VideoProject;
  readonly revision: WorkflowRevisionRecord | null;
  readonly artifact: ArtifactRecord | null;
  readonly evaluation: EvaluationResult | null;
  readonly pinned: boolean;
  readonly events: readonly DomainEvent[];
}

function runAttemptResponse(
  attempt: GenerationAttempt,
): Record<string, unknown> {
  const response = attemptResponse(attempt);
  delete response.shotId;
  return response;
}

function runRevisionResponse(
  revision: WorkflowRevisionRecord | null,
): Record<string, unknown> | null {
  if (!revision) return null;
  const response = workflowRevisionResponse(revision);
  delete response.shotId;
  return response;
}

function runArtifactResponse(
  artifact: ArtifactRecord | null,
): Record<string, unknown> | null {
  if (!artifact) return null;
  return {
    id: artifact.id,
    tenantId: artifact.tenantId,
    projectId: artifact.projectId,
    attemptId: artifact.attemptId,
    objectKey: artifact.objectKey,
    mimeType: artifact.mimeType,
    byteSize: artifact.byteSize,
    sha256: artifact.sha256,
    createdAt: artifact.createdAt,
  };
}

function runEvaluationResponse(
  evaluation: EvaluationResult | null,
): Record<string, unknown> | null {
  if (!evaluation) return null;
  const response = evaluationResponse(evaluation);
  delete response.shotId;
  return response;
}

function runReviewResponse(
  attempt: GenerationAttempt,
): Record<string, unknown> | null {
  if (!attempt.reviewDecision) return null;
  return {
    decision: attempt.reviewDecision,
    ...(attempt.reviewNote !== undefined ? { note: attempt.reviewNote } : {}),
    ...(attempt.reviewAuthor !== undefined
      ? { author: attempt.reviewAuthor }
      : {}),
    ...(attempt.reviewedAt ? { reviewedAt: attempt.reviewedAt } : {}),
  };
}

function runEventResponse(event: DomainEvent): Record<string, unknown> {
  const response = eventResponse(event);
  delete response.shotId;
  return response;
}

function runResponse(run: RunAggregate): Record<string, unknown> {
  const budget = run.project.budgetMicrousd;
  const remaining = subtractMicrousd(budget, run.project.spentMicrousd);
  return {
    runId: run.attempt.id,
    projectId: run.project.id,
    revisionId: run.revision?.id ?? run.attempt.workflowRevisionId ?? null,
    executionHash: run.revision?.executionHash ?? run.attempt.workflowHash,
    status: run.attempt.status,
    validation: run.revision
      ? {
          status: run.revision.validationStatus,
          errors: run.revision.validationErrorsJson,
        }
      : { status: 'not-recorded', errors: [] },
    attempt: runAttemptResponse(run.attempt),
    revision: runRevisionResponse(run.revision),
    artifact: runArtifactResponse(run.artifact),
    evaluation: runEvaluationResponse(run.evaluation),
    evaluationStatus: run.evaluation?.status ?? 'not-run',
    cost: {
      estimatedCostMicrousd: run.attempt.estimatedCostMicrousd,
      estimatedCostUsd: formatMicrousdToUsd(run.attempt.estimatedCostMicrousd),
      projectBudgetMicrousd: budget,
      projectBudgetUsd: formatMicrousdToUsd(budget),
      projectSpentMicrousd: run.project.spentMicrousd,
      projectSpentUsd: formatMicrousdToUsd(run.project.spentMicrousd),
      projectRemainingMicrousd: remaining,
      projectRemainingUsd: formatMicrousdToUsd(remaining),
    },
    review: runReviewResponse(run.attempt),
    pinned: run.pinned,
    project: projectResponse(run.project),
    events: run.events.map(runEventResponse),
  };
}

/**
 * Per-request memo for lookups that repeat across the runs of one project.
 * Without it, aggregating a page of N runs re-reads the same project row, shot
 * rows, and the entire project event log N times.
 */
interface RunLookupCache {
  readonly projects: Map<string, VideoProject | null>;
  readonly shots: Map<string, Shot | null>;
  readonly events: Map<string, readonly DomainEvent[]>;
}

function createRunLookupCache(): RunLookupCache {
  return { projects: new Map(), shots: new Map(), events: new Map() };
}

async function memoize<T>(
  cache: Map<string, T> | undefined,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  if (!cache) return load();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = await load();
  cache.set(key, value);
  return value;
}

async function loadRunAggregate(
  repositories: Repositories,
  tenantId: Uuid,
  attemptId: Uuid,
  cache?: RunLookupCache,
): Promise<RunAggregate | null> {
  const attempt = await repositories.attempts.findById(tenantId, attemptId);
  if (!attempt) return null;
  const project = await memoize(cache?.projects, attempt.projectId, () =>
    repositories.projects.findById(tenantId, attempt.projectId),
  );
  const shot = await memoize(
    cache?.shots,
    `${attempt.projectId}:${attempt.shotId}`,
    () => repositories.shots.findById(attempt.projectId, attempt.shotId),
  );
  if (!project || !shot) return null;
  const revision = attempt.workflowRevisionId
    ? await repositories.workflowRevisions.findById(
        tenantId,
        attempt.projectId,
        attempt.shotId,
        attempt.workflowRevisionId,
      )
    : null;
  const artifact = await repositories.artifacts.findByAttempt(
    tenantId,
    attempt.id,
  );
  const evaluation = await repositories.evaluations.findByAttempt(
    tenantId,
    attempt.id,
  );
  const revisionId = revision?.id;
  const projectEvents = await memoize(cache?.events, project.id, () =>
    repositories.events.listByProject(project.id),
  );
  const events = projectEvents
    .filter((event) => {
      const payload = event.payload;
      return (
        event.attemptId === attempt.id ||
        event.shotId === shot.id ||
        payload.runId === attempt.id ||
        (revisionId !== undefined &&
          (payload.revisionId === revisionId ||
            payload.workflowRevisionId === revisionId)) ||
        (project.autoCreated === true && event.type === 'project.created')
      );
    })
    .sort(
      (left, right) => (left.eventSequence ?? 0) - (right.eventSequence ?? 0),
    );
  return {
    attempt,
    project,
    revision,
    artifact,
    evaluation,
    pinned: shot.pinnedAttemptId === attempt.id,
    events,
  };
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
  if (event.eventSequence !== undefined) {
    response.eventSequence = event.eventSequence;
  }
  if (event.projectId) response.projectId = event.projectId;
  if (event.shotId) response.shotId = event.shotId;
  if (event.attemptId) response.attemptId = event.attemptId;
  if (event.promptId) response.promptId = event.promptId;
  if (event.traceId) response.traceId = event.traceId;
  return response;
}

function workflowRevisionResponse(
  revision: WorkflowRevisionRecord,
): Record<string, unknown> {
  return {
    id: revision.id,
    tenantId: revision.tenantId,
    projectId: revision.projectId,
    shotId: revision.shotId,
    revisionNumber: revision.revisionNumber,
    ...(revision.parentRevisionId
      ? { parentRevisionId: revision.parentRevisionId }
      : {}),
    profileId: revision.profileId,
    profileVersion: revision.profileVersion,
    source: revision.source,
    ...(revision.frontendVersion
      ? { frontendVersion: revision.frontendVersion }
      : {}),
    ...(revision.frontendCommit
      ? { frontendCommit: revision.frontendCommit }
      : {}),
    authorType: revision.authorType,
    authorId: revision.authorId,
    editorGraph: revision.editorGraphJson,
    editorGraphJson: revision.editorGraphJson,
    apiGraph: revision.apiGraphJson,
    apiGraphJson: revision.apiGraphJson,
    executionHash: revision.executionHash,
    executionParameters: revision.executionParametersJson,
    validationStatus: revision.validationStatus,
    validationErrors: revision.validationErrorsJson,
    ...(revision.validatedAt ? { validatedAt: revision.validatedAt } : {}),
    ...(revision.executorFingerprint
      ? { executorFingerprint: revision.executorFingerprint }
      : {}),
    createdAt: revision.createdAt,
  };
}

function validationResponse(validation: unknown): Record<string, unknown> {
  if (typeof validation !== 'object' || validation === null) {
    return { valid: false, errors: [] };
  }
  const value = validation as Record<string, unknown>;
  return {
    valid: value.valid === true,
    profileId: value.profileId,
    profileVersion: value.profileVersion,
    errors: Array.isArray(value.errors)
      ? value.errors.map((issue) => {
          if (typeof issue !== 'object' || issue === null) {
            return {
              code: 'INVALID_VALIDATION',
              message: 'Invalid validation issue.',
            };
          }
          const record = issue as Record<string, unknown>;
          return {
            code:
              typeof record.code === 'string'
                ? record.code
                : 'INVALID_VALIDATION',
            message:
              typeof record.message === 'string'
                ? record.message
                : 'The workflow validation issue is invalid.',
          };
        })
      : [],
    ...(typeof value.executorFingerprint === 'string'
      ? { executorFingerprint: value.executorFingerprint }
      : {}),
  };
}

function recommendationResponse(
  recommendation: OperationalRecommendationRecord,
): Record<string, unknown> {
  return {
    id: recommendation.id,
    projectId: recommendation.projectId,
    ...(recommendation.shotId ? { shotId: recommendation.shotId } : {}),
    ...(recommendation.attemptId
      ? { attemptId: recommendation.attemptId }
      : {}),
    triggerEventId: recommendation.triggerEventId,
    severity: recommendation.severity,
    recommendationCode: recommendation.recommendationCode,
    title: recommendation.title,
    detail: recommendation.detail,
    evidenceReferences: recommendation.evidenceReferencesJson,
    proposedActionType: recommendation.proposedActionType,
    proposedResourceIds: recommendation.proposedResourceIdsJson,
    status: recommendation.status,
    version: recommendation.version,
    createdAt: recommendation.createdAt,
    updatedAt: recommendation.updatedAt,
  };
}

function safeReadinessResponse(
  readiness: ComfyReadiness,
): Record<string, unknown> {
  return {
    ready: readiness.ready,
    checkedAt: readiness.checkedAt,
    ...(readiness.apiVersion ? { apiVersion: readiness.apiVersion } : {}),
    ...(readiness.capabilityFingerprint
      ? { capabilityFingerprint: readiness.capabilityFingerprint }
      : {}),
    ...(readiness.errorCode ? { errorCode: readiness.errorCode } : {}),
  };
}

function safeQueueCounts(queue: ComfyQueueResponse): {
  pending: number;
  running: number;
} {
  return {
    pending: queue.queuePending.length,
    running: queue.queueRunning.length,
  };
}

const SSE_PAYLOAD_KEYS = new Set([
  'status',
  'code',
  'recoverable',
  'value',
  'max',
  'artifactId',
  'evaluationId',
  'evaluatorVersion',
  'reasonCode',
  'workflowRevisionId',
  'sourceAttemptId',
  'estimatedCostMicrousd',
  'acceptedShotCount',
  'shotCount',
  'ordinal',
  'runId',
  'projectId',
  'revisionId',
  'executionHash',
  'autoCreatedProject',
  'evaluationStatusAtPin',
  'decision',
  'recommendationId',
  'severity',
  'recommendationCode',
  'proposedActionType',
  'triggeringEventType',
]);

function sanitizedEventSummary(event: DomainEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of SSE_PAYLOAD_KEYS) {
    const value = event.payload[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      payload[key] = value;
    }
  }
  return {
    id: event.id,
    ...(event.eventSequence !== undefined
      ? { eventSequence: event.eventSequence }
      : {}),
    type: event.type,
    version: event.version,
    occurredAt: event.occurredAt,
    ...(event.projectId ? { projectId: event.projectId } : {}),
    ...(event.shotId ? { shotId: event.shotId } : {}),
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    payload,
  };
}

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

function parseByteRange(
  header: string | undefined,
  byteSize: number,
): ByteRange | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || byteSize <= 0) return undefined;
  const [, startText, endText] = match;
  if (!startText && !endText) return undefined;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0)
      return undefined;
    const length = Math.min(suffixLength, byteSize);
    return { start: byteSize - length, end: byteSize - 1 };
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= byteSize) {
    return undefined;
  }
  const requestedEnd = endText ? Number(endText) : byteSize - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) {
    return undefined;
  }
  return { start, end: Math.min(requestedEnd, byteSize - 1) };
}

function rangeProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  byteSize: number,
): FastifyReply {
  const problem: ProblemDetails = {
    type: 'https://h3.videoops/problems/range_not_satisfiable',
    title: 'Range Not Satisfiable',
    status: 416,
    code: 'RANGE_NOT_SATISFIABLE',
    traceId: traceIdFor(request),
    retryable: false,
    detail: 'The requested byte range is invalid or cannot be satisfied.',
  };
  return reply
    .code(416)
    .header('content-range', `bytes */${byteSize}`)
    .type('application/problem+json')
    .send(problem);
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

function resourceParam(
  request: FastifyRequest,
  name:
    | 'shotId'
    | 'attemptId'
    | 'runId'
    | 'artifactId'
    | 'revisionId'
    | 'recommendationId',
): Uuid {
  const candidate = request.params as Record<string, unknown>;
  if (typeof candidate[name] !== 'string') {
    throw new HttpProblemError(
      'INVALID_PATH_PARAMETER',
      'The resource identifier is invalid.',
      400,
      false,
    );
  }
  try {
    return assertProjectUuid(candidate[name]);
  } catch {
    throw new HttpProblemError(
      'INVALID_PATH_PARAMETER',
      'The resource identifier is invalid.',
      400,
      false,
    );
  }
}

function bodyUuid(
  value: string | null | undefined,
  label: string,
): Uuid | null | undefined {
  if (value === undefined || value === null) return value;
  try {
    return assertProjectUuid(value);
  } catch {
    throw new HttpProblemError(
      'INVALID_REQUEST',
      `${label} is invalid.`,
      422,
      false,
    );
  }
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

function idempotencyKey(request: FastifyRequest, fallback?: string): string {
  const key =
    headerValue(request, 'idempotency-key')?.trim() ?? fallback?.trim();
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
  keyOverride?: string,
): Promise<IdempotentResponse> {
  const key = idempotencyKey(request, keyOverride);
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

function queryValue(request: FastifyRequest, name: string): string | undefined {
  const query = request.query as Record<string, unknown> | undefined;
  const value = query?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 200) {
    throw new HttpProblemError(
      'INVALID_QUERY',
      `The ${name} query parameter is invalid.`,
      422,
      false,
    );
  }
  return value;
}

function queryBoolean(
  request: FastifyRequest,
  name: string,
): boolean | undefined {
  const value = queryValue(request, name);
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new HttpProblemError(
    'INVALID_QUERY',
    `${name} must be true or false.`,
    422,
    false,
  );
}

function queryLimit(request: FastifyRequest): number {
  const query = request.query as Record<string, unknown> | undefined;
  const raw = query?.limit;
  if (raw === undefined) return 50;
  const limit = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpProblemError(
      'INVALID_QUERY',
      'limit must be an integer between 1 and 100.',
      422,
      false,
    );
  }
  return limit;
}

function problemTitle(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const requestTraceIds = new WeakMap<FastifyRequest, string>();

function traceIdFor(request: FastifyRequest): string {
  const existing = requestTraceIds.get(request);
  if (existing) return existing;
  const supplied = headerValue(request, 'x-trace-id');
  const traceId =
    supplied && /^[0-9a-f]{32}$/i.test(supplied) ? supplied : createTraceId();
  requestTraceIds.set(request, traceId);
  return traceId;
}

function requestOperationName(request: FastifyRequest): string {
  const routeUrl = (request as unknown as { routeOptions?: { url?: string } })
    .routeOptions?.url;
  const path = (routeUrl ?? request.url).split('?')[0] ?? '';
  if (request.method === 'POST' && path === '/v1/projects') {
    return 'project.create';
  }
  if (request.method === 'POST' && path === '/v1/runs') {
    return 'run.create';
  }
  if (
    request.method === 'POST' &&
    (path.endsWith('/pin') || path.endsWith('/review'))
  ) {
    return path.endsWith('/pin') ? 'run.pin' : 'run.review';
  }
  if (request.method === 'DELETE' && path.endsWith('/pin')) {
    return 'run.unpin';
  }
  if (
    request.method === 'GET' &&
    (path === '/v1/runs' || path.match(/^\/v1\/runs\/[^/]+$/))
  ) {
    return 'run.read';
  }
  if (path === '/v1/events/stream') return 'sse.replay';
  if (request.method === 'PUT' && path.endsWith('/workflow-draft')) {
    return 'workflow.draft.save';
  }
  if (request.method === 'POST' && path.endsWith('/workflow-revisions')) {
    return 'workflow.revision.create';
  }
  if (request.method === 'POST' && path.endsWith('/validate')) {
    return 'workflow.revision.validate';
  }
  if (request.method === 'POST' && path.endsWith('/managed-attempts')) {
    return 'attempt.create_managed';
  }
  if (request.method === 'POST' && path.endsWith('/attempts')) {
    return 'attempt.create';
  }
  if (
    request.method === 'POST' &&
    (path.endsWith('/accept') || path.endsWith('/reject'))
  ) {
    return 'review.apply';
  }
  if (path.endsWith('/events/stream')) return 'sse.replay';
  if (
    path.includes('/operator/recommendations/') &&
    (path.endsWith('/apply') || path.endsWith('/dismiss'))
  ) {
    return 'operator.action.apply';
  }
  if (path.endsWith('/operator/recommendations')) return 'operator.recommend';
  if (path === '/metrics') return 'metrics.scrape';
  return 'http.request';
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
  } else if (error instanceof GenerationApplicationError) {
    status = error.status;
    code = error.code;
    retryable = error.retryable;
    detail = error.message;
  } else if (error instanceof WorkflowApplicationError) {
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
  const workflowGraphJson = {
    type: 'object',
    additionalProperties: true,
  } as const;
  const workflowDraft = {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      tenantId: { type: 'string', format: 'uuid' },
      projectId: { type: 'string', format: 'uuid' },
      shotId: { type: 'string', format: 'uuid' },
      baseRevisionId: { type: 'string', format: 'uuid' },
      profileId: { type: 'string' },
      profileVersion: { type: 'string' },
      editorGraph: workflowGraphJson,
      editorGraphJson: workflowGraphJson,
      lastApiGraph: workflowGraphJson,
      lastApiGraphJson: workflowGraphJson,
      authorType: { type: 'string' },
      authorId: { type: 'string' },
      version: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  } as const;
  const workflowRevision = {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      tenantId: { type: 'string', format: 'uuid' },
      projectId: { type: 'string', format: 'uuid' },
      shotId: { type: 'string', format: 'uuid' },
      revisionNumber: { type: 'integer' },
      parentRevisionId: { type: 'string', format: 'uuid' },
      profileId: { type: 'string' },
      profileVersion: { type: 'string' },
      source: { type: 'string' },
      frontendVersion: { type: 'string' },
      frontendCommit: { type: 'string' },
      authorType: { type: 'string' },
      authorId: { type: 'string' },
      editorGraph: workflowGraphJson,
      editorGraphJson: workflowGraphJson,
      apiGraph: workflowGraphJson,
      apiGraphJson: workflowGraphJson,
      executionHash: { type: 'string' },
      executionParameters: workflowGraphJson,
      validationStatus: { type: 'string' },
      validationErrors: { type: 'array' },
      validatedAt: { type: 'string', format: 'date-time' },
      executorFingerprint: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  } as const;
  return {
    runResponse: {
      type: 'object',
      required: [
        'runId',
        'projectId',
        'revisionId',
        'executionHash',
        'status',
        'validation',
      ],
      additionalProperties: true,
    },
    runsResponse: {
      type: 'object',
      required: ['runs'],
      properties: {
        runs: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
        nextSince: { type: 'string' },
      },
      additionalProperties: true,
    },
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
    storyboardResponse: {
      type: 'object',
      required: ['proposal'],
      properties: {
        proposal: { anyOf: [proposalJsonSchema, { type: 'null' }] },
      },
    },
    costResponse: {
      type: 'object',
      properties: {
        budgetMicrousd: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        budgetUsd: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        spentMicrousd: { type: 'integer' },
        spentUsd: { type: 'string' },
        remainingMicrousd: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        remainingUsd: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    attemptResponse: {
      type: 'object',
      required: ['attempt'],
      properties: { attempt: attemptJsonSchema },
    },
    attemptsResponse: {
      type: 'object',
      required: ['attempts'],
      properties: { attempts: { type: 'array', items: attemptJsonSchema } },
    },
    attemptDetailResponse: {
      type: 'object',
      required: ['attempt'],
      properties: {
        attempt: attemptJsonSchema,
        evaluation: evaluationJsonSchema,
      },
    },
    reviewResponse: {
      type: 'object',
      required: ['attempt', 'shot', 'project'],
      properties: {
        attempt: attemptJsonSchema,
        shot: shotJsonSchema,
        project: projectJsonSchema,
      },
    },
    executorResponse: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fake', 'remote'] },
        readiness: { type: 'object', additionalProperties: true },
        frontendUrl: { type: 'string', format: 'uri' },
        activeProfileIds: { type: 'array', items: { type: 'string' } },
        capabilityFingerprint: { type: 'string' },
        capabilityValidatedAt: { type: 'string', format: 'date-time' },
        worker: { type: 'object', additionalProperties: true },
      },
    },
    workflowDraftResponse: {
      type: 'object',
      required: ['draft'],
      properties: { draft: { anyOf: [workflowDraft, { type: 'null' }] } },
    },
    workflowRevisionResponse: {
      type: 'object',
      required: ['revision'],
      properties: { revision: workflowRevision },
    },
    workflowRevisionsResponse: {
      type: 'object',
      required: ['revisions'],
      properties: { revisions: { type: 'array', items: workflowRevision } },
    },
    workflowValidationResponse: {
      type: 'object',
      required: ['revision', 'validation'],
      properties: {
        revision: workflowRevision,
        validation: { type: 'object', additionalProperties: true },
      },
    },
    recommendationsResponse: {
      type: 'object',
      required: ['recommendations'],
      properties: {
        recommendations: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
      },
    },
    recommendationResponse: {
      type: 'object',
      required: ['recommendation'],
      properties: {
        recommendation: { type: 'object', additionalProperties: true },
        attempt: attemptJsonSchema,
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
  const clock = options.clock ?? systemClock;
  const idGenerator = options.idGenerator ?? systemIdGenerator;
  const telemetry =
    options.telemetry ??
    createBufferedTelemetry(config.otelExporterOtlpEndpoint);
  const metrics = options.metrics ?? new MetricsRegistry();
  initializeCoreMetrics(metrics);
  const traceContexts =
    options.traceContexts ?? new TraceContextRegistry(telemetry);
  const generationService = new GenerationApplicationService({
    store,
    tenantId: DEV_TENANT_ID,
    idGenerator,
    clock,
    telemetry,
    metrics,
    executorMode: config.comfyMode,
    ...(options.comfyClient ? { comfyClient: options.comfyClient } : {}),
    artifactStore:
      options.artifactStore ?? createLocalArtifactStore(config.artifactRoot),
    ...(options.evaluator ? { evaluator: options.evaluator } : {}),
  });
  const workflowService = new WorkflowApplicationService({
    store,
    tenantId: DEV_TENANT_ID,
    idGenerator,
    clock,
    executor: generationService.comfyClient,
    requireExecutor: true,
    telemetry,
    metrics,
  });
  const service = new ProjectApplicationService({
    store,
    defaultBudgetMicrousd,
    clock,
    idGenerator,
  });
  const generationWorker =
    options.generationWorker ??
    new GenerationWorker({
      service: generationService,
      workerId: config.gpuWorkerId,
      leaseSeconds: config.attemptLeaseSeconds,
      timeoutSeconds: config.attemptTimeoutSeconds,
    });
  const operationalAdapter =
    options.operationalAdapter ??
    new OperationalPiAdapter({
      store,
      tenantId: DEV_TENANT_ID,
      clock,
      idGenerator,
      // The operational loop is always safe to run offline. A hosted provider
      // may be used by the separate planning adapter, but it is not required
      // to produce a bounded operational recommendation.
      provider: 'faux',
      model: 'h3-videoops-operator-v1',
      telemetry,
      metrics,
      services: (repositories) =>
        createOperationalToolServices(repositories, DEV_TENANT_ID, {
          mode: config.comfyMode,
          getExecutorReadiness:
            async (): Promise<OperationalExecutorToolView> => {
              const checkedAt = toIsoUtc(clock.now());
              try {
                const readiness =
                  await generationService.comfyClient.checkReady();
                return {
                  mode: config.comfyMode,
                  ready: readiness.ready,
                  checkedAt: readiness.checkedAt,
                  ...(readiness.capabilityFingerprint
                    ? {
                        capabilityFingerprint: readiness.capabilityFingerprint,
                      }
                    : {}),
                  ...(readiness.errorCode
                    ? { errorCode: readiness.errorCode }
                    : {}),
                };
              } catch {
                return {
                  mode: config.comfyMode,
                  ready: false,
                  checkedAt,
                  errorCode: 'EXECUTOR_UNAVAILABLE',
                };
              }
            },
        }),
    });
  // When unset, this is exactly the pre-7E-step-2 consumer: no wrapping, no
  // behavior change (`75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md` step 2 test:
  // "NOTIFY_WEBHOOK_URL unset leaves the Phase 7D behaviour unchanged").
  const operationalConsumer: OutboxConsumer = config.notifyWebhookUrl
    ? new NotifyingOutboxConsumer({
        inner: new OperationalOutboxConsumer(operationalAdapter),
        delivery: new WebhookNotificationDelivery({
          webhookUrl: config.notifyWebhookUrl,
          timeoutMs: config.notifyTimeoutMs,
          ...(options.notifyFetchImpl
            ? { fetchImpl: options.notifyFetchImpl }
            : {}),
        }),
        telemetry,
      })
    : new OperationalOutboxConsumer(operationalAdapter);
  const operationalDispatcher =
    options.operationalDispatcher ??
    new OutboxDispatcher(store, operationalConsumer, clock);
  const operationalWorker = new OperationalOutboxWorker({
    dispatcher: operationalDispatcher,
  });
  const authToken =
    config.devAuthToken || (config.nodeEnv === 'test' ? 'test-token' : '');
  const schemas = baseRouteSchemas();
  const requestRoots = new WeakMap<FastifyRequest, TelemetrySpanHandle>();
  const requestOperations = new WeakMap<FastifyRequest, TelemetrySpanHandle>();

  const safeMetric = (work: () => void): void => {
    try {
      work();
    } catch {
      // Metrics are diagnostic and must never change business behavior.
    }
  };

  const finishRequestTelemetry = (
    request: FastifyRequest,
    statusCode: number,
  ): void => {
    const status = statusCode >= 400 ? 'error' : 'ok';
    const operation = requestOperations.get(request);
    if (operation) {
      operation.setAttributes({
        status,
        code: String(statusCode),
      });
      operation.setStatus(status);
      operation.end();
      requestOperations.delete(request);
    }
    const root = requestRoots.get(request);
    if (root) {
      root.setAttributes({ status, code: String(statusCode) });
      root.setStatus(status);
      root.end();
      requestRoots.delete(request);
    }
  };

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

  app.addHook('onRoute', (routeOptions) => {
    const url = routeOptions.url;
    const legacyRoute =
      url === '/v1/projects' ||
      url.startsWith('/v1/projects/') ||
      url.startsWith('/v1/shots/') ||
      url.startsWith('/v1/attempts/');
    if (!legacyRoute) {
      return;
    }
    routeOptions.schema = {
      ...(routeOptions.schema ?? {}),
      deprecated: true,
    };
  });

  void app.register(cors, {
    origin: config.webOrigin,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  void app.register(swagger, {
    openapi: {
      info: {
        title: 'H3 VideoOps API',
        description:
          'Phase 4 Pi planning, policy tools, and durable preview API.',
        version: '0.4.0',
      },
      tags: [
        { name: 'projects', description: 'Project and storyboard operations' },
        {
          name: 'generation',
          description: 'Preview attempts and human review',
        },
      ],
    },
  });

  app.decorate('generationService', generationService);
  app.decorate('workflowService', workflowService);
  app.decorate('generationWorker', generationWorker);
  app.decorate('operationalPiAdapter', operationalAdapter);
  app.decorate('operationalDispatcher', operationalDispatcher);
  app.decorate('operationalWorker', operationalWorker);
  if (options.startGenerationWorker) {
    void generationWorker.run();
    app.addHook('onClose', async () => {
      await generationWorker.stop();
    });
  }
  if (options.startOperationalWorker) {
    void operationalWorker.run();
    app.addHook('onClose', async () => {
      await operationalWorker.stop();
    });
  }
  app.addHook('onClose', async () => {
    await telemetry.flush();
  });
  void app.register(swaggerUi, { routePrefix: '/documentation' });

  app.addHook('onRequest', async (request) => {
    const traceId = traceIdFor(request);
    const root = traceContexts.startRoot('http.request', traceId as TraceId, {
      operation: requestOperationName(request),
    });
    requestRoots.set(request, root);
    const operationName = requestOperationName(request);
    if (operationName !== 'http.request') {
      requestOperations.set(
        request,
        traceContexts.start(operationName, traceId, {
          operation: operationName,
        }),
      );
    }
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

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-trace-id', traceIdFor(request));
  });
  app.addHook('onResponse', async (request, reply) => {
    finishRequestTelemetry(request, reply.statusCode);
  });
  app.addHook('onError', async (request, reply) => {
    finishRequestTelemetry(
      request,
      reply.statusCode >= 400 ? reply.statusCode : 500,
    );
  });

  app.setErrorHandler((error, request, reply) => {
    if (
      error instanceof GenerationApplicationError &&
      (error.code === 'BUDGET_EXCEEDED' ||
        error.code === 'ATTEMPT_LIMIT_REACHED')
    ) {
      safeMetric(() =>
        metrics.increment('video_budget_denials_total', {
          operation: 'generate',
        }),
      );
    }
    return sendProblem(request, reply, error);
  });

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

    routes.get('/metrics', async (_request, reply) =>
      reply
        .code(200)
        .type('text/plain; version=0.0.4')
        .send(metrics.renderPrometheus()),
    );

    routes.get(
      '/v1/executor',
      {
        schema: {
          tags: ['generation'],
          summary: 'Get safe executor readiness and worker state',
          response: { 200: schemas.executorResponse },
        },
      },
      async () => {
        let readiness: ComfyReadiness;
        try {
          readiness = await generationService.comfyClient.checkReady();
        } catch {
          readiness = {
            ready: false,
            checkedAt: toIsoUtc(clock.now()),
            errorCode: 'COMFY_UNAVAILABLE',
          };
        }
        safeMetric(() =>
          metrics.set(
            'video_executor_ready',
            { executor_mode: config.comfyMode },
            readiness.ready ? 1 : 0,
          ),
        );
        let queue: { pending: number; running: number } = {
          pending: 0,
          running: 0,
        };
        if (readiness.ready) {
          try {
            queue = safeQueueCounts(
              await generationService.comfyClient.getQueue(),
            );
          } catch {
            queue = { pending: 0, running: 0 };
          }
        }
        return {
          mode: config.comfyMode,
          readiness: safeReadinessResponse(readiness),
          ...(config.comfyMode === 'remote'
            ? { frontendUrl: config.comfyFrontendUrl }
            : {}),
          activeProfileIds: [MINIMAX_H3_PROFILE_ID],
          ...(readiness.capabilityFingerprint
            ? { capabilityFingerprint: readiness.capabilityFingerprint }
            : {}),
          capabilityValidatedAt: readiness.checkedAt,
          worker: {
            state: options.startGenerationWorker ? 'running' : 'idle',
            queuePending: queue.pending,
            queueRunning: queue.running,
          },
        };
      },
    );

    routes.post(
      '/v1/runs',
      {
        schema: {
          tags: ['generation'],
          summary: 'Submit a graph-first durable run',
          body: {
            type: 'object',
            required: ['editorGraph', 'apiGraph'],
            properties: {
              editorGraph: { type: 'object', additionalProperties: true },
              apiGraph: { type: 'object', additionalProperties: true },
              label: { type: 'string', minLength: 1, maxLength: 200 },
              projectId: { type: 'string', format: 'uuid' },
              profileId: { type: 'string', minLength: 1, maxLength: 128 },
              idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
              executionHash: { type: 'string' },
            },
            additionalProperties: false,
          },
          response: { 201: schemas.runResponse, 422: schemas.runResponse },
        },
      },
      async (request, reply) => {
        const body = parseBody(runBodySchema, request.body) as RunBody;
        const suppliedHeaderKey = headerValue(
          request,
          'idempotency-key',
        )?.trim();
        if (
          suppliedHeaderKey &&
          body.idempotencyKey &&
          suppliedHeaderKey !== body.idempotencyKey
        ) {
          throw new HttpProblemError(
            'IDEMPOTENCY_KEY_CONFLICT',
            'The Idempotency-Key header and body value must match.',
            422,
            false,
          );
        }
        const key = idempotencyKey(request, body.idempotencyKey);
        const projectId = body.projectId
          ? bodyUuid(body.projectId, 'projectId')
          : undefined;
        const traceId = traceIdFor(request);
        const metadata = deriveWorkflowRunMetadata(body.apiGraph);
        const directMutationKey = (suffix: string): string =>
          createHash('sha256')
            .update(`run:${key}:${suffix}`, 'utf8')
            .digest('hex');
        let budgetDenialScope:
          | { readonly projectId: Uuid; readonly shotId: Uuid }
          | undefined;
        await service.withTransaction((repositories) =>
          repositories.tenants.ensure(
            service.tenantId,
            'Development tenant',
            toIsoUtc(clock.now()),
          ),
        );
        let response: IdempotentResponse;
        try {
          response = await executeIdempotent(
            request,
            service,
            'run.create',
            body,
            async (repositories) => {
              let project: VideoProject;
              if (projectId) {
                const existing = await repositories.projects.findById(
                  service.tenantId,
                  projectId,
                );
                if (!existing) {
                  throw new HttpProblemError(
                    'PROJECT_NOT_FOUND',
                    'The requested project was not found.',
                    404,
                    false,
                  );
                }
                project = existing;
              } else {
                const now = toIsoUtc(clock.now());
                project = await service.createProjectInTransaction(
                  repositories,
                  {
                    title: body.label ?? `Run ${now}`,
                    brief: 'Direct workflow submission.',
                    targetDurationSeconds: metadata.durationSeconds,
                    budgetMicrousd: null,
                    initialStatus: 'ready_for_generation',
                    autoCreated: true,
                    traceId,
                  },
                );
              }
              project = await service.prepareDirectRunProjectInTransaction(
                repositories,
                project.id,
                traceId,
              );
              const shot = await service.createImplicitShotInTransaction(
                repositories,
                project.id,
                {
                  purpose: body.label ?? 'Direct run',
                  prompt: metadata.prompt,
                  durationSeconds: metadata.durationSeconds,
                  traceId,
                },
              );
              budgetDenialScope = { projectId: project.id, shotId: shot.id };
              const draft =
                await workflowService.saveWorkflowDraftInTransaction(
                  repositories,
                  project.id,
                  shot.id,
                  {
                    idempotencyKey: directMutationKey('draft'),
                    editorGraphJson: body.editorGraph as WorkflowGraph,
                    lastApiGraphJson: body.apiGraph as WorkflowGraph,
                    ...(body.profileId ? { profileId: body.profileId } : {}),
                    authorType: 'direct_run',
                    authorId: 'direct-run',
                    traceId,
                  },
                );
              const revisionResult =
                await workflowService.createWorkflowRevisionInTransaction(
                  repositories,
                  project.id,
                  shot.id,
                  {
                    idempotencyKey: directMutationKey('revision'),
                    editorGraphJson: body.editorGraph as WorkflowGraph,
                    apiGraphJson: body.apiGraph as WorkflowGraph,
                    ...(body.profileId ? { profileId: body.profileId } : {}),
                    source: 'comfy_editor',
                    authorType: 'direct_run',
                    authorId: 'direct-run',
                    traceId,
                  },
                );
              const revision = revisionResult.revision;
              if (revisionResult.validation.errors.length > 0) {
                return {
                  status: 422,
                  body: {
                    runId: null,
                    projectId: project.id,
                    revisionId: revision.id,
                    executionHash: revision.executionHash,
                    status: 'invalid',
                    validation: {
                      status: revision.validationStatus,
                      errors: revision.validationErrorsJson,
                    },
                  },
                };
              }
              const attempt =
                await generationService.createManagedAttemptInTransaction(
                  repositories,
                  project.id,
                  shot.id,
                  {
                    idempotencyKey: directMutationKey('attempt'),
                    workflowRevisionId: revision.id,
                    traceId,
                  },
                );
              await generationService.appendEvent(repositories, {
                type: 'run.created',
                projectId: project.id,
                shotId: shot.id,
                attemptId: attempt.id,
                traceId,
                payload: {
                  runId: attempt.id,
                  projectId: project.id,
                  revisionId: revision.id,
                  executionHash: revision.executionHash,
                  autoCreatedProject: project.autoCreated === true,
                },
              });
              // Keep the draft in scope for auditability even though the response
              // intentionally exposes only the run-level records.
              void draft;
              return {
                status: 201,
                body: {
                  runId: attempt.id,
                  projectId: project.id,
                  revisionId: revision.id,
                  executionHash: revision.executionHash,
                  status: attempt.status,
                  validation: {
                    status: revision.validationStatus,
                    errors: revision.validationErrorsJson,
                  },
                },
              };
            },
            key,
          );
        } catch (error) {
          if (
            error instanceof GenerationApplicationError &&
            error.code === 'BUDGET_EXCEEDED' &&
            budgetDenialScope
          ) {
            await generationService.recordBudgetDenialAfterRollback(
              budgetDenialScope.projectId,
              budgetDenialScope.shotId,
              traceId,
            );
          }
          throw error;
        }
        return reply.code(response.status as 201 | 422).send(response.body);
      },
    );

    routes.get(
      '/v1/runs',
      {
        schema: {
          tags: ['generation'],
          summary: 'List denormalized graph-first runs',
          querystring: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              reviewed: { type: 'string', enum: ['true', 'false'] },
              pinned: { type: 'string', enum: ['true', 'false'] },
              evaluation: {
                type: 'string',
                enum: ['passed', 'failed', 'not-run'],
              },
              projectId: { type: 'string', format: 'uuid' },
              since: { type: 'string', maxLength: 200 },
              limit: { type: 'integer', minimum: 1, maximum: 100 },
            },
            additionalProperties: false,
          },
          response: { 200: schemas.runsResponse },
        },
      },
      async (request) => {
        const status = queryValue(request, 'status');
        if (status && !isGenerationAttemptStatus(status)) {
          throw new HttpProblemError(
            'INVALID_QUERY',
            'status is not a recognized run lifecycle status.',
            422,
            false,
          );
        }
        const evaluation = queryValue(request, 'evaluation');
        if (
          evaluation !== undefined &&
          evaluation !== 'passed' &&
          evaluation !== 'failed' &&
          evaluation !== 'not-run'
        ) {
          throw new HttpProblemError(
            'INVALID_QUERY',
            'evaluation must be passed, failed, or not-run.',
            422,
            false,
          );
        }
        const projectFilter = queryValue(request, 'projectId');
        let projectIdFilter: Uuid | undefined;
        if (projectFilter !== undefined) {
          try {
            projectIdFilter = assertProjectUuid(projectFilter);
          } catch {
            throw new HttpProblemError(
              'INVALID_QUERY',
              'projectId is invalid.',
              422,
              false,
            );
          }
        }
        const reviewed = queryBoolean(request, 'reviewed');
        const pinned = queryBoolean(request, 'pinned');
        const limit = queryLimit(request);
        const since = queryValue(request, 'since');
        // Ordering, filtering and pagination all run against attempt rows,
        // which already carry status, review decision and creation time. Only
        // the requested page is then expanded into a full aggregate, so the
        // request cost tracks `limit` rather than the tenant's whole history.
        const { pageRuns, hasMore } = await service.withTransaction(
          async (repositories) => {
            const projects = projectIdFilter
              ? ([
                  await repositories.projects.findById(
                    service.tenantId,
                    projectIdFilter,
                  ),
                ].filter(Boolean) as VideoProject[])
              : await repositories.projects.listByTenant(service.tenantId);

            const candidates: GenerationAttempt[] = [];
            const pinnedAttemptIds = new Set<string>();
            for (const project of projects) {
              if (pinned !== undefined) {
                for (const shot of await repositories.shots.listByProject(
                  project.id,
                )) {
                  if (shot.pinnedAttemptId) {
                    pinnedAttemptIds.add(shot.pinnedAttemptId);
                  }
                }
              }
              candidates.push(
                ...(await repositories.attempts.listByProject(
                  service.tenantId,
                  project.id,
                )),
              );
            }

            let ordered = candidates
              .filter((attempt) => {
                if (status && attempt.status !== status) return false;
                if (
                  reviewed !== undefined &&
                  (attempt.reviewDecision !== undefined) !== reviewed
                ) {
                  return false;
                }
                if (
                  pinned !== undefined &&
                  pinnedAttemptIds.has(attempt.id) !== pinned
                ) {
                  return false;
                }
                return true;
              })
              .sort(
                (left, right) =>
                  right.createdAt.localeCompare(left.createdAt) ||
                  right.id.localeCompare(left.id),
              );

            if (since !== undefined) {
              const cursorIndex = ordered.findIndex(
                (attempt) => attempt.id === since,
              );
              if (cursorIndex >= 0) {
                ordered = ordered.slice(cursorIndex + 1);
              } else {
                const sinceTime = Date.parse(since);
                if (!Number.isFinite(sinceTime)) {
                  throw new HttpProblemError(
                    'INVALID_QUERY',
                    'since must be a run cursor or ISO timestamp.',
                    422,
                    false,
                  );
                }
                ordered = ordered.filter(
                  (attempt) => Date.parse(attempt.createdAt) < sinceTime,
                );
              }
            }

            // Expand lazily: the evaluation filter needs the aggregate, so keep
            // pulling candidates until the page is full or they run out.
            const cache = createRunLookupCache();
            const collected: RunAggregate[] = [];
            for (const attempt of ordered) {
              if (collected.length > limit) break;
              const aggregate = await loadRunAggregate(
                repositories,
                service.tenantId,
                attempt.id,
                cache,
              );
              if (!aggregate) continue;
              if (
                evaluation &&
                (aggregate.evaluation?.status ?? 'not-run') !== evaluation
              ) {
                continue;
              }
              collected.push(aggregate);
            }
            return {
              pageRuns: collected.slice(0, limit),
              hasMore: collected.length > limit,
            };
          },
        );
        return {
          runs: pageRuns.map(runResponse),
          ...(hasMore && pageRuns.length > 0
            ? { nextSince: pageRuns[pageRuns.length - 1]?.attempt.id }
            : {}),
        };
      },
    );

    routes.get(
      '/v1/runs/:runId',
      {
        schema: {
          tags: ['generation'],
          summary: 'Get one fully denormalized graph-first run',
          params: {
            type: 'object',
            required: ['runId'],
            properties: { runId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: schemas.runResponse },
        },
      },
      async (request) => {
        const runId = resourceParam(request, 'runId');
        const aggregate = await service.withTransaction((repositories) =>
          loadRunAggregate(repositories, service.tenantId, runId),
        );
        if (!aggregate) {
          throw new HttpProblemError(
            'RUN_NOT_FOUND',
            'The requested run was not found.',
            404,
            false,
          );
        }
        return runResponse(aggregate);
      },
    );

    routes.post(
      '/v1/runs/:runId/pin',
      {
        schema: {
          tags: ['generation'],
          summary: 'Pin a run as the keeper without lifecycle gates',
          params: {
            type: 'object',
            required: ['runId'],
            properties: { runId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: schemas.runResponse },
        },
      },
      async (request, reply) => {
        const runId = resourceParam(request, 'runId');
        const response = await executeIdempotent(
          request,
          service,
          `run.pin:${runId}`,
          {},
          async (repositories) => {
            await generationService.pinAttemptInTransaction(
              repositories,
              runId,
            );
            const aggregate = await loadRunAggregate(
              repositories,
              service.tenantId,
              runId,
            );
            if (!aggregate) {
              throw new HttpProblemError(
                'RUN_NOT_FOUND',
                'The requested run was not found.',
                404,
                false,
              );
            }
            return { status: 200, body: runResponse(aggregate) };
          },
        );
        return reply.code(response.status as 200).send(response.body);
      },
    );

    routes.delete(
      '/v1/runs/:runId/pin',
      {
        schema: {
          tags: ['generation'],
          summary: 'Unpin a run without lifecycle gates',
          params: {
            type: 'object',
            required: ['runId'],
            properties: { runId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: schemas.runResponse },
        },
      },
      async (request, reply) => {
        const runId = resourceParam(request, 'runId');
        const response = await executeIdempotent(
          request,
          service,
          `run.unpin:${runId}`,
          {},
          async (repositories) => {
            await generationService.unpinAttemptInTransaction(
              repositories,
              runId,
            );
            const aggregate = await loadRunAggregate(
              repositories,
              service.tenantId,
              runId,
            );
            if (!aggregate) {
              throw new HttpProblemError(
                'RUN_NOT_FOUND',
                'The requested run was not found.',
                404,
                false,
              );
            }
            return { status: 200, body: runResponse(aggregate) };
          },
        );
        return reply.code(response.status as 200).send(response.body);
      },
    );

    routes.post(
      '/v1/runs/:runId/review',
      {
        schema: {
          tags: ['generation'],
          summary: 'Annotate a run review without changing lifecycle status',
          params: {
            type: 'object',
            required: ['runId'],
            properties: { runId: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            required: ['decision'],
            properties: {
              decision: { type: 'string', enum: ['accepted', 'rejected'] },
              note: { type: 'string', maxLength: 2_000 },
            },
            additionalProperties: false,
          },
          response: { 200: schemas.runResponse },
        },
      },
      async (request, reply) => {
        const runId = resourceParam(request, 'runId');
        const body = parseBody(
          runReviewBodySchema,
          request.body,
        ) as RunReviewBody;
        const rawAuthor = headerValue(request, 'x-operator-id')?.trim();
        const author = rawAuthor || 'development-user';
        if (author.length > 200) {
          throw new HttpProblemError(
            'INVALID_REVIEW_AUTHOR',
            'The review author is too long.',
            422,
            false,
          );
        }
        const response = await executeIdempotent(
          request,
          service,
          `run.review:${runId}`,
          body,
          async (repositories) => {
            await generationService.reviewAttemptInTransaction(
              repositories,
              runId,
              body.decision,
              body.note?.trim() || null,
              author,
            );
            const aggregate = await loadRunAggregate(
              repositories,
              service.tenantId,
              runId,
            );
            if (!aggregate) {
              throw new HttpProblemError(
                'RUN_NOT_FOUND',
                'The requested run was not found.',
                404,
                false,
              );
            }
            return { status: 200, body: runResponse(aggregate) };
          },
        );
        return reply.code(response.status as 200).send(response.body);
      },
    );

    routes.get(
      '/v1/events/stream',
      {
        schema: {
          tags: ['generation'],
          summary: 'Replay tenant-scoped run events over SSE',
        },
      },
      async (request, reply) => {
        safeMetric(() => metrics.set('video_sse_connections', {}, 1));
        const rawLastEventId = headerValue(request, 'last-event-id');
        let lastEventId = 0;
        if (rawLastEventId !== undefined) {
          if (!/^\d+$/.test(rawLastEventId.trim())) {
            throw new HttpProblemError(
              'INVALID_LAST_EVENT_ID',
              'Last-Event-ID must be a durable numeric event sequence.',
              400,
              false,
            );
          }
          lastEventId = Number(rawLastEventId);
          if (!Number.isSafeInteger(lastEventId)) {
            throw new HttpProblemError(
              'INVALID_LAST_EVENT_ID',
              'Last-Event-ID is outside the supported sequence range.',
              400,
              false,
            );
          }
        }
        const events = await service.withTransaction(async (repositories) => {
          const projects = await repositories.projects.listByTenant(
            service.tenantId,
          );
          const values: DomainEvent[] = [];
          for (const project of projects) {
            values.push(
              ...(await repositories.events.listByProject(project.id)),
            );
          }
          return values.sort(
            (left, right) =>
              (left.eventSequence ?? 0) - (right.eventSequence ?? 0),
          );
        });
        const frames = events
          .map((event, index) => ({
            event,
            sequence: event.eventSequence ?? index + 1,
          }))
          .filter(({ sequence }) => sequence > lastEventId)
          .map(
            ({ event, sequence }) =>
              `id: ${sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(
                (() => {
                  const summary = sanitizedEventSummary(event);
                  delete summary.shotId;
                  return summary;
                })(),
              )}\n\n`,
          )
          .join('');
        const response = reply
          .code(200)
          .headers({
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'content-type': 'text/event-stream; charset=utf-8',
            'x-content-type-options': 'nosniff',
          })
          .send(`${frames}: heartbeat\n\n`);
        safeMetric(() => metrics.set('video_sse_connections', {}, 0));
        return response;
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
                traceId: traceIdFor(request),
                budgetMicrousd: parseBudget(
                  body,
                  service.defaultBudgetMicrousd,
                ),
              },
            );
            safeMetric(() =>
              metrics.increment('video_projects_total', {
                status: project.status,
              }),
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

    routes.get(
      '/v1/workflow-revisions/:revisionId',
      {
        schema: {
          tags: ['generation'],
          summary: 'Get an immutable workflow revision',
          response: { 200: schemas.workflowRevisionResponse },
        },
      },
      async (request) => {
        const revision = await workflowService.getWorkflowRevisionById(
          resourceParam(request, 'revisionId'),
        );
        if (!revision) {
          throw new WorkflowApplicationError(
            'WORKFLOW_REVISION_NOT_FOUND',
            'The workflow revision was not found.',
            404,
          );
        }
        return { revision: workflowRevisionResponse(revision) };
      },
    );

    routes.post(
      '/v1/workflow-revisions/:revisionId/validate',
      {
        schema: {
          tags: ['generation'],
          summary: 'Revalidate a workflow revision against the executor',
          body: { type: 'object', additionalProperties: false },
          response: { 200: schemas.workflowValidationResponse },
        },
      },
      async (request, reply) => {
        const revisionId = resourceParam(request, 'revisionId');
        parseBody(z.object({}).strict(), request.body);
        const existing =
          await workflowService.getWorkflowRevisionById(revisionId);
        if (!existing) {
          throw new WorkflowApplicationError(
            'WORKFLOW_REVISION_NOT_FOUND',
            'The workflow revision was not found.',
            404,
          );
        }
        const response = await executeIdempotent(
          request,
          service,
          `workflow.revision.validate:${revisionId}`,
          {},
          async (repositories) => {
            const result =
              await workflowService.validateWorkflowRevisionInTransaction(
                repositories,
                existing.projectId,
                existing.shotId,
                revisionId,
                undefined,
                traceIdFor(request),
              );
            return {
              status: 200,
              body: {
                revision: workflowRevisionResponse(result.revision),
                validation: validationResponse(result.validation),
              },
            };
          },
        );
        return reply.code(response.status as 200).send(response.body);
      },
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
      '/v1/projects/:projectId/events/stream',
      {
        schema: {
          tags: ['projects'],
          summary: 'Replay sanitized project events over SSE',
        },
      },
      async (request, reply) => {
        safeMetric(() => metrics.set('video_sse_connections', {}, 1));
        const rawLastEventId = headerValue(request, 'last-event-id');
        let lastEventId = 0;
        if (rawLastEventId !== undefined) {
          if (!/^\d+$/.test(rawLastEventId.trim())) {
            throw new HttpProblemError(
              'INVALID_LAST_EVENT_ID',
              'Last-Event-ID must be a durable numeric event sequence.',
              400,
              false,
            );
          }
          lastEventId = Number(rawLastEventId);
          if (!Number.isSafeInteger(lastEventId)) {
            throw new HttpProblemError(
              'INVALID_LAST_EVENT_ID',
              'Last-Event-ID is outside the supported sequence range.',
              400,
              false,
            );
          }
        }
        const events = await service.listEvents(parseProjectId(request));
        const frames = events
          .map((event, index) => ({
            event,
            sequence: event.eventSequence ?? index + 1,
          }))
          .filter(({ sequence }) => sequence > lastEventId)
          .map(
            ({ event, sequence }) =>
              `id: ${sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(
                sanitizedEventSummary(event),
              )}\n\n`,
          )
          .join('');
        const response = reply
          .code(200)
          .headers({
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'content-type': 'text/event-stream; charset=utf-8',
            'x-content-type-options': 'nosniff',
          })
          .send(`${frames}: heartbeat\n\n`);
        safeMetric(() => metrics.set('video_sse_connections', {}, 0));
        return response;
      },
    );

    routes.route({
      method: ['GET', 'HEAD'],
      url: '/v1/artifacts/:artifactId/content',
      schema: {
        tags: ['generation'],
        summary: 'Stream an authenticated artifact with optional byte range',
      },
      handler: async (request, reply) => {
        const artifactId = resourceParam(request, 'artifactId');
        const artifact = await store.withTransaction((repositories) =>
          repositories.artifacts.findById(service.tenantId, artifactId),
        );
        if (!artifact) {
          throw new HttpProblemError(
            'ARTIFACT_NOT_FOUND',
            'The requested artifact was not found.',
            404,
            false,
          );
        }
        const rangeHeader = headerValue(request, 'range');
        const range = parseByteRange(rangeHeader, artifact.byteSize);
        if (rangeHeader !== undefined && !range) {
          return rangeProblem(request, reply, artifact.byteSize);
        }
        const start = range?.start ?? 0;
        const end = range?.end ?? artifact.byteSize - 1;
        const contentLength = end - start + 1;
        const headers: Record<string, string> = {
          'accept-ranges': 'bytes',
          'cache-control': 'private, no-transform',
          'content-disposition': `inline; filename="artifact-${artifact.id}"`,
          'content-length': String(contentLength),
          'content-type': artifact.mimeType,
          etag: `"${artifact.sha256}"`,
          'x-content-type-options': 'nosniff',
        };
        if (range) {
          headers['content-range'] =
            `bytes ${range.start}-${range.end}/${artifact.byteSize}`;
        }
        if (request.method === 'HEAD') {
          return reply
            .code(range ? 206 : 200)
            .headers(headers)
            .send();
        }
        try {
          if (range && generationService.artifactStore.openRange) {
            const stream = await generationService.artifactStore.openRange(
              artifact.id,
              range.start,
              range.end,
            );
            return reply.code(206).headers(headers).send(stream);
          }
          if (range) {
            const bytes = await generationService.artifactStore.read(
              artifact.id,
            );
            return reply
              .code(206)
              .headers(headers)
              .send(Buffer.from(bytes.subarray(start, end + 1)));
          }
          const stream = await generationService.artifactStore.open(
            artifact.id,
          );
          return reply.code(200).headers(headers).send(stream);
        } catch {
          throw new HttpProblemError(
            'ARTIFACT_UNAVAILABLE',
            'The artifact content is temporarily unavailable.',
            404,
            true,
            false,
          );
        }
      },
    });

    routes.get(
      '/v1/projects/:projectId/operator/recommendations',
      {
        schema: {
          tags: ['projects'],
          summary: 'List persisted operator recommendations',
          response: { 200: schemas.recommendationsResponse },
        },
      },
      async (request) => {
        const projectId = parseProjectId(request);
        await service.getProject(projectId);
        const recommendations = await store.withTransaction((repositories) =>
          repositories.operationalRecommendations.listByProject(
            service.tenantId,
            projectId,
          ),
        );
        return { recommendations: recommendations.map(recommendationResponse) };
      },
    );

    routes.post(
      '/v1/projects/:projectId/operator/recommendations/:recommendationId/apply',
      {
        schema: {
          tags: ['projects'],
          summary: 'Apply a persisted recommendation after human approval',
          body: {
            type: 'object',
            properties: { expectedVersion: { type: 'integer', minimum: 1 } },
            additionalProperties: true,
          },
          response: { 200: schemas.recommendationResponse },
        },
      },
      async (request, reply) => {
        const projectId = parseProjectId(request);
        const recommendationId = resourceParam(request, 'recommendationId');
        const body = parseBody(
          recommendationActionBodySchema,
          request.body,
        ) as RecommendationActionBody;
        const key = idempotencyKey(request);
        const response = await executeIdempotent(
          request,
          service,
          `recommendation.apply:${projectId}:${recommendationId}`,
          body,
          async (repositories) => {
            const recommendation =
              await repositories.operationalRecommendations.findById(
                service.tenantId,
                projectId,
                recommendationId,
              );
            if (!recommendation) {
              throw new HttpProblemError(
                'RECOMMENDATION_NOT_FOUND',
                'The operator recommendation was not found.',
                404,
                false,
              );
            }
            if (recommendation.status !== 'pending') {
              throw new HttpProblemError(
                'RECOMMENDATION_NOT_PENDING',
                'Only a pending recommendation can be applied.',
                409,
                false,
              );
            }
            const expectedVersion =
              body.expectedVersion ?? recommendation.version;
            let attempt: GenerationAttempt | undefined;
            let retryAttemptId: Uuid | undefined;
            if (recommendation.proposedActionType === 'retry_attempt') {
              const recommendationAttemptId = recommendation.attemptId;
              if (!recommendationAttemptId) {
                throw new HttpProblemError(
                  'RECOMMENDATION_ACTION_INVALID',
                  'The retry recommendation does not identify an attempt.',
                  409,
                  false,
                );
              }
              const sourceAttempt = await repositories.attempts.findById(
                service.tenantId,
                recommendationAttemptId,
              );
              if (!sourceAttempt || sourceAttempt.projectId !== projectId) {
                throw new HttpProblemError(
                  'ATTEMPT_NOT_FOUND',
                  'The recommendation source attempt was not found.',
                  404,
                  false,
                );
              }
              let executorReady = false;
              try {
                executorReady = (
                  await generationService.comfyClient.checkReady()
                ).ready;
              } catch {
                executorReady = false;
              }
              if (!executorReady) {
                throw new HttpProblemError(
                  'EXECUTOR_UNAVAILABLE',
                  'The execution service is not ready for a retry.',
                  503,
                  true,
                );
              }
              if (sourceAttempt.workflowRevisionId) {
                const validation =
                  await workflowService.validateWorkflowRevisionInTransaction(
                    repositories,
                    projectId,
                    sourceAttempt.shotId,
                    sourceAttempt.workflowRevisionId,
                    undefined,
                    traceIdFor(request),
                  );
                if (validation.validation.errors.length > 0) {
                  throw new HttpProblemError(
                    'WORKFLOW_REVISION_INVALID',
                    'The managed workflow revision is no longer valid.',
                    409,
                    false,
                  );
                }
              }
              retryAttemptId = recommendationAttemptId;
            }
            const updated =
              await repositories.operationalRecommendations.updateStatus(
                service.tenantId,
                projectId,
                recommendationId,
                'applied',
                expectedVersion,
                toIsoUtc(clock.now()),
              );
            safeMetric(() =>
              metrics.increment('video_operator_recommendations_total', {
                code: updated.recommendationCode,
                status: updated.status,
                severity: updated.severity,
              }),
            );
            if (retryAttemptId) {
              attempt = await generationService.retryAttemptInTransaction(
                repositories,
                retryAttemptId,
                { idempotencyKey: key },
              );
            }
            return {
              status: 200,
              body: {
                recommendation: recommendationResponse(updated),
                ...(attempt ? { attempt: attemptResponse(attempt) } : {}),
              },
            };
          },
        );
        return reply.code(response.status as 200).send(response.body);
      },
    );

    routes.post(
      '/v1/projects/:projectId/operator/recommendations/:recommendationId/dismiss',
      {
        schema: {
          tags: ['projects'],
          summary: 'Dismiss a persisted operator recommendation',
          body: {
            type: 'object',
            properties: { expectedVersion: { type: 'integer', minimum: 1 } },
            additionalProperties: true,
          },
          response: { 200: schemas.recommendationResponse },
        },
      },
      async (request, reply) => {
        const projectId = parseProjectId(request);
        const recommendationId = resourceParam(request, 'recommendationId');
        const body = parseBody(
          recommendationActionBodySchema,
          request.body,
        ) as RecommendationActionBody;
        const response = await executeIdempotent(
          request,
          service,
          `recommendation.dismiss:${projectId}:${recommendationId}`,
          body,
          async (repositories) => {
            const recommendation =
              await repositories.operationalRecommendations.findById(
                service.tenantId,
                projectId,
                recommendationId,
              );
            if (!recommendation) {
              throw new HttpProblemError(
                'RECOMMENDATION_NOT_FOUND',
                'The operator recommendation was not found.',
                404,
                false,
              );
            }
            const updated =
              await repositories.operationalRecommendations.updateStatus(
                service.tenantId,
                projectId,
                recommendationId,
                'dismissed',
                body.expectedVersion ?? recommendation.version,
                toIsoUtc(clock.now()),
              );
            safeMetric(() =>
              metrics.increment('video_operator_recommendations_total', {
                code: updated.recommendationCode,
                status: updated.status,
                severity: updated.severity,
              }),
            );
            return {
              status: 200,
              body: { recommendation: recommendationResponse(updated) },
            };
          },
        );
        return reply.code(response.status as 200).send(response.body);
      },
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

    routes.get(
      '/v1/projects/:projectId/attempts',
      {
        schema: {
          tags: ['generation'],
          summary: 'List all generation attempts for a project',
          response: { 200: schemas.attemptsResponse },
        },
      },
      async (request) => ({
        attempts: (
          await generationService.listProjectAttempts(parseProjectId(request))
        ).map(attemptResponse),
      }),
    );

    routes.post(
      '/v1/shots/:shotId/attempts',
      {
        schema: {
          tags: ['generation'],
          summary: 'Queue a preview generation attempt',
          params: {
            type: 'object',
            required: ['shotId'],
            properties: { shotId: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            properties: {
              seed: { type: 'integer' },
              steps: { type: 'integer', minimum: 1, maximum: 100 },
              scenario: {
                type: 'string',
                enum: [
                  'success',
                  'duplicate-events',
                  'disconnect-reconcile',
                  'execution-failure',
                  'timeout',
                  'uncertain-submission',
                ],
              },
            },
            additionalProperties: false,
          },
          response: { 201: schemas.attemptResponse },
        },
      },
      async (request, reply) => {
        const shotId = resourceParam(request, 'shotId');
        const body = parseBody(
          createAttemptBodySchema,
          request.body,
        ) as CreateAttemptBody;
        const key = idempotencyKey(request);
        const traceId = traceIdFor(request);
        const command: CreateAttemptCommand = {
          idempotencyKey: key,
          ...(body.seed !== undefined ? { seed: body.seed } : {}),
          ...(body.steps !== undefined ? { steps: body.steps } : {}),
          ...(body.scenario !== undefined ? { scenario: body.scenario } : {}),
          traceId,
        };
        const response = await executeIdempotent(
          request,
          service,
          `shot.attempt.create:${shotId}`,
          body,
          async (repositories) => ({
            status: 201,
            body: {
              attempt: attemptResponse(
                await generationService.createAttemptInTransaction(
                  repositories,
                  shotId,
                  command,
                ),
              ),
            },
          }),
        );
        return reply.code(response.status as 201).send(response.body);
      },
    );

    routes.get(
      '/v1/shots/:shotId/attempts',
      {
        schema: {
          tags: ['generation'],
          summary: 'List generation attempts for a shot',
          params: {
            type: 'object',
            required: ['shotId'],
            properties: { shotId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: schemas.attemptsResponse },
        },
      },
      async (request) => {
        const shotId = resourceParam(request, 'shotId');
        return {
          attempts: (await generationService.listAttempts(shotId)).map(
            attemptResponse,
          ),
        };
      },
    );

    routes.get(
      '/v1/attempts/:attemptId',
      {
        schema: {
          tags: ['generation'],
          summary: 'Get an attempt and its technical evaluation',
          params: {
            type: 'object',
            required: ['attemptId'],
            properties: { attemptId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: schemas.attemptDetailResponse },
        },
      },
      async (request) => {
        const attemptId = resourceParam(request, 'attemptId');
        const attempt = await generationService.getAttempt(attemptId);
        const evaluation = await store.withTransaction((repositories) =>
          repositories.evaluations.findByAttempt(service.tenantId, attemptId),
        );
        return {
          attempt: attemptResponse(attempt),
          ...(evaluation ? { evaluation: evaluationResponse(evaluation) } : {}),
        };
      },
    );

    routes.post(
      '/v1/attempts/:attemptId/accept',
      {
        schema: {
          tags: ['generation'],
          summary: 'Accept a technically validated attempt',
          params: {
            type: 'object',
            required: ['attemptId'],
            properties: { attemptId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: schemas.reviewResponse },
        },
      },
      async (request, reply) => {
        const attemptId = resourceParam(request, 'attemptId');
        const body = request.body ?? {};
        const response = await executeIdempotent(
          request,
          service,
          `attempt.accept:${attemptId}`,
          body,
          async (repositories) => {
            const result = await generationService.acceptAttemptInTransaction(
              repositories,
              attemptId,
            );
            return {
              status: 200,
              body: {
                attempt: attemptResponse(result.attempt),
                shot: shotResponse(result.shot),
                project: projectResponse(result.project),
              },
            };
          },
        );
        return reply.code(response.status as 200).send(response.body);
      },
    );

    routes.post(
      '/v1/attempts/:attemptId/reject',
      {
        schema: {
          tags: ['generation'],
          summary: 'Reject an attempt with a stable reason code',
          params: {
            type: 'object',
            required: ['attemptId'],
            properties: { attemptId: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            required: ['reasonCode'],
            properties: {
              reasonCode: { type: 'string', minLength: 1, maxLength: 64 },
            },
            additionalProperties: false,
          },
          response: { 200: schemas.reviewResponse },
        },
      },
      async (request, reply) => {
        const attemptId = resourceParam(request, 'attemptId');
        const body = parseBody(
          rejectAttemptBodySchema,
          request.body,
        ) as RejectAttemptBody;
        const response = await executeIdempotent(
          request,
          service,
          `attempt.reject:${attemptId}`,
          body,
          async (repositories) => {
            const result = await generationService.rejectAttemptInTransaction(
              repositories,
              attemptId,
              body.reasonCode,
            );
            return {
              status: 200,
              body: {
                attempt: attemptResponse(result.attempt),
                shot: shotResponse(result.shot),
                project: projectResponse(result.project),
              },
            };
          },
        );
        return reply.code(response.status as 200).send(response.body);
      },
    );

    routes.post(
      '/v1/attempts/:attemptId/retry',
      {
        schema: {
          tags: ['generation'],
          summary: 'Create a derived retry attempt',
          params: {
            type: 'object',
            required: ['attemptId'],
            properties: { attemptId: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            properties: { resolveUncertain: { type: 'boolean', const: true } },
            additionalProperties: true,
          },
          response: { 201: schemas.attemptResponse },
        },
      },
      async (request, reply) => {
        const attemptId = resourceParam(request, 'attemptId');
        const body = parseBody(
          retryAttemptBodySchema,
          request.body,
        ) as RetryAttemptBody;
        const key = idempotencyKey(request);
        const traceId = traceIdFor(request);
        const command: RetryAttemptCommand = {
          idempotencyKey: key,
          traceId,
          ...(body.resolveUncertain ? { resolveUncertain: true } : {}),
        };
        const response = await executeIdempotent(
          request,
          service,
          `attempt.retry:${attemptId}`,
          body,
          async (repositories) => ({
            status: 201,
            body: {
              attempt: attemptResponse(
                await generationService.retryAttemptInTransaction(
                  repositories,
                  attemptId,
                  command,
                ),
              ),
            },
          }),
        );
        return reply.code(response.status as 201).send(response.body);
      },
    );
  });

  return app;
}

export async function startApi(
  config: ApiConfig = getApiConfig(),
  options: StartApiOptions = {},
): Promise<FastifyInstance> {
  const comfyClient =
    options.comfyClient ?? createConfiguredComfyClient(config);
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
    comfyClient,
    startGenerationWorker: true,
    startOperationalWorker: true,
  });

  app.addHook('onClose', async () => {
    await pool.end();
  });

  await app.listen({ host: config.apiHost, port: config.apiPort });
  return app;
}
