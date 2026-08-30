import { randomBytes } from 'node:crypto';

export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type MicroUsd = Brand<number, 'MicroUsd'>;
export type Uuid = Brand<string, 'Uuid'>;
export type IsoUtcTimestamp = Brand<string, 'IsoUtcTimestamp'>;

export const MICRO_USD_PER_USD = 1_000_000 as const;
export const STORYBOARD_SHOT_COUNT = 3 as const;
export const STORYBOARD_DURATION_TOLERANCE_SECONDS = 0.05 as const;

export const PROJECT_STATUSES = [
  'draft',
  'planning',
  'awaiting_storyboard_approval',
  'ready_for_generation',
  'generating',
  'needs_attention',
  'awaiting_final_review',
  'failed',
  'cancelled',
  'completed',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const STORYBOARD_STATUSES = [
  'proposed',
  'approved',
  'superseded',
] as const;
export type StoryboardStatus = (typeof STORYBOARD_STATUSES)[number];

export const SHOT_STATUSES = [
  'draft',
  'approved_for_generation',
  'queued',
  'generating',
  'retryable',
  'awaiting_review',
  'accepted',
  'rejected',
  'failed',
  'cancelled',
] as const;
export type ShotStatus = (typeof SHOT_STATUSES)[number];

export const GENERATION_ATTEMPT_STATUSES = [
  'queued',
  'claimed',
  'submitting',
  'submitted',
  'running',
  'generated',
  'evaluating',
  'awaiting_review',
  'accepted',
  'rejected',
  'failed',
  'timed_out',
  'cancelled',
] as const;
export type GenerationAttemptStatus =
  (typeof GENERATION_ATTEMPT_STATUSES)[number];

export const DOMAIN_EVENT_TYPES = [
  'project.created',
  'project.planning_started',
  'project.planned',
  'storyboard.proposed',
  'storyboard.superseded',
  'storyboard.approved',
  'shot.created',
  'project.ready_for_generation',
  'attempt.queued',
  'attempt.claimed',
  'attempt.submitted',
  'attempt.execution_started',
  'attempt.execution_progress',
  'attempt.generated',
  'attempt.evaluating',
  'attempt.failed',
  'attempt.timed_out',
  'attempt.cancelled',
  'attempt.regenerated',
  'artifact.stored',
  'evaluation.completed',
  'attempt.accepted',
  'attempt.rejected',
  'project.budget_denied',
  'orphan.event',
  'project.completed',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export type DomainErrorCode =
  | 'UNKNOWN_PROJECT_STATUS'
  | 'UNKNOWN_STORYBOARD_STATUS'
  | 'UNKNOWN_SHOT_STATUS'
  | 'UNKNOWN_ATTEMPT_STATUS'
  | 'UNKNOWN_EVENT_TYPE'
  | 'INVALID_PROJECT'
  | 'INVALID_STORYBOARD'
  | 'INVALID_SHOT'
  | 'INVALID_ATTEMPT'
  | 'INVALID_PROJECT_TRANSITION'
  | 'INVALID_STORYBOARD_TRANSITION'
  | 'INVALID_SHOT_TRANSITION'
  | 'INVALID_ATTEMPT_TRANSITION'
  | 'TARGET_DURATION_TOO_SHORT'
  | 'INVALID_MONEY'
  | 'NEGATIVE_MONEY'
  | 'MONEY_OVERFLOW'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_UUID'
  | 'ACCEPTED_SHOT_REQUIRES_ATTEMPT';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    if (details) {
      this.details = details;
    }
  }
}

