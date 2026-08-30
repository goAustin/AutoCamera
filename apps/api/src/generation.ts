import { createHash } from 'node:crypto';
import {
  ATTEMPT_FAILURE_CODES,
  addMicrousd,
  createDomainEvent,
  createGenerationAttempt,
  isTerminalGenerationAttempt,
  toIsoUtc,
  transitionGenerationAttempt,
  transitionProject,
  transitionShot,
  type ArtifactRecord,
  type AttemptFailureCode,
  type Clock,
  type DomainEvent,
  type EvaluationResult,
  type GenerationAttempt,
  type IdGenerator,
  type IsoUtcTimestamp,
  type MicroUsd,
  type Shot,
  type Uuid,
  type VideoProject,
  systemIdGenerator,
} from '@h3/domain';
import type {
  AttemptRepository,
  Repositories,
  TransactionalStore,
} from '@h3/db';
import {
  ComfyStreamDisconnectedError,
  ComfySubmissionUncertainError,
  FakeComfyClient,
  type ComfyClient,
  type ComfyMessage,
  type ComfyOutputReference,
  type ComfyScenario,
} from '@h3/comfy-client';
import { MediaEvaluator } from '@h3/evaluator';
import { compileAndPersistWorkflow } from '@h3/workflow-compiler';
import { createLocalArtifactStore, type ArtifactStore } from '@h3/object-store';

export const PREVIEW_WIDTH = 960 as const;
export const PREVIEW_HEIGHT = 544 as const;
export const PREVIEW_DURATION_SECONDS = 5 as const;
export const PREVIEW_STEPS = 8 as const;
export const MAX_ATTEMPTS_PER_SHOT = 3 as const;
export const DEFAULT_ESTIMATED_ATTEMPT_COST = 100_000 as MicroUsd;

const RECOVERABLE_FAILURE_CODES: ReadonlySet<AttemptFailureCode> = new Set([
  'COMFY_UNAVAILABLE',
  'COMFY_SUBMISSION_UNCERTAIN',
  'COMFY_EXECUTION_FAILED',
  'GENERATION_TIMEOUT',
  'ARTIFACT_DOWNLOAD_FAILED',
  'ARTIFACT_STORAGE_FAILED',
]);

export type GenerationApplicationErrorCode =
  | 'SHOT_NOT_FOUND'
  | 'ATTEMPT_NOT_FOUND'
  | 'SHOT_NOT_READY_FOR_GENERATION'
  | 'ATTEMPT_LIMIT_REACHED'
  | 'BUDGET_EXCEEDED'
  | 'ATTEMPT_NOT_REVIEWABLE'
  | 'EVALUATION_REQUIRED'
  | 'EVALUATION_FAILED'
  | 'ATTEMPT_NOT_REJECTED'
  | 'INVALID_REVIEW_REASON'
  | 'PERSISTENCE_UNAVAILABLE'
  | 'GENERATION_FAILED';

export class GenerationApplicationError extends Error {
  readonly code: GenerationApplicationErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: GenerationApplicationErrorCode,
    message: string,
    status = 409,
    retryable = false,
  ) {
    super(message);
    this.name = 'GenerationApplicationError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface CreateAttemptCommand {
  readonly idempotencyKey: string;
  readonly seed?: number;
  readonly steps?: number;
  readonly scenario?: ComfyScenario;
  readonly traceId?: string;
}

export interface AttemptReviewResult {
  readonly attempt: GenerationAttempt;
  readonly shot: Shot;
  readonly project: VideoProject;
}

export interface GenerationApplicationServiceOptions {
  readonly store: TransactionalStore;
  readonly comfyClient?: ComfyClient;
  readonly artifactStore?: ArtifactStore;
  readonly evaluator?: MediaEvaluator;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly tenantId: Uuid;
  readonly producer?: string;
  readonly maxAttemptsPerShot?: number;
  readonly estimatedAttemptCostMicrousd?: MicroUsd;
  readonly previewDurationSeconds?: number;
}

function updatedAt<Value extends { readonly updatedAt: IsoUtcTimestamp }>(
  value: Value,
  clock: Clock,
): Value {
  return { ...value, updatedAt: toIsoUtc(clock.now()) };
}

function clearLease(attempt: GenerationAttempt): GenerationAttempt {
  const {
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    ...withoutLease
  } = attempt;
  return withoutLease;
}

function setFailure(
  attempt: GenerationAttempt,
  code: AttemptFailureCode,
  message: string,
): GenerationAttempt {
  return {
    ...attempt,
    failureCode: code,
    failureMessage: redactFailureMessage(message),
  };
}

function evaluationFailureCode(result: EvaluationResult): AttemptFailureCode {
  const checks = result.checks;
  const failures: ReadonlyArray<[string, AttemptFailureCode]> = [
    ['file_readable', 'MEDIA_NOT_FOUND'],
    ['checksum', 'MEDIA_CHECKSUM_MISMATCH'],
    ['byte_size', 'MEDIA_SIZE_MISMATCH'],
    ['container', 'MEDIA_INVALID_CONTAINER'],
    ['video_stream', 'MEDIA_MISSING_VIDEO'],
    ['dimensions', 'MEDIA_INVALID_DIMENSIONS'],
    ['duration', 'MEDIA_INVALID_DURATION'],
    ['frame_rate', 'MEDIA_INVALID_FRAME_RATE'],
    ['decoder', 'MEDIA_DECODE_FAILED'],
    ['motion', 'MEDIA_BLACK_OR_STATIC'],
  ];
  return (
    failures.find(([name]) => checks[name]?.status === 'failed')?.[1] ??
    'MEDIA_DECODE_FAILED'
  );
}

