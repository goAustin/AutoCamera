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
  systemClock,
  systemIdGenerator,
  toIsoUtc,
  type Clock,
  type DomainEvent,
  type EvaluationResult,
  type GenerationAttempt,
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
  OutboxDispatcher,
  RepositoryError,
  runMigrations,
  type Repositories,
  type OperationalRecommendationRecord,
  type TransactionalStore,
  type WorkflowDraftRecord,
  type WorkflowRevisionRecord,
} from '@h3/db';
import { getApiConfig, type ApiConfig } from '@h3/config';
import type { OperationalExecutorToolView } from '@h3/agent-tools';
import {
  createTraceId,
  OpenTelemetryTelemetry,
  type AgentTelemetry,
} from '@h3/telemetry';
import { createLocalArtifactStore, type ArtifactStore } from '@h3/object-store';
import {
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
  type PlanningAgent,
} from './application.js';
import {
  PiPlanningAgent,
  PlanningAgentError,
  type FauxPlanningScript,
} from './agent.js';
import {
  GenerationApplicationService,
  GenerationApplicationError,
  GenerationWorker,
  type CreateAttemptCommand,
  type CreateManagedAttemptCommand,
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
  readonly telemetry?: AgentTelemetry;
  readonly planningScript?: FauxPlanningScript;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly comfyClient?: ComfyClient;
  readonly artifactStore?: ArtifactStore;
  readonly evaluator?: MediaEvaluator;
  readonly generationWorker?: GenerationWorker;
  readonly startGenerationWorker?: boolean;
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

const workflowDraftBodySchema = z
  .object({
    editorGraph: z.unknown().optional(),
    editorGraphJson: z.unknown().optional(),
    lastApiGraph: z.unknown().nullable().optional(),
    lastApiGraphJson: z.unknown().nullable().optional(),
    baseRevisionId: z.string().uuid().nullable().optional(),
    profileId: z.string().trim().min(1).max(128).optional(),
    profileVersion: z.string().trim().min(1).max(64).optional(),
    authorType: z.string().trim().min(1).max(64).optional(),
    authorId: z.string().trim().min(1).max(200).optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

const workflowRevisionBodySchema = z
  .object({
    editorGraph: z.unknown().optional(),
    editorGraphJson: z.unknown().optional(),
    apiGraph: z.unknown().optional(),
    apiGraphJson: z.unknown().optional(),
    parentRevisionId: z.string().uuid().nullable().optional(),
    profileId: z.string().trim().min(1).max(128).optional(),
    profileVersion: z.string().trim().min(1).max(64).optional(),
    source: z.enum(['comfy_editor', 'official_template', 'system']).optional(),
    frontendVersion: z.string().trim().min(1).max(128).optional(),
    frontendCommit: z.string().trim().min(1).max(128).optional(),
    authorType: z.string().trim().min(1).max(64).optional(),
    authorId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const managedAttemptBodySchema = z
  .object({ workflowRevisionId: z.string().uuid() })
  .strict();

const retryAttemptBodySchema = z
  .object({ resolveUncertain: z.literal(true).optional() })
  .strict();

const recommendationActionBodySchema = z
  .object({ expectedVersion: z.number().int().positive().optional() })
  // Action and execution fields in the body are deliberately ignored; the
  // persisted recommendation is the only source of truth for the operation.
  .passthrough();

type CreateAttemptBody = z.infer<typeof createAttemptBodySchema>;
type RejectAttemptBody = z.infer<typeof rejectAttemptBodySchema>;
type WorkflowDraftBody = z.infer<typeof workflowDraftBodySchema>;
type WorkflowRevisionBody = z.infer<typeof workflowRevisionBodySchema>;
type ManagedAttemptBody = z.infer<typeof managedAttemptBodySchema>;
type RetryAttemptBody = z.infer<typeof retryAttemptBodySchema>;
type RecommendationActionBody = z.infer<typeof recommendationActionBodySchema>;

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
    ...(proposal.objective ? { objective: proposal.objective } : {}),
    ...(proposal.assumptions ? { assumptions: proposal.assumptions } : {}),
    ...(proposal.risks ? { risks: proposal.risks } : {}),
    ...(proposal.agentRunId ? { agentRunId: proposal.agentRunId } : {}),
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

function workflowDraftResponse(
  draft: WorkflowDraftRecord | null,
): Record<string, unknown> {
  if (!draft) return { draft: null };
  return {
    draft: {
      id: draft.id,
      tenantId: draft.tenantId,
      projectId: draft.projectId,
      shotId: draft.shotId,
      ...(draft.baseRevisionId ? { baseRevisionId: draft.baseRevisionId } : {}),
      profileId: draft.profileId,
      profileVersion: draft.profileVersion,
      editorGraph: draft.editorGraphJson,
      editorGraphJson: draft.editorGraphJson,
      ...(draft.lastApiGraphJson
        ? {
            lastApiGraph: draft.lastApiGraphJson,
            lastApiGraphJson: draft.lastApiGraphJson,
          }
        : {}),
      authorType: draft.authorType,
      authorId: draft.authorId,
      version: draft.version,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    },
  };
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

function bodyGraph(
  body: WorkflowDraftBody | WorkflowRevisionBody,
  primary: 'editorGraph' | 'apiGraph',
  legacy: 'editorGraphJson' | 'apiGraphJson',
  label: string,
): WorkflowGraph {
  const record = body as Record<string, unknown>;
  const value = record[primary] ?? record[legacy];
  if (value === undefined) {
    throw new HttpProblemError(
      'INVALID_REQUEST',
      `${label} is required.`,
      422,
      false,
    );
  }
  return value as WorkflowGraph;
}

function bodyOptionalGraph(
  body: WorkflowDraftBody,
): WorkflowGraph | null | undefined {
  return body.lastApiGraph !== undefined
    ? (body.lastApiGraph as WorkflowGraph | null)
    : body.lastApiGraphJson !== undefined
      ? (body.lastApiGraphJson as WorkflowGraph | null)
      : undefined;
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

async function executeAsyncIdempotent(
  request: FastifyRequest,
  service: ProjectApplicationService,
  operation: string,
  body: unknown,
  mutation: () => Promise<IdempotentResponse>,
): Promise<IdempotentResponse> {
  const key = idempotencyKey(request);
  const hash = requestHash(operation, body);
  const reservation = await service.withTransaction((repositories) =>
    repositories.idempotency.reserve(
      service.tenantId,
      key,
      operation,
      hash,
      toIsoUtc(service.clock.now()),
    ),
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
  try {
    const response = await mutation();
    await service.withTransaction((repositories) =>
      repositories.idempotency.complete(
        service.tenantId,
        key,
        response.status,
        response.body,
        toIsoUtc(service.clock.now()),
      ),
    );
    return response;
  } catch (error) {
    await service.withTransaction((repositories) =>
      repositories.idempotency.release(service.tenantId, key),
    );
    throw error;
  }
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
  } else if (error instanceof PlanningAgentError) {
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
  const generationService = new GenerationApplicationService({
    store,
    tenantId: DEV_TENANT_ID,
    idGenerator,
    clock,
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
  });
  let projectService: ProjectApplicationService | undefined;
  const telemetry = options.telemetry ?? new OpenTelemetryTelemetry();
  const planner =
    options.planner ??
    new PiPlanningAgent({
      store,
      tenantId: DEV_TENANT_ID,
      clock,
      idGenerator,
      provider: config.piProvider,
      model: config.piModel,
      maxConcurrentRuns: config.piMaxConcurrentRuns,
      telemetry,
      ...(config.piApiKey ? { apiKey: config.piApiKey } : {}),
      ...(config.piBaseUrl ? { baseUrl: config.piBaseUrl } : {}),
      ...(options.planningScript ? { script: options.planningScript } : {}),
      projectService: {
        approveStoryboard: (projectId, proposalId) => {
          if (!projectService) throw new Error('project service unavailable');
          return projectService.approveStoryboard(projectId, proposalId);
        },
        getProject: (projectId) => {
          if (!projectService) throw new Error('project service unavailable');
          return projectService.getProject(projectId);
        },
        listEvents: (projectId) => {
          if (!projectService) throw new Error('project service unavailable');
          return projectService.listEvents(projectId);
        },
        listShots: (projectId) => {
          if (!projectService) throw new Error('project service unavailable');
          return projectService.listShots(projectId);
        },
      },
      generationService,
    });
  const service = new ProjectApplicationService({
    store,
    planner,
    defaultBudgetMicrousd,
    clock,
    idGenerator,
  });
  projectService = service;
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
  const operationalDispatcher =
    options.operationalDispatcher ??
    new OutboxDispatcher(
      store,
      new OperationalOutboxConsumer(operationalAdapter),
      clock,
    );
  const operationalWorker = new OperationalOutboxWorker({
    dispatcher: operationalDispatcher,
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
          summary: 'Generate a Pi-planned storyboard proposal',
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
        const response = await executeAsyncIdempotent(
          request,
          service,
          `project.plan:${projectId}`,
          body,
          async () => {
            const result = await service.planProject(projectId);
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
      '/v1/projects/:projectId/shots/:shotId/workflow-draft',
      {
        schema: {
          tags: ['generation'],
          summary: 'Get the editable workflow draft for a shot',
          response: { 200: schemas.workflowDraftResponse },
        },
      },
      async (request) => ({
        ...(await workflowDraftResponse(
          await workflowService.getWorkflowDraft(
            parseProjectId(request),
            resourceParam(request, 'shotId'),
          ),
        )),
      }),
    );

    routes.put(
      '/v1/projects/:projectId/shots/:shotId/workflow-draft',
      {
        schema: {
          tags: ['generation'],
          summary: 'Create or update a scoped workflow draft',
          body: {
            type: 'object',
            additionalProperties: true,
          },
          response: { 200: schemas.workflowDraftResponse },
        },
      },
      async (request, reply) => {
        const projectId = parseProjectId(request);
        const shotId = resourceParam(request, 'shotId');
        const body = parseBody(
          workflowDraftBodySchema,
          request.body,
        ) as WorkflowDraftBody;
        const key = idempotencyKey(request);
        const editorGraphJson = bodyGraph(
          body,
          'editorGraph',
          'editorGraphJson',
          'editorGraph',
        );
        const lastApiGraphJson = bodyOptionalGraph(body);
        const baseRevisionId = bodyUuid(body.baseRevisionId, 'baseRevisionId');
        const command = {
          idempotencyKey: key,
          editorGraphJson,
          ...(lastApiGraphJson !== undefined ? { lastApiGraphJson } : {}),
          ...(baseRevisionId !== undefined ? { baseRevisionId } : {}),
          ...(body.profileId !== undefined
            ? { profileId: body.profileId }
            : {}),
          ...(body.profileVersion !== undefined
            ? { profileVersion: body.profileVersion }
            : {}),
          authorType: body.authorType ?? 'development_user',
          authorId: body.authorId ?? 'development-user',
          ...(body.expectedVersion !== undefined
            ? { expectedVersion: body.expectedVersion }
            : {}),
        };
        const draft = await workflowService.saveWorkflowDraft(
          projectId,
          shotId,
          command,
        );
        return reply.code(200).send(workflowDraftResponse(draft));
      },
    );

    routes.post(
      '/v1/projects/:projectId/shots/:shotId/workflow-revisions',
      {
        schema: {
          tags: ['generation'],
          summary: 'Create an immutable workflow revision',
          body: {
            type: 'object',
            additionalProperties: true,
          },
          response: { 201: schemas.workflowValidationResponse },
        },
      },
      async (request, reply) => {
        const projectId = parseProjectId(request);
        const shotId = resourceParam(request, 'shotId');
        const body = parseBody(
          workflowRevisionBodySchema,
          request.body,
        ) as WorkflowRevisionBody;
        const parentRevisionId =
          body.parentRevisionId === undefined
            ? undefined
            : bodyUuid(body.parentRevisionId, 'parentRevisionId');
        const result = await workflowService.createWorkflowRevision(
          projectId,
          shotId,
          {
            idempotencyKey: idempotencyKey(request),
            editorGraphJson: bodyGraph(
              body,
              'editorGraph',
              'editorGraphJson',
              'editorGraph',
            ),
            apiGraphJson: bodyGraph(
              body,
              'apiGraph',
              'apiGraphJson',
              'apiGraph',
            ),
            ...(parentRevisionId !== undefined ? { parentRevisionId } : {}),
            ...(body.profileId !== undefined
              ? { profileId: body.profileId }
              : {}),
            ...(body.profileVersion !== undefined
              ? { profileVersion: body.profileVersion }
              : {}),
            ...(body.source !== undefined ? { source: body.source } : {}),
            ...(body.frontendVersion !== undefined
              ? { frontendVersion: body.frontendVersion }
              : {}),
            ...(body.frontendCommit !== undefined
              ? { frontendCommit: body.frontendCommit }
              : {}),
            authorType: body.authorType ?? 'development_user',
            authorId: body.authorId ?? 'development-user',
          },
        );
        return reply.code(201).send({
          revision: workflowRevisionResponse(result.revision),
          validation: validationResponse(result.validation),
        });
      },
    );

    routes.get(
      '/v1/projects/:projectId/shots/:shotId/workflow-revisions',
      {
        schema: {
          tags: ['generation'],
          summary: 'List immutable workflow revisions for a shot',
          response: { 200: schemas.workflowRevisionsResponse },
        },
      },
      async (request) => ({
        revisions: (
          await workflowService.listWorkflowRevisions(
            parseProjectId(request),
            resourceParam(request, 'shotId'),
          )
        ).map(workflowRevisionResponse),
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
        return reply
          .code(200)
          .headers({
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'content-type': 'text/event-stream; charset=utf-8',
            'x-content-type-options': 'nosniff',
          })
          .send(`${frames}: heartbeat\n\n`);
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
      '/v1/projects/:projectId/shots/:shotId/managed-attempts',
      {
        schema: {
          tags: ['generation'],
          summary: 'Queue generation from an exact validated workflow revision',
          body: {
            type: 'object',
            required: ['workflowRevisionId'],
            properties: {
              workflowRevisionId: { type: 'string', format: 'uuid' },
            },
            // Zod performs the strict rejection so Fastify does not silently
            // strip execution override fields before the application sees them.
            additionalProperties: true,
          },
          response: { 201: schemas.attemptResponse },
        },
      },
      async (request, reply) => {
        const projectId = parseProjectId(request);
        const shotId = resourceParam(request, 'shotId');
        const body = parseBody(
          managedAttemptBodySchema,
          request.body,
        ) as ManagedAttemptBody;
        const workflowRevisionId = bodyUuid(
          body.workflowRevisionId,
          'workflowRevisionId',
        );
        if (!workflowRevisionId) {
          throw new HttpProblemError(
            'INVALID_REQUEST',
            'workflowRevisionId is required.',
            422,
            false,
          );
        }
        const key = idempotencyKey(request);
        const traceId = headerValue(request, 'x-trace-id');
        const command: CreateManagedAttemptCommand = {
          idempotencyKey: key,
          workflowRevisionId,
          ...(traceId ? { traceId } : {}),
        };
        const response = await executeIdempotent(
          request,
          service,
          `managed-attempt.create:${projectId}:${shotId}`,
          body,
          async (repositories) => ({
            status: 201,
            body: {
              attempt: attemptResponse(
                await generationService.createManagedAttemptInTransaction(
                  repositories,
                  projectId,
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
        const traceId = headerValue(request, 'x-trace-id');
        const command: CreateAttemptCommand = {
          idempotencyKey: key,
          ...(body.seed !== undefined ? { seed: body.seed } : {}),
          ...(body.steps !== undefined ? { steps: body.steps } : {}),
          ...(body.scenario !== undefined ? { scenario: body.scenario } : {}),
          ...(traceId ? { traceId } : {}),
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
      '/v1/attempts/:attemptId/regenerate',
      {
        schema: {
          tags: ['generation'],
          summary: 'Queue a new attempt derived from a rejected attempt',
          params: {
            type: 'object',
            required: ['attemptId'],
            properties: { attemptId: { type: 'string', format: 'uuid' } },
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
        const attemptId = resourceParam(request, 'attemptId');
        const body = parseBody(
          createAttemptBodySchema,
          request.body,
        ) as CreateAttemptBody;
        const key = idempotencyKey(request);
        const command: CreateAttemptCommand = {
          idempotencyKey: key,
          ...(body.seed !== undefined ? { seed: body.seed } : {}),
          ...(body.steps !== undefined ? { steps: body.steps } : {}),
          ...(body.scenario !== undefined ? { scenario: body.scenario } : {}),
        };
        const response = await executeIdempotent(
          request,
          service,
          `attempt.regenerate:${attemptId}`,
          body,
          async (repositories) => ({
            status: 201,
            body: {
              attempt: attemptResponse(
                await generationService.regenerateAttemptInTransaction(
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
        const traceId = headerValue(request, 'x-trace-id');
        const command: RetryAttemptCommand = {
          idempotencyKey: key,
          ...(traceId ? { traceId } : {}),
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
    startGenerationWorker: true,
    startOperationalWorker: true,
  });

  app.addHook('onClose', async () => {
    await pool.end();
  });

  await app.listen({ host: config.apiHost, port: config.apiPort });
  return app;
}