export interface VideoProject {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly title: string;
  readonly brief: string;
  readonly status: ProjectStatus;
  readonly targetDurationSeconds: number;
  readonly budgetMicrousd: MicroUsd;
  readonly spentMicrousd: MicroUsd;
  readonly version: number;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface StoryboardShotDefinition {
  readonly ordinal: 1 | 2 | 3;
  readonly purpose: string;
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly mode: 't2v';
  readonly qualityTier: 'preview';
  readonly visualDescription?: string;
  readonly cameraDirection?: string;
  readonly audioDirection?: string;
  readonly dialogue?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly requiredAssetIds?: readonly string[];
}

export interface StoryboardProposal {
  readonly id: Uuid;
  readonly projectId: Uuid;
  readonly revision: number;
  readonly status: StoryboardStatus;
  readonly shots: readonly StoryboardShotDefinition[];
  readonly totalDurationSeconds: number;
  readonly durationToleranceSeconds: number;
  readonly objective?: string;
  readonly assumptions?: readonly string[];
  readonly risks?: readonly string[];
  readonly agentRunId?: Uuid;
  readonly version: number;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export type ShotOrdinal = 1 | 2 | 3;

export interface Shot {
  readonly id: Uuid;
  readonly projectId: Uuid;
  readonly storyboardProposalId: Uuid;
  readonly ordinal: ShotOrdinal;
  readonly purpose: string;
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly mode: 't2v';
  readonly qualityTier: 'preview';
  readonly visualDescription?: string;
  readonly cameraDirection?: string;
  readonly audioDirection?: string;
  readonly dialogue?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly requiredAssetIds?: readonly string[];
  readonly status: ShotStatus;
  readonly acceptedAttemptId?: Uuid;
  readonly version: number;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export const ATTEMPT_FAILURE_CODES = [
  'COMFY_UNAVAILABLE',
  'COMFY_SUBMISSION_UNCERTAIN',
  'COMFY_EXECUTION_FAILED',
  'COMFY_INTERRUPTED',
  'GENERATION_TIMEOUT',
  'ARTIFACT_DOWNLOAD_FAILED',
  'ARTIFACT_STORAGE_FAILED',
  'MEDIA_NOT_FOUND',
  'MEDIA_INVALID_CONTAINER',
  'MEDIA_MISSING_VIDEO',
  'MEDIA_INVALID_DIMENSIONS',
  'MEDIA_INVALID_DURATION',
  'MEDIA_INVALID_FRAME_RATE',
  'MEDIA_DECODE_FAILED',
  'MEDIA_BLACK_OR_STATIC',
  'MEDIA_CHECKSUM_MISMATCH',
  'MEDIA_SIZE_MISMATCH',
  'REVIEW_REJECTED',
  'BUDGET_EXCEEDED',
  'ATTEMPT_LIMIT_REACHED',
] as const;
export type AttemptFailureCode = (typeof ATTEMPT_FAILURE_CODES)[number];

export interface GenerationAttempt {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly projectId: Uuid;
  readonly shotId: Uuid;
  readonly idempotencyKey: string;
  readonly status: GenerationAttemptStatus;
  readonly seed: number;
  readonly steps: number;
  readonly requestedWidth: number;
  readonly requestedHeight: number;
  readonly requestedDurationSeconds: number;
  readonly workflowVersionId?: Uuid;
  readonly workflowRevisionId?: Uuid;
  readonly workflowHash: string;
  readonly correlationId: string;
  readonly traceId?: string;
  readonly scenario?: string;
  readonly comfyPromptId?: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: IsoUtcTimestamp;
  readonly queuedAt: IsoUtcTimestamp;
  readonly submittedAt?: IsoUtcTimestamp;
  readonly finishedAt?: IsoUtcTimestamp;
  readonly computeSeconds?: number;
  readonly estimatedCostMicrousd: MicroUsd;
  readonly failureCode?: AttemptFailureCode;
  readonly failureMessage?: string;
  readonly sourceAttemptId?: Uuid;
  readonly artifactId?: Uuid;
  readonly version: number;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface ArtifactRecord {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly projectId: Uuid;
  readonly shotId: Uuid;
  readonly attemptId: Uuid;
  readonly objectKey: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly createdAt: IsoUtcTimestamp;
}

export type EvaluationCheckStatus = 'passed' | 'failed' | 'not_applicable';

export interface EvaluationCheck {
  readonly status: EvaluationCheckStatus;
  readonly detail: string;
}

export interface EvaluationResult {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly projectId: Uuid;
  readonly shotId: Uuid;
  readonly attemptId: Uuid;
  readonly evaluatorVersion: string;
  readonly status: 'passed' | 'failed';
  readonly checks: Readonly<Record<string, EvaluationCheck>>;
  readonly details: Readonly<Record<string, unknown>>;
  readonly evaluatedAt: IsoUtcTimestamp;
}

export interface DomainEvent {
  readonly id: Uuid;
  readonly type: DomainEventType;
  readonly version: number;
  readonly occurredAt: IsoUtcTimestamp;
  readonly observedAt: IsoUtcTimestamp;
  readonly producer: string;
  readonly tenantId: Uuid;
  readonly projectId?: Uuid;
  readonly shotId?: Uuid;
  readonly attemptId?: Uuid;
  readonly promptId?: string;
  readonly traceId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): Uuid;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const PROJECT_STATUS_TRANSITIONS: Readonly<
  Record<ProjectStatus, readonly ProjectStatus[]>
> = {
  draft: ['planning'],
  planning: ['awaiting_storyboard_approval'],
  awaiting_storyboard_approval: [
    'planning',
    'ready_for_generation',
    'cancelled',
  ],
  ready_for_generation: ['generating', 'cancelled'],
  generating: [
    'awaiting_final_review',
    'needs_attention',
    'failed',
    'cancelled',
  ],
  needs_attention: ['generating', 'cancelled'],
  awaiting_final_review: ['generating', 'completed', 'cancelled'],
  failed: [],
  cancelled: [],
  completed: [],
};

export const STORYBOARD_STATUS_TRANSITIONS: Readonly<
  Record<StoryboardStatus, readonly StoryboardStatus[]>
> = {
  proposed: ['approved', 'superseded'],
  approved: [],
  superseded: [],
};

export const SHOT_STATUS_TRANSITIONS: Readonly<
  Record<ShotStatus, readonly ShotStatus[]>
> = {
  draft: ['approved_for_generation', 'cancelled', 'failed'],
  approved_for_generation: ['queued', 'cancelled', 'failed'],
  queued: ['generating', 'retryable', 'cancelled', 'failed'],
  generating: ['awaiting_review', 'retryable', 'cancelled', 'failed'],
  retryable: ['queued', 'cancelled'],
  awaiting_review: ['accepted', 'rejected', 'cancelled', 'failed'],
  accepted: [],
  rejected: ['queued', 'cancelled', 'failed'],
  failed: [],
  cancelled: [],
};

export const ATTEMPT_STATUS_TRANSITIONS: Readonly<
  Record<GenerationAttemptStatus, readonly GenerationAttemptStatus[]>
> = {
  queued: ['claimed', 'running', 'cancelled', 'failed'],
  claimed: ['submitting', 'queued', 'cancelled', 'failed'],
  submitting: ['submitted', 'queued', 'failed', 'timed_out'],
  submitted: ['running', 'failed', 'timed_out', 'cancelled'],
  running: ['generated', 'evaluating', 'failed', 'timed_out', 'cancelled'],
  generated: ['evaluating', 'failed'],
  evaluating: ['awaiting_review', 'failed'],
  awaiting_review: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
  failed: [],
  timed_out: [],
  cancelled: [],
};

const projectStatusSet = new Set<string>(PROJECT_STATUSES);
const storyboardStatusSet = new Set<string>(STORYBOARD_STATUSES);
const shotStatusSet = new Set<string>(SHOT_STATUSES);
const attemptStatusSet = new Set<string>(GENERATION_ATTEMPT_STATUSES);
const eventTypeSet = new Set<string>(DOMAIN_EVENT_TYPES);

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function assertSafeInteger(value: number, code: DomainErrorCode): void {
  if (!Number.isSafeInteger(value)) {
    throw new DomainError(code, 'Expected a safe integer.');
  }
}

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === 'string' && projectStatusSet.has(value);
}

export function isStoryboardStatus(value: unknown): value is StoryboardStatus {
  return typeof value === 'string' && storyboardStatusSet.has(value);
}

export function isShotStatus(value: unknown): value is ShotStatus {
  return typeof value === 'string' && shotStatusSet.has(value);
}

export function isGenerationAttemptStatus(
  value: unknown,
): value is GenerationAttemptStatus {
  return typeof value === 'string' && attemptStatusSet.has(value);
}

export function isDomainEventType(value: unknown): value is DomainEventType {
  return typeof value === 'string' && eventTypeSet.has(value);
}

export function parseProjectStatus(value: unknown): ProjectStatus {
  if (!isProjectStatus(value)) {
    throw new DomainError(
      'UNKNOWN_PROJECT_STATUS',
      'The project status is not recognized.',
    );
  }
  return value;
}

export function parseStoryboardStatus(value: unknown): StoryboardStatus {
  if (!isStoryboardStatus(value)) {
    throw new DomainError(
      'UNKNOWN_STORYBOARD_STATUS',
      'The storyboard status is not recognized.',
    );
  }
  return value;
}

export function parseShotStatus(value: unknown): ShotStatus {
  if (!isShotStatus(value)) {
    throw new DomainError(
      'UNKNOWN_SHOT_STATUS',
      'The shot status is not recognized.',
    );
  }
  return value;
}

export function parseGenerationAttemptStatus(
  value: unknown,
): GenerationAttemptStatus {
  if (!isGenerationAttemptStatus(value)) {
    throw new DomainError(
      'UNKNOWN_ATTEMPT_STATUS',
      'The generation attempt status is not recognized.',
    );
  }
  return value;
}

export function parseDomainEventType(value: unknown): DomainEventType {
  if (!isDomainEventType(value)) {
    throw new DomainError(
      'UNKNOWN_EVENT_TYPE',
      'The domain event type is not recognized.',
    );
  }
  return value;
}

function assertUtcTimestamp(value: string): IsoUtcTimestamp {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new DomainError(
      'INVALID_TIMESTAMP',
      'Timestamps must be ISO-8601 UTC values.',
    );
  }
  return value as IsoUtcTimestamp;
}

export function toIsoUtc(date: Date): IsoUtcTimestamp {
  if (!Number.isFinite(date.getTime())) {
    throw new DomainError(
      'INVALID_TIMESTAMP',
      'The clock returned an invalid date.',
    );
  }
  return date.toISOString() as IsoUtcTimestamp;
}

export function assertUuid(value: string): Uuid {
  if (!UUID_V7_PATTERN.test(value)) {
    throw new DomainError('INVALID_UUID', 'Expected a UUID v7 identifier.');
  }
  return value as Uuid;
}

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV7(value: unknown): value is Uuid {
  return typeof value === 'string' && UUID_V7_PATTERN.test(value);
}

export function createUuidV7(
  timestampMilliseconds = Date.now(),
  randomValues: Uint8Array = randomBytes(10),
): Uuid {
  if (
    !Number.isSafeInteger(timestampMilliseconds) ||
    timestampMilliseconds < 0 ||
    timestampMilliseconds > 0xffffffffffff
  ) {
    throw new DomainError('INVALID_TIMESTAMP', 'UUID v7 time is out of range.');
  }
  if (randomValues.length < 10) {
    throw new DomainError('INVALID_UUID', 'UUID v7 requires ten random bytes.');
  }

  const bytes = new Uint8Array(16);
  let time = timestampMilliseconds;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time & 0xff;
    time = Math.floor(time / 256);
  }
  const random0 = randomValues[0] ?? 0;
  const random1 = randomValues[1] ?? 0;
  const random2 = randomValues[2] ?? 0;
  bytes[6] = 0x70 | (random0 & 0x0f);
  bytes[7] = random1;
  bytes[8] = 0x80 | (random2 & 0x3f);
  bytes.set(randomValues.slice(3, 10), 9);

  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as Uuid;
}

export const systemIdGenerator: IdGenerator = {
  next: () => createUuidV7(),
};

export function parseUsdToMicrousd(value: string | number): MicroUsd {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) {
    throw new DomainError(
      'INVALID_MONEY',
      'Money must be a non-negative decimal with at most six fractional digits.',
    );
  }
  const wholePart = match[1];
  if (!wholePart) {
    throw new DomainError(
      'INVALID_MONEY',
      'Money must include a whole-number part.',
    );
  }
  const whole = BigInt(wholePart);
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0') || '0');
  const result = whole * BigInt(MICRO_USD_PER_USD) + fraction;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainError(
      'MONEY_OVERFLOW',
      'Money exceeds the safe integer range.',
    );
  }
  return Number(result) as MicroUsd;
}