export function redactFailureMessage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/(?:\/|[A-Za-z]:\\)[^\s'"`]+/g, '[path redacted]')
    .replace(/prompt[^,;:.]*/gi, 'prompt [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function hashSeed(attemptId: Uuid): number {
  const value = createHash('sha256').update(attemptId).digest().readUInt32BE(0);
  return value & 0x7fffffff;
}

function validScenario(value: string | undefined): ComfyScenario {
  if (
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

function outputFromMessage(
  message: ComfyMessage,
): ComfyOutputReference | undefined {
  if (message.type !== 'executed') return undefined;
  const output = message.data.output;
  if (typeof output !== 'object' || output === null) return undefined;
  const record = output as Record<string, unknown>;
  const values = Object.values(record).flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
  const candidate = values.find(
    (value): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && 'filename' in value,
  );
  if (!candidate || typeof candidate.filename !== 'string') return undefined;
  return {
    filename: candidate.filename,
    subfolder:
      typeof candidate.subfolder === 'string' ? candidate.subfolder : '',
    type: typeof candidate.type === 'string' ? candidate.type : 'output',
    mimeType:
      typeof candidate.mimeType === 'string' ? candidate.mimeType : 'video/mp4',
  };
}

export type CanonicalComfyEvent =
  | { readonly kind: 'execution_started'; readonly promptId: string }
  | {
      readonly kind: 'executing';
      readonly promptId: string;
      readonly nodeId?: string;
    }
  | {
      readonly kind: 'progress';
      readonly promptId: string;
      readonly value: number;
      readonly max: number;
    }
  | {
      readonly kind: 'executed';
      readonly promptId: string;
      readonly output?: ComfyOutputReference;
    }
  | { readonly kind: 'succeeded'; readonly promptId: string }
  | {
      readonly kind: 'failed';
      readonly promptId: string;
      readonly code: AttemptFailureCode;
      readonly message: string;
    }
  | { readonly kind: 'interrupted'; readonly promptId: string };

export function normalizeComfyMessage(
  message: ComfyMessage,
): CanonicalComfyEvent | null {
  const promptId =
    typeof message.data.prompt_id === 'string' ? message.data.prompt_id : '';
  if (!promptId) return null;
  switch (message.type) {
    case 'execution_start':
      return { kind: 'execution_started', promptId };
    case 'executing':
      return {
        kind: 'executing',
        promptId,
        ...(typeof message.data.node === 'string'
          ? { nodeId: message.data.node }
          : {}),
      };
    case 'progress':
      return {
        kind: 'progress',
        promptId,
        value: Number(message.data.value ?? 0),
        max: Number(message.data.max ?? 100),
      };
    case 'executed': {
      const output = outputFromMessage(message);
      return { kind: 'executed', promptId, ...(output ? { output } : {}) };
    }
    case 'execution_success':
      return { kind: 'succeeded', promptId };
    case 'execution_error':
      return {
        kind: 'failed',
        promptId,
        code: 'COMFY_EXECUTION_FAILED',
        message: String(
          message.data.exception_message ?? 'ComfyUI execution failed.',
        ),
      };
    case 'execution_interrupted':
      return { kind: 'interrupted', promptId };
    default:
      return null;
  }
}

export class ComfyObserver {
  private readonly terminalPromptIds = new Set<string>();
  private readonly seenEvents = new Set<string>();

  observe(message: ComfyMessage): CanonicalComfyEvent | null {
    const normalized = normalizeComfyMessage(message);
    if (!normalized || this.terminalPromptIds.has(normalized.promptId))
      return null;
    const eventKey = `${normalized.promptId}:${message.type}:${JSON.stringify(message.data)}`;
    if (this.seenEvents.has(eventKey)) return null;
    this.seenEvents.add(eventKey);
    if (
      normalized.kind === 'succeeded' ||
      normalized.kind === 'failed' ||
      normalized.kind === 'interrupted'
    ) {
      this.terminalPromptIds.add(normalized.promptId);
    }
    return normalized;
  }

  markTerminal(promptId: string): void {
    this.terminalPromptIds.add(promptId);
  }

  isTerminal(promptId: string): boolean {
    return this.terminalPromptIds.has(promptId);
  }
}

export class GenerationApplicationService {
  readonly store: TransactionalStore;
  readonly comfyClient: ComfyClient;
  readonly artifactStore: ArtifactStore;
  readonly evaluator: MediaEvaluator;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly tenantId: Uuid;
  readonly producer: string;
  readonly maxAttemptsPerShot: number;
  readonly estimatedAttemptCostMicrousd: MicroUsd;
  readonly previewDurationSeconds: number;

  constructor(options: GenerationApplicationServiceOptions) {
    this.store = options.store;
    this.comfyClient = options.comfyClient ?? new FakeComfyClient();
    this.artifactStore = options.artifactStore ?? createLocalArtifactStore();
    this.evaluator = options.evaluator ?? new MediaEvaluator();
    this.clock = options.clock ?? { now: () => new Date() };
    this.idGenerator = options.idGenerator ?? systemIdGenerator;
    this.tenantId = options.tenantId;
    this.producer = options.producer ?? 'h3-generation';
    this.maxAttemptsPerShot =
      options.maxAttemptsPerShot ?? MAX_ATTEMPTS_PER_SHOT;
    this.estimatedAttemptCostMicrousd =
      options.estimatedAttemptCostMicrousd ?? DEFAULT_ESTIMATED_ATTEMPT_COST;
    this.previewDurationSeconds =
      options.previewDurationSeconds ?? PREVIEW_DURATION_SECONDS;
  }

  async createAttempt(
    shotId: Uuid,
    command: CreateAttemptCommand,
  ): Promise<GenerationAttempt> {
    return this.store.withTransaction((repositories) =>
      this.createAttemptInTransaction(repositories, shotId, command),
    );
  }

  async createAttemptInTransaction(
    repositories: Repositories,
    shotId: Uuid,
    command: CreateAttemptCommand,
    sourceAttemptId?: Uuid,
  ): Promise<GenerationAttempt> {
    const shot = await repositories.shots.findByIdAny(shotId);
    if (!shot) {
      throw new GenerationApplicationError(
        'SHOT_NOT_FOUND',
        'The requested shot was not found.',
        404,
      );
    }
    const project = await repositories.projects.findById(
      this.tenantId,
      shot.projectId,
    );
    if (!project) {
      throw new GenerationApplicationError(
        'SHOT_NOT_FOUND',
        'The requested shot was not found.',
        404,
      );
    }
    if (
      shot.status !== 'approved_for_generation' &&
      shot.status !== 'rejected' &&
      shot.status !== 'retryable'
    ) {
      throw new GenerationApplicationError(
        'SHOT_NOT_READY_FOR_GENERATION',
        'The shot is not approved or eligible for regeneration.',
      );
    }
    const attempts = await repositories.attempts.listByShot(
      this.tenantId,
      shotId,
    );
    if (attempts.length >= this.maxAttemptsPerShot) {
      await this.appendEvent(repositories, {
        type: 'project.budget_denied',
        projectId: project.id,
        shotId,
        payload: { reason: 'attempt_limit', shotId },
      });
      throw new GenerationApplicationError(
        'ATTEMPT_LIMIT_REACHED',
        'The shot has reached its maximum preview-attempt count.',
      );
    }
    const nextSpend = addMicrousd(
      project.spentMicrousd,
      this.estimatedAttemptCostMicrousd,
    );
    if (nextSpend > project.budgetMicrousd) {
      await this.appendEvent(repositories, {
        type: 'project.budget_denied',
        projectId: project.id,
        shotId,
        payload: {
          reason: 'budget',
          estimatedCostMicrousd: this.estimatedAttemptCostMicrousd,
        },
      });
      throw new GenerationApplicationError(
        'BUDGET_EXCEEDED',
        'The project budget cannot cover another preview attempt.',
      );
    }
    const now = toIsoUtc(this.clock.now());
    const attemptId = this.idGenerator.next();
    const seed = command.seed ?? hashSeed(attemptId);
    const steps = command.steps ?? PREVIEW_STEPS;
    const compiled = await compileAndPersistWorkflow(
      {
        prompt: shot.prompt,
        seed,
        steps,
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
        durationSeconds: this.previewDurationSeconds,
      },
      repositories.workflowVersions,
      {
        id: this.idGenerator.next(),
        createdAt: now,
      },
    );
    const correlationId = `h3-${attemptId}`;
    const attempt = createGenerationAttempt({
      id: attemptId,
      tenantId: this.tenantId,
      projectId: project.id,
      shotId,
      idempotencyKey: command.idempotencyKey,
      seed,
      steps,
      requestedWidth: PREVIEW_WIDTH,
      requestedHeight: PREVIEW_HEIGHT,
      requestedDurationSeconds: compiled.durationSeconds,
      workflowVersionId: compiled.workflowVersionId as Uuid,
      workflowHash: compiled.workflowHash,
      correlationId,
      ...(command.traceId ? { traceId: command.traceId } : {}),
      ...(command.scenario ? { scenario: command.scenario } : {}),
      estimatedCostMicrousd: this.estimatedAttemptCostMicrousd,
      ...(sourceAttemptId ? { sourceAttemptId } : {}),
      now,
    });
    await repositories.attempts.create(attempt);
    const queuedShot = updatedAt(transitionShot(shot, 'queued'), this.clock);
    await repositories.shots.update(queuedShot, shot.version);
    let updatedProject = project;
    if (
      project.status === 'ready_for_generation' ||
      project.status === 'awaiting_final_review' ||
      project.status === 'needs_attention'
    ) {
      updatedProject = transitionProject(project, 'generating');
    } else if (project.status !== 'generating') {
      throw new GenerationApplicationError(
        'SHOT_NOT_READY_FOR_GENERATION',
        'The project is not ready to generate this shot.',
      );
    }
    updatedProject = {
      ...updatedProject,
      spentMicrousd: nextSpend,
      updatedAt: now,
    };
    await repositories.projects.update(updatedProject, project.version);
    await this.appendEvent(repositories, {
      type: 'attempt.queued',
      projectId: project.id,
      shotId,
      attemptId: attempt.id,
      payload: {
        status: attempt.status,
        workflowHash: attempt.workflowHash,
        estimatedCostMicrousd: attempt.estimatedCostMicrousd,
      },
    });
    return attempt;
  }

  async listAttempts(shotId: Uuid): Promise<readonly GenerationAttempt[]> {
    return this.store.withTransaction((repositories) =>
      repositories.attempts.listByShot(this.tenantId, shotId),
    );
  }

  async getAttempt(attemptId: Uuid): Promise<GenerationAttempt> {
    return this.store.withTransaction(async (repositories) => {
      const attempt = await repositories.attempts.findById(
        this.tenantId,
        attemptId,
      );
      if (!attempt) {
        throw new GenerationApplicationError(
          'ATTEMPT_NOT_FOUND',
          'The requested generation attempt was not found.',
          404,
        );
      }
      return attempt;
    });
  }

  async acceptAttempt(attemptId: Uuid): Promise<AttemptReviewResult> {
    return this.store.withTransaction((repositories) =>
      this.acceptAttemptInTransaction(repositories, attemptId),
    );
  }

  async acceptAttemptInTransaction(
    repositories: Repositories,
    attemptId: Uuid,
  ): Promise<AttemptReviewResult> {
    const attempt = await this.requireAttempt(repositories, attemptId);
    if (attempt.status !== 'awaiting_review') {
      throw new GenerationApplicationError(
        'ATTEMPT_NOT_REVIEWABLE',
        'Only an attempt awaiting review can be accepted.',
      );
    }
    const evaluation = await repositories.evaluations.findByAttempt(
      this.tenantId,
      attemptId,
    );
    if (!evaluation) {
      throw new GenerationApplicationError(
        'EVALUATION_REQUIRED',
        'A technical evaluation is required before acceptance.',
      );
    }
    if (evaluation.status !== 'passed') {
      throw new GenerationApplicationError(
        'EVALUATION_FAILED',
        'Only an attempt with a passing technical evaluation can be accepted.',
      );
    }
    const shot = await repositories.shots.findById(
      attempt.projectId,
      attempt.shotId,
    );
    const project = await repositories.projects.findById(
      this.tenantId,
      attempt.projectId,
    );
    if (!shot || !project) {
      throw new GenerationApplicationError(
        'ATTEMPT_NOT_FOUND',
        'The attempt parent record was not found.',
        404,
      );
    }
    if (shot.acceptedAttemptId) {
      throw new GenerationApplicationError(
        'ATTEMPT_NOT_REVIEWABLE',
        'This shot already has an accepted attempt.',
      );
    }
    const acceptedAttempt = clearLease(
      updatedAt(transitionGenerationAttempt(attempt, 'accepted'), this.clock),
    );
    const acceptedShot = updatedAt(
      transitionShot({ ...shot, acceptedAttemptId: attempt.id }, 'accepted'),
      this.clock,
    );
    const shots = await repositories.shots.listByProject(project.id);
    const allAccepted = shots.every((candidate) =>
      candidate.id === shot.id
        ? true
        : candidate.acceptedAttemptId !== undefined,
    );
    const updatedProject = allAccepted
      ? updatedAt(transitionProject(project, 'completed'), this.clock)
      : project.status === 'generating'
        ? updatedAt(
            transitionProject(project, 'awaiting_final_review'),
            this.clock,
          )
        : project;
    await repositories.attempts.update(acceptedAttempt, attempt.version);
    await repositories.shots.update(acceptedShot, shot.version);
    if (updatedProject !== project) {
      await repositories.projects.update(updatedProject, project.version);
    }
    await this.appendEvent(repositories, {
      type: 'attempt.accepted',
      projectId: project.id,
      shotId: shot.id,
      attemptId: attempt.id,
      payload: { evaluationId: evaluation.id },
    });
    if (allAccepted) {
      await this.appendEvent(repositories, {
        type: 'project.completed',
        projectId: project.id,
        payload: { acceptedShotCount: shots.length },
      });
    }
    return {
      attempt: acceptedAttempt,
      shot: acceptedShot,
      project: updatedProject,
    };
  }

  async rejectAttempt(
    attemptId: Uuid,
    reasonCode: string,
  ): Promise<AttemptReviewResult> {
    return this.store.withTransaction((repositories) =>
      this.rejectAttemptInTransaction(repositories, attemptId, reasonCode),
    );
  }

  async rejectAttemptInTransaction(
    repositories: Repositories,
    attemptId: Uuid,
    reasonCode: string,
  ): Promise<AttemptReviewResult> {
    const reason = reasonCode.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_.-]{0,63}$/.test(reason)) {
      throw new GenerationApplicationError(
        'INVALID_REVIEW_REASON',
        'The review reason code is invalid.',
        422,
      );
    }
    const attempt = await this.requireAttempt(repositories, attemptId);
    if (attempt.status !== 'awaiting_review') {
      throw new GenerationApplicationError(
        'ATTEMPT_NOT_REVIEWABLE',
        'Only an attempt awaiting review can be rejected.',
      );
    }
    const shot = await repositories.shots.findById(
      attempt.projectId,
      attempt.shotId,
    );
    const project = await repositories.projects.findById(
      this.tenantId,
      attempt.projectId,
    );
    if (!shot || !project) {
      throw new GenerationApplicationError(
        'ATTEMPT_NOT_FOUND',
        'The attempt parent record was not found.',
        404,
      );
    }
    const rejectedAttempt = setFailure(
      clearLease(
        updatedAt(transitionGenerationAttempt(attempt, 'rejected'), this.clock),
      ),
      'REVIEW_REJECTED',
      reason,
    );
    const rejectedShot = updatedAt(
      transitionShot(shot, 'rejected'),
      this.clock,
    );
    await repositories.attempts.update(rejectedAttempt, attempt.version);
    await repositories.shots.update(rejectedShot, shot.version);
    await this.appendEvent(repositories, {
      type: 'attempt.rejected',
      projectId: project.id,
      shotId: shot.id,
      attemptId: attempt.id,
      payload: { reasonCode: reason },
    });
    return { attempt: rejectedAttempt, shot: rejectedShot, project };
  }

  async regenerateAttempt(
    attemptId: Uuid,
    command: CreateAttemptCommand,
  ): Promise<GenerationAttempt> {
    return this.store.withTransaction(async (repositories) => {
      return this.regenerateAttemptInTransaction(
        repositories,
        attemptId,
        command,
      );
    });
  }

  async regenerateAttemptInTransaction(
    repositories: Repositories,
    attemptId: Uuid,
    command: CreateAttemptCommand,
  ): Promise<GenerationAttempt> {
    const source = await this.requireAttempt(repositories, attemptId);
    if (
      source.status !== 'rejected' &&
      source.status !== 'failed' &&
      source.status !== 'timed_out'
    ) {
      throw new GenerationApplicationError(
        'ATTEMPT_NOT_REJECTED',
        'Retry requires a failed, timed-out, or rejected source attempt.',
      );
    }
    return this.createAttemptInTransaction(
      repositories,
      source.shotId,
      command,
      source.id,
    );
  }

  async listProjectAttempts(
    projectId: Uuid,
  ): Promise<readonly GenerationAttempt[]> {
    return this.store.withTransaction((repositories) =>
      repositories.attempts.listByProject(this.tenantId, projectId),
    );
  }

  async recordOrphanComfyMessage(message: ComfyMessage): Promise<boolean> {
    const promptId =
      typeof message.data.prompt_id === 'string' ? message.data.prompt_id : '';
    if (!promptId) return false;
    return this.store.withTransaction(async (repositories) => {
      const knownAttempt = await repositories.attempts.findByPromptId(
        this.tenantId,
        promptId,
      );
      if (knownAttempt) return false;
      const duplicate = (
        await repositories.events.listOrphans(this.tenantId)
      ).some(
        (event) =>
          event.promptId === promptId &&
          event.payload.comfyMessageType === message.type,
      );
      if (duplicate) return false;
      await this.appendEvent(repositories, {
        type: 'orphan.event',
        promptId,
        payload: {
          comfyMessageType: message.type,
          promptId,
        },
      });
      return true;
    });
  }

  private async requireAttempt(
    repositories: Repositories,
    attemptId: Uuid,
  ): Promise<GenerationAttempt> {
    const attempt = await repositories.attempts.findById(
      this.tenantId,
      attemptId,
    );
    if (!attempt) {
      throw new GenerationApplicationError(
        'ATTEMPT_NOT_FOUND',
        'The requested generation attempt was not found.',
        404,
      );
    }
    return attempt;
  }

  async appendEvent(
    repositories: Repositories,
    input: {
      readonly type: DomainEvent['type'];
      readonly projectId?: Uuid;
      readonly shotId?: Uuid;
      readonly attemptId?: Uuid;
      readonly promptId?: string;
      readonly payload: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    const event = createDomainEvent({
      id: this.idGenerator.next(),
      type: input.type,
      producer: this.producer,
      tenantId: this.tenantId,
      clock: this.clock,
      payload: input.payload,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.shotId ? { shotId: input.shotId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ...(input.promptId ? { promptId: input.promptId } : {}),
    });
    await repositories.events.append(event);
    await repositories.outbox.enqueue(event);
  }
}

export interface GenerationWorkerOptions {
  readonly service: GenerationApplicationService;
  readonly workerId: string;
  readonly leaseSeconds?: number;
  readonly timeoutSeconds?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maxReconnects?: number;
}

export class GenerationWorker {
  readonly service: GenerationApplicationService;
  readonly workerId: string;
  readonly leaseSeconds: number;
  readonly timeoutSeconds: number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly maxReconnects: number;
  private stopping = false;
  private currentWork: Promise<void> | undefined;
  private currentAttemptId: Uuid | undefined;
  private activeAbortController: AbortController | undefined;

  constructor(options: GenerationWorkerOptions) {
    this.service = options.service;
    this.workerId = options.workerId;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.timeoutSeconds = options.timeoutSeconds ?? 300;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxReconnects = options.maxReconnects ?? 3;
  }

  async processOnce(): Promise<boolean> {
    const now = toIsoUtc(this.service.clock.now());
    await this.service.store.withTransaction((repositories) =>
      repositories.attempts.recoverStale(now),
    );
    const leaseExpiresAt = toIsoUtc(
      new Date(this.service.clock.now().getTime() + this.leaseSeconds * 1000),
    );
    const attempt = await this.service.store.withTransaction((repositories) =>
      repositories.attempts.claimNext(this.workerId, now, leaseExpiresAt),
    );
    if (!attempt) return false;
    this.currentAttemptId = attempt.id;
    this.currentWork = this.processAttempt(attempt).finally(() => {
      this.currentWork = undefined;
      this.currentAttemptId = undefined;
    });
    await this.currentWork;
    return true;
  }

  async run(intervalMilliseconds = 50): Promise<void> {
    this.stopping = false;
    while (!this.stopping) {
      await this.processOnce();
      if (!this.stopping) await this.sleep(intervalMilliseconds);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const attemptId = this.currentAttemptId;
    this.activeAbortController?.abort(new Error('generation worker stopping'));
    try {
      await this.currentWork;
    } finally {
      if (attemptId) {
        await this.service.store.withTransaction((repositories) =>
          repositories.attempts.release(
            attemptId,
            this.workerId,
            toIsoUtc(this.service.clock.now()),
          ),
        );
      }
    }
  }

  private async processAttempt(claimed: GenerationAttempt): Promise<void> {
    const heartbeat = setInterval(
      () => {
        void this.service.store.withTransaction(async (repositories) => {
          const expires = toIsoUtc(
            new Date(
              this.service.clock.now().getTime() + this.leaseSeconds * 1000,
            ),
          );
          await repositories.attempts.heartbeat(
            claimed.id,
            this.workerId,
            expires,
          );
        });
      },
      Math.max(100, Math.floor((this.leaseSeconds * 1000) / 2)),
    );
    try {
      const loadedAttempt = await this.currentAttempt(claimed.id);
      if (!loadedAttempt) return;
      if (isTerminalGenerationAttempt(loadedAttempt.status)) return;
      let attempt = loadedAttempt;
      const project = await this.currentProject(attempt.projectId);
      if (!project || project.spentMicrousd > project.budgetMicrousd) {
        await this.failAttempt(
          claimed.id,
          'failed',
          'BUDGET_EXCEEDED',
          'Budget changed before submission.',
        );
        return;
      }
      const workflowHash = attempt.workflowHash;
      const workflow = await this.service.store.withTransaction(
        (repositories) =>
          repositories.workflowVersions.findByHash(workflowHash),
      );
      if (!workflow) {
        await this.failAttempt(
          claimed.id,
          'failed',
          'COMFY_UNAVAILABLE',
          'Compiled workflow version is missing.',
        );
        return;
      }
      const submissionIntent = await this.service.store.withTransaction(
        async (repositories) => {
          const current = await repositories.attempts.findById(
            this.service.tenantId,
            claimed.id,
          );
          if (!current || isTerminalGenerationAttempt(current.status))
            return current;
          const next = clearLease(
            updatedAt(
              transitionGenerationAttempt(current, 'submitting'),
              this.service.clock,
            ),
          );
          const leased: GenerationAttempt = {
            ...next,
            leaseOwner: this.workerId,
            leaseExpiresAt: toIsoUtc(
              new Date(
                this.service.clock.now().getTime() + this.leaseSeconds * 1000,
              ),
            ),
          };
          await repositories.attempts.update(leased, current.version);
          await this.service.appendEvent(repositories, {
            type: 'attempt.submitted',
            projectId: current.projectId,
            shotId: current.shotId,
            attemptId: current.id,
            payload: {
              status: 'submitting',
              correlationId: current.correlationId,
            },
          });
          return leased;
        },
      );
      if (!submissionIntent) return;
      attempt = submissionIntent;
      let history = attempt.comfyPromptId
        ? await this.service.comfyClient.getHistory(attempt.comfyPromptId)
        : await this.service.comfyClient.findHistoryByCorrelation(
            attempt.correlationId,
          );
      if (!history) {
        try {
          const response = await this.service.comfyClient.submitPrompt({
            workflow: workflow.workflowJson,
            extraData: {
              attempt_id: attempt.id,
              workflow_hash: attempt.workflowHash,
              trace_id: attempt.traceId ?? '',
              correlation_id: attempt.correlationId,
              seed: attempt.seed,
              scenario: validScenario(attempt.scenario),
            },
            scenario: validScenario(attempt.scenario),
            seed: attempt.seed,
          });
          history = await this.service.comfyClient.getHistory(
            response.promptId,
          );
          attempt = await this.persistSubmitted(attempt, response.promptId);
        } catch (error) {
          if (!(error instanceof ComfySubmissionUncertainError)) {
            await this.failAttempt(
              attempt.id,
              'failed',
              'COMFY_UNAVAILABLE',
              error instanceof Error
                ? error.message
                : 'ComfyUI submission failed.',
            );
            return;
          }
          history = await this.service.comfyClient.findHistoryByCorrelation(
            attempt.correlationId,
          );
          if (!history) {
            await this.failAttempt(
              attempt.id,
              'failed',
              'COMFY_SUBMISSION_UNCERTAIN',
              'ComfyUI submission remained uncertain after history reconciliation.',
            );
            return;
          }
          attempt = await this.persistSubmitted(attempt, history.promptId);
        }
      } else if (!attempt.comfyPromptId) {
        attempt = await this.persistSubmitted(attempt, history.promptId);
      }
      if (this.stopping) return;
      await this.reconcileOrObserve(attempt, history);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async reconcileOrObserve(
    attempt: GenerationAttempt,
    initialHistory: Awaited<ReturnType<ComfyClient['getHistory']>>,
  ): Promise<void> {
    if (initialHistory?.status === 'success') {
      await this.markRunning(attempt.id);
      await this.finishSuccess(attempt.id, initialHistory.outputs[0]);
      return;
    }
    if (initialHistory?.status === 'error') {
      await this.failAttempt(
        attempt.id,
        'failed',
        'COMFY_EXECUTION_FAILED',
        initialHistory.errorMessage ?? 'ComfyUI execution failed.',
      );
      return;
    }
    if (initialHistory?.status === 'interrupted') {
      await this.failAttempt(
        attempt.id,
        'cancelled',
        'COMFY_INTERRUPTED',
        'ComfyUI execution was interrupted.',
      );
      return;
    }
    const controller = new AbortController();
    this.activeAbortController = controller;
    const timeout = setTimeout(
      () => controller.abort(new Error('generation timeout')),
      this.timeoutSeconds * 1000,
    );
    const observer = new ComfyObserver();
    let output: ComfyOutputReference | undefined;
    try {
      for await (const message of this.service.comfyClient.events({
        ...(attempt.comfyPromptId ? { promptId: attempt.comfyPromptId } : {}),
        signal: controller.signal,
      })) {
        const event = observer.observe(message);
        if (!event) continue;
        if (event.kind === 'execution_started' || event.kind === 'executing') {
          await this.markRunning(attempt.id);
        } else if (event.kind === 'progress') {
          await this.markProgress(attempt.id, event);
        } else if (event.kind === 'executed' && event.output) {
          output = event.output;
        } else if (event.kind === 'succeeded') {
          await this.finishSuccess(attempt.id, output);
          return;
        } else if (event.kind === 'failed') {
          await this.failAttempt(
            attempt.id,
            'failed',
            event.code,
            event.message,
          );
          return;
        } else if (event.kind === 'interrupted') {
          await this.failAttempt(
            attempt.id,
            'cancelled',
            'COMFY_INTERRUPTED',
            'ComfyUI execution was interrupted.',
          );
          return;
        }
      }
    } catch (error) {
      if (!(error instanceof ComfyStreamDisconnectedError)) {
        if (controller.signal.aborted && this.stopping) return;
        if (controller.signal.aborted) {
          await this.failAttempt(
            attempt.id,
            'timed_out',
            'GENERATION_TIMEOUT',
            'Generation exceeded its configured runtime.',
          );
          return;
        }
        throw error;
      }
    } finally {
      clearTimeout(timeout);
      if (this.activeAbortController === controller) {
        this.activeAbortController = undefined;
      }
    }
    for (let retry = 0; retry <= this.maxReconnects; retry += 1) {
      const history = await this.service.comfyClient.getHistory(
        attempt.comfyPromptId ?? '',
      );
      if (history?.status === 'success') {
        await this.finishSuccess(attempt.id, output ?? history.outputs[0]);
        return;
      }
      if (history?.status === 'error') {
        await this.failAttempt(
          attempt.id,
          'failed',
          'COMFY_EXECUTION_FAILED',
          history.errorMessage ?? 'ComfyUI execution failed.',
        );
        return;
      }
      if (history?.status === 'interrupted') {
        await this.failAttempt(
          attempt.id,
          'cancelled',
          'COMFY_INTERRUPTED',
          'ComfyUI execution was interrupted.',
        );
        return;
      }
      if (retry < this.maxReconnects) await this.sleep(10 * 2 ** retry);
    }
    await this.failAttempt(
      attempt.id,
      'timed_out',
      'GENERATION_TIMEOUT',
      'Generation did not reach a terminal state.',
    );
  }

  private async persistSubmitted(
    attempt: GenerationAttempt,
    promptId: string,
  ): Promise<GenerationAttempt> {
    return this.service.store.withTransaction(async (repositories) => {
      const current = await repositories.attempts.findById(
        this.service.tenantId,
        attempt.id,
      );
      if (!current)
        throw new GenerationApplicationError(
          'ATTEMPT_NOT_FOUND',
          'Attempt disappeared.',
          404,
        );
      if (current.comfyPromptId === promptId && current.status !== 'submitting')
        return current;
      const submitted = updatedAt(
        transitionGenerationAttempt(current, 'submitted'),
        this.service.clock,
      );
      const withPrompt: GenerationAttempt = {
        ...submitted,
        comfyPromptId: promptId,
        submittedAt: toIsoUtc(this.service.clock.now()),
      };
      await repositories.attempts.update(withPrompt, current.version);
      await this.service.appendEvent(repositories, {
        type: 'attempt.submitted',
        projectId: current.projectId,
        shotId: current.shotId,
        attemptId: current.id,
        promptId,
        payload: { status: 'submitted' },
      });
      return withPrompt;
    });
  }

  private async markRunning(attemptId: Uuid): Promise<void> {
    await this.service.store.withTransaction(async (repositories) => {
      const attempt = await repositories.attempts.findById(
        this.service.tenantId,
        attemptId,
      );
      if (!attempt || isTerminalGenerationAttempt(attempt.status)) return;
      if (
        attempt.status !== 'queued' &&
        attempt.status !== 'submitted' &&
        attempt.status !== 'submitting'
      )
        return;
      const running = updatedAt(
        transitionGenerationAttempt(attempt, 'running'),
        this.service.clock,
      );
      await repositories.attempts.update(running, attempt.version);
      const shot = await repositories.shots.findById(
        attempt.projectId,
        attempt.shotId,
      );
      if (shot && shot.status === 'queued') {
        await repositories.shots.update(
          updatedAt(transitionShot(shot, 'generating'), this.service.clock),
          shot.version,
        );
      }
      await this.service.appendEvent(repositories, {
        type: 'attempt.execution_started',
        projectId: attempt.projectId,
        shotId: attempt.shotId,
        attemptId,
        ...(attempt.comfyPromptId ? { promptId: attempt.comfyPromptId } : {}),
        payload: { status: 'running' },
      });
    });
  }

  private async markProgress(
    attemptId: Uuid,
    event: Extract<CanonicalComfyEvent, { readonly kind: 'progress' }>,
  ): Promise<void> {
    await this.service.store.withTransaction(async (repositories) => {
      const attempt = await repositories.attempts.findById(
        this.service.tenantId,
        attemptId,
      );
      if (!attempt || isTerminalGenerationAttempt(attempt.status)) return;
      await this.service.appendEvent(repositories, {
        type: 'attempt.execution_progress',
        projectId: attempt.projectId,
        shotId: attempt.shotId,
        attemptId,
        promptId: event.promptId,
        payload: { value: event.value, max: event.max },
      });
    });
  }

  private async finishSuccess(
    attemptId: Uuid,
    output?: ComfyOutputReference,
  ): Promise<void> {
    const attempt = await this.currentAttempt(attemptId);
    if (
      !attempt ||
      isTerminalGenerationAttempt(attempt.status) ||
      attempt.status === 'awaiting_review'
    )
      return;
    const existingArtifact = await this.service.store.withTransaction(
      (repositories) =>
        repositories.artifacts.findByAttempt(this.service.tenantId, attemptId),
    );
    const existingEvaluation = await this.service.store.withTransaction(
      (repositories) =>
        repositories.evaluations.findByAttempt(
          this.service.tenantId,
          attemptId,
        ),
    );
    let artifact: ArtifactRecord;
    let bytes: Uint8Array;
    let artifactCreated = false;
    try {
      if (existingArtifact) {
        artifact = existingArtifact;
        bytes = await this.service.artifactStore.read(existingArtifact.id);
      } else {
        if (!output) {
          await this.failAttempt(
            attemptId,
            'failed',
            'ARTIFACT_DOWNLOAD_FAILED',
            'ComfyUI returned no output reference.',
          );
          return;
        }
        bytes = await this.service.comfyClient.downloadOutput(output);
        const object = await this.service.artifactStore.put({
          artifactId: this.service.idGenerator.next(),
          body: bytes,
          mimeType: output.mimeType,
        });
        artifact = {
          id: object.artifactId as Uuid,
          tenantId: attempt.tenantId,
          projectId: attempt.projectId,
          shotId: attempt.shotId,
          attemptId: attempt.id,
          objectKey: object.objectKey,
          mimeType: object.mimeType,
          byteSize: object.byteSize,
          sha256: object.sha256,
          createdAt: toIsoUtc(this.service.clock.now()),
        };
        artifactCreated = true;
      }
    } catch (error) {
      await this.failAttempt(
        attemptId,
        'failed',
        'ARTIFACT_STORAGE_FAILED',
        error instanceof Error ? error.message : 'Artifact storage failed.',
      );
      return;
    }
    const evaluation = existingEvaluation
      ? {
          evaluatorVersion: existingEvaluation.evaluatorVersion,
          status: existingEvaluation.status,
          checks: existingEvaluation.checks,
          details: existingEvaluation.details,
          ...(existingEvaluation.status === 'failed'
            ? { failureCode: evaluationFailureCode(existingEvaluation) }
            : {}),
        }
      : await this.service.evaluator.evaluate({
          bytes,
          artifact,
          expectedWidth: PREVIEW_WIDTH,
          expectedHeight: PREVIEW_HEIGHT,
          expectedDurationSeconds: this.service.previewDurationSeconds,
        });
    await this.service.store.withTransaction(async (repositories) => {
      const current = await repositories.attempts.findById(
        this.service.tenantId,
        attemptId,
      );
      if (!current || isTerminalGenerationAttempt(current.status)) return;
      if (!existingArtifact) {
        await repositories.artifacts.create(artifact);
      }
      let working: GenerationAttempt = {
        ...current,
        artifactId: artifact.id,
        finishedAt: current.finishedAt ?? toIsoUtc(this.service.clock.now()),
      };
      if (working.status === 'claimed') {
        working = transitionGenerationAttempt(working, 'submitting');
        working = transitionGenerationAttempt(working, 'submitted');
      }
      if (
        working.status === 'queued' ||
        working.status === 'submitting' ||
        working.status === 'submitted'
      ) {
        working = transitionGenerationAttempt(working, 'running');
      }
      if (working.status === 'running') {
        working = transitionGenerationAttempt(working, 'generated');
      }
      if (working.status === 'generated') {
        working = transitionGenerationAttempt(working, 'evaluating');
      }
      if (working.status !== 'evaluating') return;
      const evaluating = updatedAt(working, this.service.clock);
      const result: EvaluationResult = {
        id: existingEvaluation?.id ?? this.service.idGenerator.next(),
        tenantId: current.tenantId,
        projectId: current.projectId,
        shotId: current.shotId,
        attemptId: current.id,
        evaluatorVersion: evaluation.evaluatorVersion,
        status: evaluation.status,
        checks: evaluation.checks,
        details: evaluation.details,
        evaluatedAt: toIsoUtc(this.service.clock.now()),
      };
      await repositories.attempts.update(evaluating, current.version);
      if (working.status === 'evaluating' && current.status !== 'evaluating') {
        await this.service.appendEvent(repositories, {
          type: 'attempt.generated',
          projectId: current.projectId,
          shotId: current.shotId,
          attemptId: current.id,
          ...(current.comfyPromptId ? { promptId: current.comfyPromptId } : {}),
          payload: { artifactId: artifact.id },
        });
        await this.service.appendEvent(repositories, {
          type: 'attempt.evaluating',
          projectId: current.projectId,
          shotId: current.shotId,
          attemptId: current.id,
          payload: { evaluatorVersion: evaluation.evaluatorVersion },
        });
      }
      if (!existingEvaluation) await repositories.evaluations.create(result);
      if (evaluation.status === 'passed') {
        const reviewable = clearLease(
          updatedAt(
            transitionGenerationAttempt(evaluating, 'awaiting_review'),
            this.service.clock,
          ),
        );
        await repositories.attempts.update(reviewable, evaluating.version);
        const shot = await repositories.shots.findById(
          current.projectId,
          current.shotId,
        );
        if (shot && shot.status === 'generating') {
          await repositories.shots.update(
            updatedAt(
              transitionShot(shot, 'awaiting_review'),
              this.service.clock,
            ),
            shot.version,
          );
        }
        const project = await repositories.projects.findById(
          this.service.tenantId,
          current.projectId,
        );
        if (project && project.status === 'generating') {
          await repositories.projects.update(
            updatedAt(
              transitionProject(project, 'awaiting_final_review'),
              this.service.clock,
            ),
            project.version,
          );
        }
      } else {
        const failed = setFailure(
          clearLease(
            updatedAt(
              transitionGenerationAttempt(evaluating, 'failed'),
              this.service.clock,
            ),
          ),
          (evaluation.failureCode ??
            'MEDIA_DECODE_FAILED') as AttemptFailureCode,
          evaluation.failureCode ?? 'Media evaluation failed.',
        );
        await repositories.attempts.update(failed, evaluating.version);
        const shot = await repositories.shots.findById(
          current.projectId,
          current.shotId,
        );
        if (
          shot &&
          (shot.status === 'generating' || shot.status === 'queued')
        ) {
          await repositories.shots.update(
            updatedAt(transitionShot(shot, 'failed'), this.service.clock),
            shot.version,
          );
        }
        const project = await repositories.projects.findById(
          this.service.tenantId,
          current.projectId,
        );
        if (project && project.status === 'generating') {
          await repositories.projects.update(
            updatedAt(transitionProject(project, 'failed'), this.service.clock),
            project.version,
          );
        }
      }
      if (artifactCreated) {
        await this.service.appendEvent(repositories, {
          type: 'artifact.stored',
          projectId: current.projectId,
          shotId: current.shotId,
          attemptId: current.id,
          payload: {
            artifactId: artifact.id,
            byteSize: artifact.byteSize,
            sha256: artifact.sha256,
          },
        });
      }
      if (!existingEvaluation) {
        await this.service.appendEvent(repositories, {
          type: 'evaluation.completed',
          projectId: current.projectId,
          shotId: current.shotId,
          attemptId: current.id,
          payload: {
            evaluationId: result.id,
            status: result.status,
            evaluatorVersion: result.evaluatorVersion,
          },
        });
      }
    });
  }

  private async failAttempt(
    attemptId: Uuid,
    status: 'failed' | 'timed_out' | 'cancelled',
    code: AttemptFailureCode,
    message: string,
  ): Promise<void> {
    if (!ATTEMPT_FAILURE_CODES.includes(code)) code = 'COMFY_EXECUTION_FAILED';
    await this.service.store.withTransaction(async (repositories) => {
      const attempt = await repositories.attempts.findById(
        this.service.tenantId,
        attemptId,
      );
      if (!attempt || isTerminalGenerationAttempt(attempt.status)) return;
      const failed = setFailure(
        clearLease(
          updatedAt(
            transitionGenerationAttempt(attempt, status),
            this.service.clock,
          ),
        ),
        code,
        message,
      );
      await repositories.attempts.update(failed, attempt.version);
      const shot = await repositories.shots.findById(
        attempt.projectId,
        attempt.shotId,
      );
      const recoverable =
        status !== 'cancelled' && RECOVERABLE_FAILURE_CODES.has(code);
      if (shot && (shot.status === 'queued' || shot.status === 'generating')) {
        await repositories.shots.update(
          updatedAt(
            transitionShot(
              shot,
              status === 'cancelled'
                ? 'cancelled'
                : recoverable
                  ? 'retryable'
                  : 'failed',
            ),
            this.service.clock,
          ),
          shot.version,
        );
      }
      const project = await repositories.projects.findById(
        this.service.tenantId,
        attempt.projectId,
      );
      if (project && project.status === 'generating') {
        await repositories.projects.update(
          updatedAt(
            transitionProject(
              project,
              status === 'cancelled'
                ? 'cancelled'
                : recoverable
                  ? 'needs_attention'
                  : 'failed',
            ),
            this.service.clock,
          ),
          project.version,
        );
      }
      await this.service.appendEvent(repositories, {
        type:
          status === 'timed_out'
            ? 'attempt.timed_out'
            : status === 'cancelled'
              ? 'attempt.cancelled'
              : 'attempt.failed',
        projectId: attempt.projectId,
        shotId: attempt.shotId,
        attemptId,
        ...(attempt.comfyPromptId ? { promptId: attempt.comfyPromptId } : {}),
        payload: {
          code,
          message: redactFailureMessage(message),
          recoverable,
        },
      });
    });
  }

  private async currentAttempt(
    attemptId: Uuid,
  ): Promise<GenerationAttempt | null> {
    return this.service.store.withTransaction((repositories) =>
      repositories.attempts.findById(this.service.tenantId, attemptId),
    );
  }

  private async currentProject(projectId: Uuid): Promise<VideoProject | null> {
    return this.service.store.withTransaction((repositories) =>
      repositories.projects.findById(this.service.tenantId, projectId),
    );
  }
}

export function createDefaultGenerationService(
  store: TransactionalStore,
  tenantId: Uuid,
  idGenerator: IdGenerator,
): GenerationApplicationService {
  return new GenerationApplicationService({ store, tenantId, idGenerator });
}

export type GenerationAttemptRepositoryContract = AttemptRepository;