export function assertMicrousd(value: number): MicroUsd {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      'INVALID_MONEY',
      'Money must be a non-negative safe integer.',
    );
  }
  return value as MicroUsd;
}

export function addMicrousd(...values: readonly MicroUsd[]): MicroUsd {
  const result = values.reduce((sum, value) => sum + value, 0);
  assertSafeInteger(result, 'MONEY_OVERFLOW');
  return assertMicrousd(result);
}

export function subtractMicrousd(
  minuend: MicroUsd,
  subtrahend: MicroUsd,
): MicroUsd {
  if (subtrahend > minuend) {
    throw new DomainError(
      'NEGATIVE_MONEY',
      'Money arithmetic cannot become negative.',
    );
  }
  return assertMicrousd(minuend - subtrahend);
}

export function formatMicrousdToUsd(value: MicroUsd): string {
  assertMicrousd(value);
  const whole = Math.floor(value / MICRO_USD_PER_USD);
  const fraction = String(value % MICRO_USD_PER_USD).padStart(6, '0');
  const trimmed = fraction.replace(/0+$/, '');
  return `${whole}.${trimmed || '0'}`;
}

function assertProject(project: VideoProject): void {
  parseProjectStatus(project.status);
  assertUuid(project.id);
  assertUuid(project.tenantId);
  if (!project.title.trim() || !project.brief.trim()) {
    throw new DomainError(
      'INVALID_PROJECT',
      'Projects require a title and brief.',
    );
  }
  if (
    !isFiniteNumber(project.targetDurationSeconds) ||
    project.targetDurationSeconds < STORYBOARD_SHOT_COUNT
  ) {
    throw new DomainError(
      'TARGET_DURATION_TOO_SHORT',
      'The project target duration must allow three positive-duration shots.',
    );
  }
  assertMicrousd(project.budgetMicrousd);
  assertMicrousd(project.spentMicrousd);
  if (project.spentMicrousd > project.budgetMicrousd) {
    throw new DomainError(
      'INVALID_PROJECT',
      'Project spend cannot exceed its budget.',
    );
  }
  assertSafeInteger(project.version, 'INVALID_PROJECT');
  if (project.version < 1) {
    throw new DomainError(
      'INVALID_PROJECT',
      'Project version must be positive.',
    );
  }
  assertUtcTimestamp(project.createdAt);
  assertUtcTimestamp(project.updatedAt);
}

function assertShotDefinition(definition: StoryboardShotDefinition): void {
  if (
    !isFiniteNumber(definition.durationSeconds) ||
    definition.durationSeconds <= 0
  ) {
    throw new DomainError('INVALID_SHOT', 'Shot duration must be positive.');
  }
  if (
    typeof definition.purpose !== 'string' ||
    typeof definition.prompt !== 'string' ||
    !definition.purpose.trim() ||
    !definition.prompt.trim()
  ) {
    throw new DomainError(
      'INVALID_SHOT',
      'Shots require a purpose and prompt.',
    );
  }
  if (definition.mode !== 't2v' || definition.qualityTier !== 'preview') {
    throw new DomainError(
      'INVALID_SHOT',
      'Phase 2 supports preview T2V shots only.',
    );
  }
  const optionalTextFields: readonly unknown[] = [
    definition.visualDescription,
    definition.cameraDirection,
    definition.audioDirection,
    definition.dialogue,
  ];
  if (
    optionalTextFields.some(
      (value) =>
        value !== undefined &&
        (typeof value !== 'string' || !value.trim() || value.length > 2_000),
    )
  ) {
    throw new DomainError(
      'INVALID_SHOT',
      'Optional shot direction text must be non-empty and bounded.',
    );
  }
  if (definition.acceptanceCriteria !== undefined) {
    assertBoundedStringArray(
      definition.acceptanceCriteria,
      8,
      280,
      'Shot acceptance criteria must be bounded.',
    );
  }
  if (definition.requiredAssetIds !== undefined) {
    assertBoundedStringArray(
      definition.requiredAssetIds,
      32,
      200,
      'Shot asset identifiers must be bounded strings.',
    );
  }
  if (definition.requiredAssetIds?.length) {
    throw new DomainError(
      'INVALID_SHOT',
      'T2V shots cannot contain asset references.',
    );
  }
}

function assertBoundedStringArray(
  value: unknown,
  maxItems: number,
  maxItemLength: number,
  message: string,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some(
      (item) =>
        typeof item !== 'string' || !item.trim() || item.length > maxItemLength,
    )
  ) {
    throw new DomainError('INVALID_SHOT', message);
  }
}

function assertStoryboard(proposal: StoryboardProposal): void {
  parseStoryboardStatus(proposal.status);
  assertUuid(proposal.id);
  assertUuid(proposal.projectId);
  assertSafeInteger(proposal.revision, 'INVALID_STORYBOARD');
  assertSafeInteger(proposal.version, 'INVALID_STORYBOARD');
  if (proposal.revision < 1 || proposal.version < 1) {
    throw new DomainError(
      'INVALID_STORYBOARD',
      'Storyboard revision and version must be positive.',
    );
  }
  if (
    proposal.objective !== undefined &&
    (!proposal.objective.trim() || proposal.objective.length > 400)
  ) {
    throw new DomainError(
      'INVALID_STORYBOARD',
      'Storyboard objective must be non-empty and bounded.',
    );
  }
  for (const values of [proposal.assumptions, proposal.risks]) {
    if (
      values &&
      (values.length > 12 ||
        values.some((value) => !value.trim() || value.length > 280))
    ) {
      throw new DomainError(
        'INVALID_STORYBOARD',
        'Storyboard assumptions and risks must be bounded.',
      );
    }
  }
  if (proposal.agentRunId) {
    assertUuid(proposal.agentRunId);
  }
  if (proposal.shots.length !== STORYBOARD_SHOT_COUNT) {
    throw new DomainError(
      'INVALID_STORYBOARD',
      'A storyboard must contain exactly three shots.',
    );
  }
  const ordinals = proposal.shots.map((shot) => shot.ordinal);
  if (ordinals.join(',') !== '1,2,3') {
    throw new DomainError(
      'INVALID_STORYBOARD',
      'Storyboard shot ordinals must be 1, 2, and 3.',
    );
  }
  proposal.shots.forEach(assertShotDefinition);
  const total = proposal.shots.reduce(
    (sum, shot) => sum + shot.durationSeconds,
    0,
  );
  if (
    !isFiniteNumber(proposal.totalDurationSeconds) ||
    proposal.totalDurationSeconds <= 0 ||
    !isFiniteNumber(proposal.durationToleranceSeconds) ||
    proposal.durationToleranceSeconds < 0 ||
    Math.abs(total - proposal.totalDurationSeconds) >
      proposal.durationToleranceSeconds
  ) {
    throw new DomainError(
      'INVALID_STORYBOARD',
      'Storyboard duration metadata is inconsistent.',
    );
  }
  assertUtcTimestamp(proposal.createdAt);
  assertUtcTimestamp(proposal.updatedAt);
}

function assertShot(shot: Shot): void {
  parseShotStatus(shot.status);
  assertUuid(shot.id);
  assertUuid(shot.projectId);
  assertUuid(shot.storyboardProposalId);
  if (![1, 2, 3].includes(shot.ordinal)) {
    throw new DomainError('INVALID_SHOT', 'Shot ordinal must be 1, 2, or 3.');
  }
  assertShotDefinition(shot);
  if (shot.acceptedAttemptId) {
    assertUuid(shot.acceptedAttemptId);
  }
  assertSafeInteger(shot.version, 'INVALID_SHOT');
  if (shot.version < 1) {
    throw new DomainError('INVALID_SHOT', 'Shot version must be positive.');
  }
  assertUtcTimestamp(shot.createdAt);
  assertUtcTimestamp(shot.updatedAt);
  if (shot.status === 'accepted' && !shot.acceptedAttemptId) {
    throw new DomainError(
      'ACCEPTED_SHOT_REQUIRES_ATTEMPT',
      'An accepted shot must identify its accepted attempt.',
    );
  }
}

function assertAttempt(attempt: GenerationAttempt): void {
  parseGenerationAttemptStatus(attempt.status);
  assertUuid(attempt.id);
  assertUuid(attempt.tenantId);
  assertUuid(attempt.projectId);
  assertUuid(attempt.shotId);
  if (!attempt.idempotencyKey.trim() || attempt.idempotencyKey.length > 200) {
    throw new DomainError(
      'INVALID_ATTEMPT',
      'Generation attempts require a bounded idempotency key.',
    );
  }
  if (!Number.isSafeInteger(attempt.seed)) {
    throw new DomainError(
      'INVALID_ATTEMPT',
      'Attempt seed must be a safe integer.',
    );
  }
  if (!Number.isSafeInteger(attempt.steps) || attempt.steps <= 0) {
    throw new DomainError(
      'INVALID_ATTEMPT',
      'Attempt steps must be a positive safe integer.',
    );
  }
  if (
    !Number.isSafeInteger(attempt.requestedWidth) ||
    attempt.requestedWidth <= 0 ||
    !Number.isSafeInteger(attempt.requestedHeight) ||
    attempt.requestedHeight <= 0
  ) {
    throw new DomainError(
      'INVALID_ATTEMPT',
      'Attempt dimensions must be positive safe integers.',
    );
  }
  if (
    !isFiniteNumber(attempt.requestedDurationSeconds) ||
    attempt.requestedDurationSeconds <= 0
  ) {
    throw new DomainError(
      'INVALID_ATTEMPT',
      'Attempt duration must be positive.',
    );
  }
  if (!attempt.workflowHash.trim() || !attempt.correlationId.trim()) {
    throw new DomainError(
      'INVALID_ATTEMPT',
      'Attempts require workflow and correlation identifiers.',
    );
  }
  if (attempt.scenario !== undefined && attempt.scenario.length > 64) {
    throw new DomainError(
      'INVALID_ATTEMPT',
      'Attempt scenarios must be short.',
    );
  }
  assertMicrousd(attempt.estimatedCostMicrousd);
  if (
    attempt.computeSeconds !== undefined &&
    (!isFiniteNumber(attempt.computeSeconds) || attempt.computeSeconds < 0)
  ) {
    throw new DomainError(
      'INVALID_ATTEMPT',
      'Attempt compute time must be non-negative.',
    );
  }
  if (
    attempt.failureCode !== undefined &&
    !ATTEMPT_FAILURE_CODES.includes(attempt.failureCode)
  ) {
    throw new DomainError(
      'INVALID_ATTEMPT',
      'Attempt failure code is unknown.',
    );
  }
  if (
    attempt.failureMessage !== undefined &&
    attempt.failureMessage.length > 500
  ) {
    throw new DomainError(
      'INVALID_ATTEMPT',
      'Attempt failure messages must be short and redacted.',
    );
  }
  assertUuidIfPresent(attempt.workflowVersionId);
  assertUuidIfPresent(attempt.workflowRevisionId);
  if (attempt.workflowVersionId && attempt.workflowRevisionId) {
    throw new DomainError(
      'INVALID_ATTEMPT',
      'An attempt cannot reference both a legacy workflow version and a managed workflow revision.',
    );
  }
  assertUuidIfPresent(attempt.sourceAttemptId);
  assertUuidIfPresent(attempt.artifactId);
  assertIsoIfPresent(attempt.leaseExpiresAt);
  assertIsoIfPresent(attempt.submittedAt);
  assertIsoIfPresent(attempt.finishedAt);
  if (attempt.comfyPromptId !== undefined && !attempt.comfyPromptId.trim()) {
    throw new DomainError(
      'INVALID_ATTEMPT',
      'Comfy prompt identifiers are non-blank.',
    );
  }
  if (attempt.leaseOwner !== undefined && !attempt.leaseOwner.trim()) {
    throw new DomainError('INVALID_ATTEMPT', 'Lease owners are non-blank.');
  }
  assertSafeInteger(attempt.version, 'INVALID_ATTEMPT');
  if (attempt.version < 1) {
    throw new DomainError(
      'INVALID_ATTEMPT',
      'Attempt version must be positive.',
    );
  }
  assertUtcTimestamp(attempt.queuedAt);
  assertUtcTimestamp(attempt.createdAt);
  assertUtcTimestamp(attempt.updatedAt);
}

function assertUuidIfPresent(value: Uuid | undefined): void {
  if (value !== undefined) {
    assertUuid(value);
  }
}

function assertIsoIfPresent(value: IsoUtcTimestamp | undefined): void {
  if (value !== undefined) {
    assertUtcTimestamp(value);
  }
}

function transition<
  T extends { readonly status: string; readonly version: number },
>(
  entity: T,
  nextStatus: string,
  currentStatus: string,
  allowed: Readonly<Record<string, readonly string[]>>,
  code: DomainErrorCode,
  unknownCode: DomainErrorCode,
): T {
  if (!Object.hasOwn(allowed, currentStatus)) {
    throw new DomainError(unknownCode, 'The current status is not recognized.');
  }
  if (!Object.hasOwn(allowed, nextStatus)) {
    throw new DomainError(unknownCode, 'The next status is not recognized.');
  }
  if (!allowed[currentStatus]?.includes(nextStatus)) {
    throw new DomainError(
      code,
      `Transition from ${currentStatus} to ${nextStatus} is not allowed.`,
    );
  }
  return {
    ...entity,
    status: nextStatus,
    version: entity.version + 1,
  } as T;
}

export function transitionProject(
  project: VideoProject,
  nextStatus: unknown,
): VideoProject {
  assertProject(project);
  const currentStatus = parseProjectStatus(project.status);
  const parsedNextStatus = parseProjectStatus(nextStatus);
  return transition(
    project,
    parsedNextStatus,
    currentStatus,
    PROJECT_STATUS_TRANSITIONS,
    'INVALID_PROJECT_TRANSITION',
    'UNKNOWN_PROJECT_STATUS',
  );
}

export function transitionStoryboard(
  proposal: StoryboardProposal,
  nextStatus: unknown,
): StoryboardProposal {
  assertStoryboard(proposal);
  const currentStatus = parseStoryboardStatus(proposal.status);
  const parsedNextStatus = parseStoryboardStatus(nextStatus);
  return transition(
    proposal,
    parsedNextStatus,
    currentStatus,
    STORYBOARD_STATUS_TRANSITIONS,
    'INVALID_STORYBOARD_TRANSITION',
    'UNKNOWN_STORYBOARD_STATUS',
  );
}

export function transitionShot(shot: Shot, nextStatus: unknown): Shot {
  assertShot(shot);
  const currentStatus = parseShotStatus(shot.status);
  const parsedNextStatus = parseShotStatus(nextStatus);
  const next = transition(
    shot,
    parsedNextStatus,
    currentStatus,
    SHOT_STATUS_TRANSITIONS,
    'INVALID_SHOT_TRANSITION',
    'UNKNOWN_SHOT_STATUS',
  );
  if (parsedNextStatus === 'accepted' && !next.acceptedAttemptId) {
    throw new DomainError(
      'ACCEPTED_SHOT_REQUIRES_ATTEMPT',
      'An accepted shot must identify its accepted attempt.',
    );
  }
  return next;
}

export function transitionGenerationAttempt(
  attempt: GenerationAttempt,
  nextStatus: unknown,
): GenerationAttempt {
  assertAttempt(attempt);
  const currentStatus = parseGenerationAttemptStatus(attempt.status);
  const parsedNextStatus = parseGenerationAttemptStatus(nextStatus);
  return transition(
    attempt,
    parsedNextStatus,
    currentStatus,
    ATTEMPT_STATUS_TRANSITIONS,
    'INVALID_ATTEMPT_TRANSITION',
    'UNKNOWN_ATTEMPT_STATUS',
  );
}

export type TransitionResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: DomainError };

export function tryTransitionProject(
  project: VideoProject,
  nextStatus: unknown,
): TransitionResult<VideoProject> {
  try {
    return { ok: true, value: transitionProject(project, nextStatus) };
  } catch (error) {
    if (error instanceof DomainError) {
      return { ok: false, error };
    }
    throw error;
  }
}

export function tryTransitionStoryboard(
  proposal: StoryboardProposal,
  nextStatus: unknown,
): TransitionResult<StoryboardProposal> {
  try {
    return { ok: true, value: transitionStoryboard(proposal, nextStatus) };
  } catch (error) {
    if (error instanceof DomainError) {
      return { ok: false, error };
    }
    throw error;
  }
}

export function tryTransitionShot(
  shot: Shot,
  nextStatus: unknown,
): TransitionResult<Shot> {
  try {
    return { ok: true, value: transitionShot(shot, nextStatus) };
  } catch (error) {
    if (error instanceof DomainError) {
      return { ok: false, error };
    }
    throw error;
  }
}

export function tryTransitionGenerationAttempt(
  attempt: GenerationAttempt,
  nextStatus: unknown,
): TransitionResult<GenerationAttempt> {
  try {
    return {
      ok: true,
      value: transitionGenerationAttempt(attempt, nextStatus),
    };
  } catch (error) {
    if (error instanceof DomainError) {
      return { ok: false, error };
    }
    throw error;
  }
}

export function isTerminalGenerationAttempt(
  status: GenerationAttemptStatus,
): boolean {
  return (
    status === 'accepted' ||
    status === 'rejected' ||
    status === 'failed' ||
    status === 'timed_out' ||
    status === 'cancelled'
  );
}

export interface CreateProjectInput {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly title: string;
  readonly brief: string;
  readonly targetDurationSeconds: number;
  readonly budgetMicrousd: MicroUsd;
  readonly now: IsoUtcTimestamp;
}

export function createVideoProject(input: CreateProjectInput): VideoProject {
  if (!input.title.trim() || !input.brief.trim()) {
    throw new DomainError(
      'INVALID_PROJECT',
      'Projects require a title and brief.',
    );
  }
  if (
    !isFiniteNumber(input.targetDurationSeconds) ||
    input.targetDurationSeconds < STORYBOARD_SHOT_COUNT
  ) {
    throw new DomainError(
      'TARGET_DURATION_TOO_SHORT',
      'The project target duration must allow three positive-duration shots.',
    );
  }
  const project: VideoProject = {
    id: input.id,
    tenantId: input.tenantId,
    title: input.title.trim(),
    brief: input.brief.trim(),
    status: 'draft',
    targetDurationSeconds: input.targetDurationSeconds,
    budgetMicrousd: assertMicrousd(input.budgetMicrousd),
    spentMicrousd: assertMicrousd(0),
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  assertProject(project);
  return project;
}

export interface CreateStoryboardProposalInput {
  readonly id: Uuid;
  readonly projectId: Uuid;
  readonly revision: number;
  readonly shots: readonly StoryboardShotDefinition[];
  readonly durationToleranceSeconds?: number;
  readonly objective?: string;
  readonly assumptions?: readonly string[];
  readonly risks?: readonly string[];
  readonly agentRunId?: Uuid;
  readonly now: IsoUtcTimestamp;
}

export function createStoryboardProposal(
  input: CreateStoryboardProposalInput,
): StoryboardProposal {
  const totalDurationSeconds = input.shots.reduce(
    (sum, shot) => sum + shot.durationSeconds,
    0,
  );
  const proposal: StoryboardProposal = {
    id: input.id,
    projectId: input.projectId,
    revision: input.revision,
    status: 'proposed',
    shots: [...input.shots],
    totalDurationSeconds,
    durationToleranceSeconds:
      input.durationToleranceSeconds ?? STORYBOARD_DURATION_TOLERANCE_SECONDS,
    ...(input.objective !== undefined ? { objective: input.objective } : {}),
    ...(input.assumptions !== undefined
      ? { assumptions: [...input.assumptions] }
      : {}),
    ...(input.risks !== undefined ? { risks: [...input.risks] } : {}),
    ...(input.agentRunId !== undefined ? { agentRunId: input.agentRunId } : {}),
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  assertStoryboard(proposal);
  return proposal;
}

export interface CreateShotInput {
  readonly id: Uuid;
  readonly projectId: Uuid;
  readonly storyboardProposalId: Uuid;
  readonly definition: StoryboardShotDefinition;
  readonly now: IsoUtcTimestamp;
}

export function createShot(input: CreateShotInput): Shot {
  const shot: Shot = {
    id: input.id,
    projectId: input.projectId,
    storyboardProposalId: input.storyboardProposalId,
    ordinal: input.definition.ordinal,
    purpose: input.definition.purpose,
    prompt: input.definition.prompt,
    durationSeconds: input.definition.durationSeconds,
    mode: input.definition.mode,
    qualityTier: input.definition.qualityTier,
    status: 'approved_for_generation',
    ...(input.definition.visualDescription !== undefined
      ? { visualDescription: input.definition.visualDescription }
      : {}),
    ...(input.definition.cameraDirection !== undefined
      ? { cameraDirection: input.definition.cameraDirection }
      : {}),
    ...(input.definition.audioDirection !== undefined
      ? { audioDirection: input.definition.audioDirection }
      : {}),
    ...(input.definition.dialogue !== undefined
      ? { dialogue: input.definition.dialogue }
      : {}),
    ...(input.definition.acceptanceCriteria !== undefined
      ? { acceptanceCriteria: [...input.definition.acceptanceCriteria] }
      : {}),
    ...(input.definition.requiredAssetIds !== undefined
      ? { requiredAssetIds: [...input.definition.requiredAssetIds] }
      : {}),
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  assertShot(shot);
  return shot;
}

export interface CreateGenerationAttemptInput {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly projectId: Uuid;
  readonly shotId: Uuid;
  readonly idempotencyKey: string;
  readonly seed: number;
  readonly steps: number;
  readonly requestedWidth: number;
  readonly requestedHeight: number;
  readonly requestedDurationSeconds: number;
  readonly workflowVersionId?: Uuid;
  readonly workflowRevisionId?: Uuid;
  readonly workflowHash: string;
  readonly correlationId: string;
  readonly traceId?: string;
  readonly scenario?: string;
  readonly estimatedCostMicrousd: MicroUsd;
  readonly sourceAttemptId?: Uuid;
  readonly now: IsoUtcTimestamp;
}

export function createGenerationAttempt(
  input: CreateGenerationAttemptInput,
): GenerationAttempt {
  const attempt: GenerationAttempt = {
    id: input.id,
    tenantId: input.tenantId,
    projectId: input.projectId,
    shotId: input.shotId,
    idempotencyKey: input.idempotencyKey,
    status: 'queued',
    seed: input.seed,
    steps: input.steps,
    requestedWidth: input.requestedWidth,
    requestedHeight: input.requestedHeight,
    requestedDurationSeconds: input.requestedDurationSeconds,
    workflowHash: input.workflowHash,
    correlationId: input.correlationId,
    estimatedCostMicrousd: assertMicrousd(input.estimatedCostMicrousd),
    version: 1,
    queuedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
    ...(input.workflowVersionId
      ? { workflowVersionId: input.workflowVersionId }
      : {}),
    ...(input.workflowRevisionId
      ? { workflowRevisionId: input.workflowRevisionId }
      : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.scenario ? { scenario: input.scenario } : {}),
    ...(input.sourceAttemptId
      ? { sourceAttemptId: input.sourceAttemptId }
      : {}),
  };
  assertAttempt(attempt);
  return attempt;
}

export function assertGenerationAttempt(attempt: GenerationAttempt): void {
  assertAttempt(attempt);
}

export interface CreateDomainEventInput {
  readonly id: Uuid;
  readonly type: DomainEventType;
  readonly producer: string;
  readonly tenantId: Uuid;
  readonly projectId?: Uuid;
  readonly shotId?: Uuid;
  readonly attemptId?: Uuid;
  readonly promptId?: string;
  readonly traceId?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly clock: Clock;
}

export function createDomainEvent(input: CreateDomainEventInput): DomainEvent {
  const occurredAt = toIsoUtc(input.clock.now());
  return {
    id: input.id,
    type: parseDomainEventType(input.type),
    version: 1,
    occurredAt,
    observedAt: occurredAt,
    producer: input.producer,
    tenantId: input.tenantId,
    payload: input.payload ?? {},
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.shotId ? { shotId: input.shotId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.promptId ? { promptId: input.promptId } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
  };
}

export const DOMAIN_PACKAGE_NAME = '@h3/domain' as const;
