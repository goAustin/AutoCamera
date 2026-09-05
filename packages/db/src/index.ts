import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import {
  assertMicrousd,
  assertGenerationAttempt,
  assertUuid,
  ATTEMPT_FAILURE_CODES,
  type Clock,
  type DomainEvent,
  DomainError,
  parseGenerationAttemptStatus,
  parseDomainEventType,
  parseProjectStatus,
  parseShotStatus,
  toIsoUtc,
  isTerminalGenerationAttempt,
  type ArtifactRecord,
  type AttemptFailureCode,
  type AttemptReviewDecision,
  type EvaluationResult,
  type GenerationAttempt,
  type Shot,
  type Uuid,
  type VideoProject,
} from '@h3/domain';

export interface SqlExecutor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}

export interface DatabasePoolOptions {
  readonly searchPath?: string;
}

export function createDatabasePool(
  databaseUrl: string,
  options: DatabasePoolOptions = {},
): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    application_name: 'h3-videoops-api',
    ...(options.searchPath
      ? { options: `-c search_path=${options.searchPath},public` }
      : {}),
  });
}

export async function checkDatabaseReady(
  pool: Pick<Pool, 'query'>,
): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function runMigrations(pool: Pool): Promise<void> {
  const migrationsDirectory = fileURLToPath(
    new URL('../migrations/', import.meta.url),
  );
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // Integration workers and application instances can start together. Keep
    // migration discovery and application single-writer so a new migration is
    // never executed concurrently by two transactions.
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('h3-videoops-schema-migrations', 0)
       )`,
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS h3_schema_migrations (
        migration_id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    for (const file of migrationFiles) {
      const migrationId = basename(file, '.sql');
      const applied = await client.query<{ migration_id: string }>(
        'SELECT migration_id FROM h3_schema_migrations WHERE migration_id = $1',
        [migrationId],
      );
      if (applied.rows.length > 0) {
        continue;
      }

      const sql = await readFile(join(migrationsDirectory, file), 'utf8');
      await client.query(sql);
      await client.query(
        'INSERT INTO h3_schema_migrations (migration_id) VALUES ($1)',
        [migrationId],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabase(pool: Pool): Promise<void> {
  await pool.end();
}

export type RepositoryErrorCode =
  | 'NOT_FOUND'
  | 'OPTIMISTIC_CONFLICT'
  | 'UNIQUE_VIOLATION'
  | 'SCOPE_VIOLATION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'DATABASE_ERROR';

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;

  constructor(code: RepositoryErrorCode, message: string) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
  }
}

export interface TenantRepository {
  ensure(id: Uuid, name: string, createdAt: string): Promise<void>;
}

export interface ProjectRepository {
  create(project: VideoProject): Promise<void>;
  findById(tenantId: Uuid, projectId: Uuid): Promise<VideoProject | null>;
  listByTenant(tenantId: Uuid): Promise<readonly VideoProject[]>;
  update(project: VideoProject, expectedVersion: number): Promise<VideoProject>;
}

export interface ShotRepository {
  createMany(shots: readonly Shot[]): Promise<void>;
  listByProject(projectId: Uuid): Promise<readonly Shot[]>;
  findById(projectId: Uuid, shotId: Uuid): Promise<Shot | null>;
  findByIdAny(shotId: Uuid): Promise<Shot | null>;
  update(shot: Shot, expectedVersion: number): Promise<Shot>;
}

export interface AttemptRepository {
  create(attempt: GenerationAttempt): Promise<void>;
  findById(tenantId: Uuid, attemptId: Uuid): Promise<GenerationAttempt | null>;
  findByPromptId(
    tenantId: Uuid,
    promptId: string,
  ): Promise<GenerationAttempt | null>;
  findByCorrelationId(
    tenantId: Uuid,
    correlationId: string,
  ): Promise<GenerationAttempt | null>;
  listByShot(
    tenantId: Uuid,
    shotId: Uuid,
  ): Promise<readonly GenerationAttempt[]>;
  listByProject(
    tenantId: Uuid,
    projectId: Uuid,
  ): Promise<readonly GenerationAttempt[]>;
  update(
    attempt: GenerationAttempt,
    expectedVersion: number,
  ): Promise<GenerationAttempt>;
  review(
    tenantId: Uuid,
    attemptId: Uuid,
    decision: AttemptReviewDecision,
    note: string | null,
    author: string,
    reviewedAt: string,
  ): Promise<GenerationAttempt>;
  claimNext(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<GenerationAttempt | null>;
  /** Claim an in-flight attempt for reconciliation without resubmitting it. */
  claimForRecovery(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<GenerationAttempt | null>;
  heartbeat(
    attemptId: Uuid,
    workerId: string,
    leaseExpiresAt: string,
  ): Promise<GenerationAttempt | null>;
  release(
    attemptId: Uuid,
    workerId: string,
    updatedAt: string,
  ): Promise<GenerationAttempt | null>;
  recoverStale(now: string): Promise<readonly GenerationAttempt[]>;
}

export interface ArtifactRepository {
  create(artifact: ArtifactRecord): Promise<void>;
  findById(tenantId: Uuid, artifactId: Uuid): Promise<ArtifactRecord | null>;
  findByAttempt(
    tenantId: Uuid,
    attemptId: Uuid,
  ): Promise<ArtifactRecord | null>;
}

export interface EvaluationRepository {
  create(result: EvaluationResult): Promise<void>;
  findByAttempt(
    tenantId: Uuid,
    attemptId: Uuid,
  ): Promise<EvaluationResult | null>;
}

export const AGENT_RUN_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'aborted',
  'timed_out',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const AGENT_RUN_FAILURE_CODES = [
  'PROVIDER_ERROR',
  'ABORTED',
  'TIMEOUT',
  'INVALID_STRUCTURED_OUTPUT',
  'POLICY_DENIED',
  'APPLICATION_ERROR',
] as const;
export type AgentRunFailureCode = (typeof AGENT_RUN_FAILURE_CODES)[number];

export interface AgentRunRecord {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly projectId: Uuid;
  readonly runId: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly provider: string;
  readonly model: string;
  readonly status: AgentRunStatus;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly providerCostMicrousd: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly failureCode?: AgentRunFailureCode;
  readonly version: number;
  readonly updatedAt: string;
}

export interface AgentRunRepository {
  create(run: AgentRunRecord): Promise<void>;
  findById(tenantId: Uuid, runId: Uuid): Promise<AgentRunRecord | null>;
  listByProject(
    tenantId: Uuid,
    projectId: Uuid,
  ): Promise<readonly AgentRunRecord[]>;
  update(run: AgentRunRecord, expectedVersion: number): Promise<AgentRunRecord>;
}

export interface WorkflowVersionRecord {
  readonly id: Uuid;
  readonly version: string;
  readonly workflowHash: string;
  readonly workflowJson: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface WorkflowVersionRepository {
  findByHash(workflowHash: string): Promise<WorkflowVersionRecord | null>;
  create(version: WorkflowVersionRecord): Promise<void>;
}

export interface WorkflowExecutionEnvelope {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly apiGraph: Readonly<Record<string, unknown>>;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * Canonical JSON used for execution identity and idempotency request hashes.
 * Object keys are sorted recursively; array order is intentionally retained.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RepositoryError(
        'INVALID_ARGUMENT',
        'Canonical JSON cannot contain a non-finite number.',
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Canonical JSON contains a non-JSON value.',
    );
  }
  if (Array.isArray(value)) {
    return `[${Array.from({ length: value.length }, (_, index) => {
      if (!(index in value)) {
        throw new RepositoryError(
          'INVALID_ARGUMENT',
          'Canonical JSON cannot contain sparse arrays.',
        );
      }
      return canonicalizeJson(value[index]);
    }).join(',')}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Canonical JSON only accepts plain objects and arrays.',
    );
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => {
      const candidate = record[key];
      if (candidate === undefined) {
        throw new RepositoryError(
          'INVALID_ARGUMENT',
          'Canonical JSON cannot contain undefined object values.',
        );
      }
      return `${JSON.stringify(key)}:${canonicalizeJson(candidate)}`;
    })
    .join(',')}}`;
}

export function canonicalizeWorkflowExecutionEnvelope(
  envelope: WorkflowExecutionEnvelope,
): string {
  return canonicalizeJson({
    profileId: envelope.profileId,
    profileVersion: envelope.profileVersion,
    apiGraph: envelope.apiGraph,
    parameters: envelope.parameters,
  });
}

export function hashWorkflowExecutionEnvelope(
  envelope: WorkflowExecutionEnvelope,
): string {
  return createHash('sha256')
    .update(canonicalizeWorkflowExecutionEnvelope(envelope), 'utf8')
    .digest('hex');
}

export const WORKFLOW_REVISION_SOURCES = [
  'comfy_editor',
  'official_template',
  'system',
] as const;
export type WorkflowRevisionSource = (typeof WORKFLOW_REVISION_SOURCES)[number];

export const WORKFLOW_REVISION_VALIDATION_STATUSES = [
  'pending',
  'validated',
  'invalid',
] as const;
export type WorkflowRevisionValidationStatus =
  (typeof WORKFLOW_REVISION_VALIDATION_STATUSES)[number];

export interface WorkflowValidationError {
  readonly code: string;
  readonly message: string;
}

export interface WorkflowDraftRecord {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly projectId: Uuid;
  readonly shotId: Uuid;
  readonly baseRevisionId?: Uuid;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly editorGraphJson: Readonly<Record<string, unknown>>;
  readonly lastApiGraphJson?: Readonly<Record<string, unknown>>;
  readonly authorType: string;
  readonly authorId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowDraftRepository {
  findByShot(
    tenantId: Uuid,
    projectId: Uuid,
    shotId: Uuid,
  ): Promise<WorkflowDraftRecord | null>;
  create(
    draft: WorkflowDraftRecord,
    idempotencyKey: string,
  ): Promise<WorkflowDraftRecord>;
  update(
    draft: WorkflowDraftRecord,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<WorkflowDraftRecord>;
}

export interface WorkflowRevisionRecord {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly projectId: Uuid;
  readonly shotId: Uuid;
  readonly revisionNumber: number;
  readonly parentRevisionId?: Uuid;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly source: WorkflowRevisionSource;
  readonly frontendVersion?: string;
  readonly frontendCommit?: string;
  readonly authorType: string;
  readonly authorId: string;
  readonly editorGraphJson: Readonly<Record<string, unknown>>;
  readonly apiGraphJson: Readonly<Record<string, unknown>>;
  readonly executionHash: string;
  readonly executionParametersJson: Readonly<Record<string, unknown>>;
  readonly validationStatus: WorkflowRevisionValidationStatus;
  readonly validationErrorsJson: readonly WorkflowValidationError[];
  readonly validatedAt?: string;
  readonly executorFingerprint?: string;
  readonly createdAt: string;
}

export interface WorkflowRevisionValidationUpdate {
  readonly validationStatus: WorkflowRevisionValidationStatus;
  readonly validationErrorsJson: readonly WorkflowValidationError[];
  readonly validatedAt: string | null;
  readonly executorFingerprint: string | null;
}

export interface WorkflowRevisionRepository {
  create(
    revision: WorkflowRevisionRecord,
    idempotencyKey: string,
  ): Promise<WorkflowRevisionRecord>;
  findById(
    tenantId: Uuid,
    projectId: Uuid,
    shotId: Uuid,
    revisionId: Uuid,
  ): Promise<WorkflowRevisionRecord | null>;
  findByIdAny(
    tenantId: Uuid,
    revisionId: Uuid,
  ): Promise<WorkflowRevisionRecord | null>;
  listByShot(
    tenantId: Uuid,
    projectId: Uuid,
    shotId: Uuid,
  ): Promise<readonly WorkflowRevisionRecord[]>;
  updateValidation(
    tenantId: Uuid,
    projectId: Uuid,
    shotId: Uuid,
    revisionId: Uuid,
    update: WorkflowRevisionValidationUpdate,
  ): Promise<WorkflowRevisionRecord>;
}

export const RECOMMENDATION_SEVERITIES = [
  'info',
  'warning',
  'critical',
] as const;
export type RecommendationSeverity = (typeof RECOMMENDATION_SEVERITIES)[number];

export const RECOMMENDATION_ACTION_TYPES = [
  'retry_attempt',
  'open_workflow_revision',
  'wait_for_executor',
  'request_human_review',
  'no_action',
] as const;
export type RecommendationActionType =
  (typeof RECOMMENDATION_ACTION_TYPES)[number];

export const RECOMMENDATION_STATUSES = [
  'pending',
  'applied',
  'dismissed',
  'expired',
] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export interface RecommendationEvidenceReference {
  readonly type: string;
  readonly resourceId: string;
}

export interface OperationalRecommendationRecord {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly projectId: Uuid;
  readonly shotId?: Uuid;
  readonly attemptId?: Uuid;
  readonly triggerEventId: Uuid;
  readonly piAgentRunId?: Uuid;
  readonly severity: RecommendationSeverity;
  readonly recommendationCode: string;
  readonly title: string;
  readonly detail: string;
  readonly evidenceReferencesJson: readonly RecommendationEvidenceReference[];
  readonly proposedActionType: RecommendationActionType;
  readonly proposedResourceIdsJson: readonly string[];
  readonly status: RecommendationStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OperationalRecommendationRepository {
  create(recommendation: OperationalRecommendationRecord): Promise<void>;
  findByTriggerEventAndCode(
    tenantId: Uuid,
    triggerEventId: Uuid,
    recommendationCode: string,
  ): Promise<OperationalRecommendationRecord | null>;
  findById(
    tenantId: Uuid,
    projectId: Uuid,
    recommendationId: Uuid,
  ): Promise<OperationalRecommendationRecord | null>;
  listByProject(
    tenantId: Uuid,
    projectId: Uuid,
  ): Promise<readonly OperationalRecommendationRecord[]>;
  updateStatus(
    tenantId: Uuid,
    projectId: Uuid,
    recommendationId: Uuid,
    status: RecommendationStatus,
    expectedVersion: number,
    updatedAt: string,
  ): Promise<OperationalRecommendationRecord>;
}

export interface EventRepository {
  append(event: DomainEvent): Promise<void>;
  listByProject(projectId: Uuid): Promise<readonly DomainEvent[]>;
  listOrphans(tenantId: Uuid): Promise<readonly DomainEvent[]>;
}

export interface OutboxMessage {
  readonly id: Uuid;
  readonly event: DomainEvent;
  readonly availableAt: string;
  readonly attemptCount: number;
}

export interface OutboxRepository {
  enqueue(event: DomainEvent): Promise<void>;
  claimNext(now: string): Promise<OutboxMessage | null>;
  markDelivered(id: Uuid, deliveredAt: string): Promise<void>;
  markFailed(id: Uuid, errorMessage: string): Promise<void>;
}

export interface IdempotencyRecord {
  readonly tenantId: Uuid;
  readonly key: string;
  readonly operation: string;
  readonly requestHash: string;
  readonly responseStatus: number | null;
  readonly responseBody: unknown | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export type IdempotencyReservation =
  | { readonly kind: 'reserved' }
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly body: unknown;
    }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'conflict' };

export interface IdempotencyRepository {
  reserve(
    tenantId: Uuid,
    key: string,
    operation: string,
    requestHash: string,
    createdAt: string,
  ): Promise<IdempotencyReservation>;
  complete(
    tenantId: Uuid,
    key: string,
    status: number,
    body: unknown,
    completedAt: string,
  ): Promise<void>;
  release(tenantId: Uuid, key: string): Promise<void>;
}

export interface Repositories {
  readonly tenants: TenantRepository;
  readonly projects: ProjectRepository;
  readonly shots: ShotRepository;
  readonly attempts: AttemptRepository;
  readonly artifacts: ArtifactRepository;
  readonly evaluations: EvaluationRepository;
  readonly agentRuns: AgentRunRepository;
  readonly workflowVersions: WorkflowVersionRepository;
  readonly workflowDrafts: WorkflowDraftRepository;
  readonly workflowRevisions: WorkflowRevisionRepository;
  readonly recommendations: OperationalRecommendationRepository;
  readonly operationalRecommendations: OperationalRecommendationRepository;
  readonly events: EventRepository;
  readonly outbox: OutboxRepository;
  readonly idempotency: IdempotencyRepository;
}

export interface TransactionalStore {
  withTransaction<Result>(
    work: (repositories: Repositories) => Promise<Result>,
  ): Promise<Result>;
}

type DatabaseTimestamp = Date | string;

interface ProjectRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  title: string;
  brief: string;
  status: string;
  target_duration_seconds: string | number;
  budget_microusd: string | number | null;
  spent_microusd: string | number;
  auto_created: boolean;
  version: number;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
}

interface ShotRow extends QueryResultRow {
  id: string;
  project_id: string;
  ordinal: number;
  purpose: string;
  prompt: string;
  duration_seconds: string | number;
  mode: string;
  quality_tier: string;
  visual_description: string | null;
  camera_direction: string | null;
  audio_direction: string | null;
  dialogue: string | null;
  acceptance_criteria: unknown;
  required_asset_ids: unknown;
  status: string;
  accepted_attempt_id: string | null;
  pinned_attempt_id: string | null;
  implicit: boolean;
  version: number;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
}

interface AttemptRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  project_id: string;
  shot_id: string;
  idempotency_key: string;
  status: string;
  seed: string | number;
  steps: number;
  requested_width: number;
  requested_height: number;
  requested_duration_seconds: string | number;
  workflow_version_id: string | null;
  workflow_revision_id: string | null;
  workflow_hash: string;
  correlation_id: string;
  trace_id: string | null;
  scenario: string | null;
  comfy_prompt_id: string | null;
  lease_owner: string | null;
  lease_expires_at: DatabaseTimestamp | null;
  queued_at: DatabaseTimestamp;
  submitted_at: DatabaseTimestamp | null;
  finished_at: DatabaseTimestamp | null;
  compute_seconds: string | number | null;
  estimated_cost_microusd: string | number;
  failure_code: string | null;
  failure_message: string | null;
  source_attempt_id: string | null;
  artifact_id: string | null;
  review_decision: string | null;
  review_note: string | null;
  review_author: string | null;
  reviewed_at: DatabaseTimestamp | null;
  version: number;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
}

interface ArtifactRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  project_id: string;
  shot_id: string;
  attempt_id: string;
  object_key: string;
  mime_type: string;
  byte_size: string | number;
  sha256: string;
  created_at: DatabaseTimestamp;
}

interface EvaluationRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  project_id: string;
  shot_id: string;
  attempt_id: string;
  evaluator_version: string;
  status: string;
  checks: unknown;
  details: unknown;
  evaluated_at: DatabaseTimestamp;
}

interface AgentRunRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  project_id: string;
  run_id: string;
  session_id: string;
  objective: string;
  provider: string;
  model: string;
  status: string;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  provider_cost_microusd: string | number;
  started_at: DatabaseTimestamp;
  finished_at: DatabaseTimestamp | null;
  failure_code: string | null;
  version: number;
  updated_at: DatabaseTimestamp;
}

interface WorkflowVersionRow extends QueryResultRow {
  id: string;
  version: string;
  workflow_hash: string;
  workflow_json: unknown;
  created_at: DatabaseTimestamp;
}

interface WorkflowDraftRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  project_id: string;
  shot_id: string;
  base_revision_id: string | null;
  profile_id: string;
  profile_version: string;
  editor_graph_json: unknown;
  last_api_graph_json: unknown | null;
  author_type: string;
  author_id: string;
  version: number;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
}

interface WorkflowRevisionRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  project_id: string;
  shot_id: string;
  revision_number: number;
  parent_revision_id: string | null;
  profile_id: string;
  profile_version: string;
  source: string;
  frontend_version: string | null;
  frontend_commit: string | null;
  author_type: string;
  author_id: string;
  editor_graph_json: unknown;
  api_graph_json: unknown;
  execution_hash: string;
  execution_parameters_json: unknown;
  validation_status: string;
  validation_errors_json: unknown;
  validated_at: DatabaseTimestamp | null;
  executor_fingerprint: string | null;
  created_at: DatabaseTimestamp;
}

interface RecommendationRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  project_id: string;
  shot_id: string | null;
  attempt_id: string | null;
  trigger_event_id: string;
  pi_agent_run_id: string | null;
  severity: string;
  recommendation_code: string;
  title: string;
  detail: string;
  evidence_references_json: unknown;
  proposed_action_type: string;
  proposed_resource_ids_json: unknown;
  status: string;
  version: number;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
}

interface EventRow extends QueryResultRow {
  id: string;
  event_sequence?: number;
  type: string;
  version: number;
  occurred_at: DatabaseTimestamp;
  observed_at: DatabaseTimestamp;
  producer: string;
  tenant_id: string;
  project_id: string | null;
  shot_id: string | null;
  attempt_id: string | null;
  prompt_id: string | null;
  trace_id: string | null;
  payload: unknown;
}

interface OutboxRow extends QueryResultRow {
  outbox_id: string;
  event_id: string;
  available_at: DatabaseTimestamp;
  attempt_count: number;
  event_type: string;
  event_version: number;
  occurred_at: DatabaseTimestamp;
  observed_at: DatabaseTimestamp;
  producer: string;
  tenant_id: string;
  project_id: string | null;
  shot_id: string | null;
  attempt_id: string | null;
  prompt_id: string | null;
  trace_id: string | null;
  payload: unknown;
}

interface IdempotencyRow extends QueryResultRow {
  tenant_id: string;
  idempotency_key: string;
  operation: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown | null;
  created_at: DatabaseTimestamp;
  completed_at: DatabaseTimestamp | null;
}

function databaseNumber(value: string | number): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new RepositoryError(
      'DATABASE_ERROR',
      'Database returned a non-numeric value.',
    );
  }
  return numberValue;
}

function databaseTimestamp(value: DatabaseTimestamp): string {
  return toIsoUtc(value instanceof Date ? value : new Date(value));
}

function databaseJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new RepositoryError(
      'DATABASE_ERROR',
      'Database JSON value was not serializable.',
    );
  }
  return serialized;
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(databaseJson(value), 'utf8');
}

function databaseJsonRecord(
  value: unknown,
  message: string,
): Readonly<Record<string, unknown>> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RepositoryError('DATABASE_ERROR', message);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function databaseJsonArray(
  value: unknown,
  message: string,
): readonly unknown[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new RepositoryError('DATABASE_ERROR', message);
  }
  return parsed;
}

function mutationKey(value: string): string {
  if (!value.trim() || value.length > 200) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Workflow mutations require a bounded idempotency key.',
    );
  }
  return value;
}

function mutationRequestHash(value: unknown): string {
  return createHash('sha256')
    .update(canonicalizeJson(value), 'utf8')
    .digest('hex');
}

function assertBoundedText(
  value: unknown,
  name: string,
  maxLength: number,
): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      `${name} must be non-empty and bounded.`,
    );
  }
}

function assertGraphJson(
  value: unknown,
  name: string,
  maxBytes = 1_048_576,
): asserts value is Readonly<Record<string, unknown>> {
  databaseJsonRecord(value, `${name} must be a JSON object.`);
  if (jsonByteLength(value) > maxBytes) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      `${name} exceeds the stored JSON size limit.`,
    );
  }
}

function assertWorkflowDraftRecord(draft: WorkflowDraftRecord): void {
  assertUuid(draft.id);
  assertUuid(draft.tenantId);
  assertUuid(draft.projectId);
  assertUuid(draft.shotId);
  if (draft.baseRevisionId) assertUuid(draft.baseRevisionId);
  assertBoundedText(draft.profileId, 'Workflow draft profile ID', 128);
  assertBoundedText(draft.profileVersion, 'Workflow draft profile version', 64);
  assertGraphJson(draft.editorGraphJson, 'Workflow draft editor graph');
  if (draft.lastApiGraphJson !== undefined) {
    assertGraphJson(draft.lastApiGraphJson, 'Workflow draft API graph');
  }
  assertBoundedText(draft.authorType, 'Workflow draft author type', 64);
  assertBoundedText(draft.authorId, 'Workflow draft author ID', 200);
  if (!Number.isSafeInteger(draft.version) || draft.version < 1) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Workflow draft version must be positive.',
    );
  }
  toIsoUtc(new Date(draft.createdAt));
  toIsoUtc(new Date(draft.updatedAt));
}

function assertWorkflowValidationErrors(
  value: readonly WorkflowValidationError[],
): void {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some(
      (error) =>
        typeof error !== 'object' ||
        error === null ||
        typeof error.code !== 'string' ||
        !error.code.trim() ||
        error.code.length > 64 ||
        typeof error.message !== 'string' ||
        !error.message.trim() ||
        error.message.length > 500,
    )
  ) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Workflow validation errors must be a bounded array of safe codes and messages.',
    );
  }
}

function assertWorkflowRevisionRecord(revision: WorkflowRevisionRecord): void {
  assertUuid(revision.id);
  assertUuid(revision.tenantId);
  assertUuid(revision.projectId);
  assertUuid(revision.shotId);
  if (
    !Number.isSafeInteger(revision.revisionNumber) ||
    revision.revisionNumber < 1
  ) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Workflow revision number must be positive.',
    );
  }
  if (revision.parentRevisionId) assertUuid(revision.parentRevisionId);
  assertBoundedText(revision.profileId, 'Workflow revision profile ID', 128);
  assertBoundedText(
    revision.profileVersion,
    'Workflow revision profile version',
    64,
  );
  if (!WORKFLOW_REVISION_SOURCES.includes(revision.source)) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Workflow revision source is unknown.',
    );
  }
  if (revision.frontendVersion !== undefined) {
    assertBoundedText(
      revision.frontendVersion,
      'Workflow revision frontend version',
      128,
    );
  }
  if (revision.frontendCommit !== undefined) {
    assertBoundedText(
      revision.frontendCommit,
      'Workflow revision frontend commit',
      128,
    );
  }
  assertBoundedText(revision.authorType, 'Workflow revision author type', 64);
  assertBoundedText(revision.authorId, 'Workflow revision author ID', 200);
  assertGraphJson(revision.editorGraphJson, 'Workflow revision editor graph');
  assertGraphJson(revision.apiGraphJson, 'Workflow revision API graph');
  if (!/^[0-9a-f]{64}$/.test(revision.executionHash)) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Workflow revision execution hash must be lowercase SHA-256 hex.',
    );
  }
  const expectedHash = hashWorkflowExecutionEnvelope({
    profileId: revision.profileId,
    profileVersion: revision.profileVersion,
    apiGraph: revision.apiGraphJson,
    parameters: revision.executionParametersJson,
  });
  if (revision.executionHash !== expectedHash) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Workflow revision execution hash does not match its canonical envelope.',
    );
  }
  assertGraphJson(
    revision.executionParametersJson,
    'Workflow revision execution parameters',
    262_144,
  );
  if (
    !WORKFLOW_REVISION_VALIDATION_STATUSES.includes(revision.validationStatus)
  ) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Workflow revision validation status is unknown.',
    );
  }
  assertWorkflowValidationErrors(revision.validationErrorsJson);
  if (jsonByteLength(revision.validationErrorsJson) > 131_072) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Workflow revision validation errors exceed the stored JSON size limit.',
    );
  }
  if (revision.validatedAt !== undefined)
    toIsoUtc(new Date(revision.validatedAt));
  if (revision.executorFingerprint !== undefined) {
    assertBoundedText(
      revision.executorFingerprint,
      'Workflow revision executor fingerprint',
      256,
    );
  }
  toIsoUtc(new Date(revision.createdAt));
}

function assertWorkflowValidationUpdate(
  update: WorkflowRevisionValidationUpdate,
): void {
  if (
    !WORKFLOW_REVISION_VALIDATION_STATUSES.includes(update.validationStatus)
  ) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Workflow revision validation status is unknown.',
    );
  }
  assertWorkflowValidationErrors(update.validationErrorsJson);
  if (update.validatedAt !== null) toIsoUtc(new Date(update.validatedAt));
  if (update.executorFingerprint !== null) {
    assertBoundedText(
      update.executorFingerprint,
      'Workflow revision executor fingerprint',
      256,
    );
  }
}

function assertRecommendationRecord(
  recommendation: OperationalRecommendationRecord,
): void {
  assertUuid(recommendation.id);
  assertUuid(recommendation.tenantId);
  assertUuid(recommendation.projectId);
  if (recommendation.shotId) assertUuid(recommendation.shotId);
  if (recommendation.attemptId) assertUuid(recommendation.attemptId);
  assertUuid(recommendation.triggerEventId);
  if (recommendation.piAgentRunId) assertUuid(recommendation.piAgentRunId);
  if (!RECOMMENDATION_SEVERITIES.includes(recommendation.severity)) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Recommendation severity is unknown.',
    );
  }
  if (!/^[A-Z0-9][A-Z0-9_.-]{0,63}$/.test(recommendation.recommendationCode)) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Recommendation code is invalid.',
    );
  }
  assertBoundedText(recommendation.title, 'Recommendation title', 240);
  assertBoundedText(recommendation.detail, 'Recommendation detail', 2_000);
  if (
    !Array.isArray(recommendation.evidenceReferencesJson) ||
    recommendation.evidenceReferencesJson.length > 32 ||
    recommendation.evidenceReferencesJson.some(
      (reference) =>
        typeof reference.type !== 'string' ||
        !reference.type.trim() ||
        reference.type.length > 64 ||
        typeof reference.resourceId !== 'string' ||
        !reference.resourceId.trim() ||
        reference.resourceId.length > 200,
    )
  ) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Recommendation evidence references must be bounded and sanitized.',
    );
  }
  if (
    !RECOMMENDATION_ACTION_TYPES.includes(recommendation.proposedActionType)
  ) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Recommendation action is unknown.',
    );
  }
  if (
    !Array.isArray(recommendation.proposedResourceIdsJson) ||
    recommendation.proposedResourceIdsJson.length > 32 ||
    recommendation.proposedResourceIdsJson.some(
      (resourceId) =>
        typeof resourceId !== 'string' ||
        !resourceId.trim() ||
        resourceId.length > 200,
    )
  ) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Recommendation resource IDs must be bounded strings.',
    );
  }
  if (!RECOMMENDATION_STATUSES.includes(recommendation.status)) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Recommendation status is unknown.',
    );
  }
  if (
    !Number.isSafeInteger(recommendation.version) ||
    recommendation.version < 1
  ) {
    throw new RepositoryError(
      'INVALID_ARGUMENT',
      'Recommendation version must be positive.',
    );
  }
  toIsoUtc(new Date(recommendation.createdAt));
  toIsoUtc(new Date(recommendation.updatedAt));
}

function databaseStringArray(
  value: unknown,
  fallback: readonly string[] = [],
): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== 'string')
  ) {
    return [...fallback];
  }
  return [...parsed];
}

function agentRunStatus(value: string): AgentRunStatus {
  if (!AGENT_RUN_STATUSES.includes(value as AgentRunStatus)) {
    throw new RepositoryError(
      'DATABASE_ERROR',
      'Database returned an unknown agent-run status.',
    );
  }
  return value as AgentRunStatus;
}

function agentRunFailureCode(
  value: string | null,
): AgentRunFailureCode | undefined {
  if (value === null) {
    return undefined;
  }
  if (!AGENT_RUN_FAILURE_CODES.includes(value as AgentRunFailureCode)) {
    throw new RepositoryError(
      'DATABASE_ERROR',
      'Database returned an unknown agent-run failure code.',
    );
  }
  return value as AgentRunFailureCode;
}

function mapAgentRun(row: AgentRunRow): AgentRunRecord {
  const failureCode = agentRunFailureCode(row.failure_code);
  return {
    id: assertUuid(row.id),
    tenantId: assertUuid(row.tenant_id),
    projectId: assertUuid(row.project_id),
    runId: row.run_id,
    sessionId: row.session_id,
    objective: row.objective,
    provider: row.provider,
    model: row.model,
    status: agentRunStatus(row.status),
    toolCalls: row.tool_calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    providerCostMicrousd: databaseNumber(row.provider_cost_microusd),
    startedAt: databaseTimestamp(row.started_at),
    ...(row.finished_at
      ? { finishedAt: databaseTimestamp(row.finished_at) }
      : {}),
    ...(failureCode ? { failureCode } : {}),
    version: row.version,
    updatedAt: databaseTimestamp(row.updated_at),
  };
}

function mapProject(row: ProjectRow): VideoProject {
  const budgetMicrousd =
    row.budget_microusd === null
      ? null
      : assertMicrousd(databaseNumber(row.budget_microusd));
  return {
    id: assertUuid(row.id),
    tenantId: assertUuid(row.tenant_id),
    title: row.title,
    brief: row.brief,
    status: parseProjectStatus(row.status),
    targetDurationSeconds: databaseNumber(row.target_duration_seconds),
    budgetMicrousd,
    spentMicrousd: assertMicrousd(databaseNumber(row.spent_microusd)),
    ...(row.auto_created ? { autoCreated: true } : {}),
    version: row.version,
    createdAt: databaseTimestamp(row.created_at) as VideoProject['createdAt'],
    updatedAt: databaseTimestamp(row.updated_at) as VideoProject['updatedAt'],
  };
}

function shotOrdinal(value: number): Shot['ordinal'] {
  if (value === 1 || value === 2 || value === 3) {
    return value;
  }
  throw new DomainError('INVALID_SHOT', 'Stored shot ordinal is invalid.');
}

function mapShot(row: ShotRow): Shot {
  if (row.mode !== 't2v' || row.quality_tier !== 'preview') {
    throw new DomainError('INVALID_SHOT', 'Stored shot mode is invalid.');
  }
  const acceptedAttemptId = row.accepted_attempt_id
    ? assertUuid(row.accepted_attempt_id)
    : undefined;
  const pinnedAttemptId = row.pinned_attempt_id
    ? assertUuid(row.pinned_attempt_id)
    : undefined;
  const shot: Shot = {
    id: assertUuid(row.id),
    projectId: assertUuid(row.project_id),
    ordinal: shotOrdinal(row.ordinal),
    purpose: row.purpose,
    prompt: row.prompt,
    durationSeconds: databaseNumber(row.duration_seconds),
    mode: 't2v',
    qualityTier: 'preview',
    ...(row.visual_description !== null
      ? { visualDescription: row.visual_description }
      : {}),
    ...(row.camera_direction !== null
      ? { cameraDirection: row.camera_direction }
      : {}),
    ...(row.audio_direction !== null
      ? { audioDirection: row.audio_direction }
      : {}),
    ...(row.dialogue !== null ? { dialogue: row.dialogue } : {}),
    acceptanceCriteria: databaseStringArray(row.acceptance_criteria),
    requiredAssetIds: databaseStringArray(row.required_asset_ids),
    status: parseShotStatus(row.status),
    version: row.version,
    createdAt: databaseTimestamp(row.created_at) as Shot['createdAt'],
    updatedAt: databaseTimestamp(row.updated_at) as Shot['updatedAt'],
    ...(row.implicit ? { implicit: true } : {}),
  };
  return {
    ...shot,
    ...(acceptedAttemptId ? { acceptedAttemptId } : {}),
    ...(pinnedAttemptId ? { pinnedAttemptId } : {}),
  };
}

function optionalDatabaseTimestamp(
  value: DatabaseTimestamp | null,
): string | undefined {
  return value === null ? undefined : databaseTimestamp(value);
}

function optionalDatabaseNumber(
  value: string | number | null,
): number | undefined {
  return value === null ? undefined : databaseNumber(value);
}

function attemptFailureCode(
  value: string | null,
): AttemptFailureCode | undefined {
  if (value === null) {
    return undefined;
  }
  if (!ATTEMPT_FAILURE_CODES.includes(value as AttemptFailureCode)) {
    throw new RepositoryError(
      'DATABASE_ERROR',
      'Database returned an unknown attempt failure code.',
    );
  }
  return value as AttemptFailureCode;
}

function mapAttempt(row: AttemptRow): GenerationAttempt {
  const workflowVersionId = row.workflow_version_id
    ? assertUuid(row.workflow_version_id)
    : undefined;
  const workflowRevisionId = row.workflow_revision_id
    ? assertUuid(row.workflow_revision_id)
    : undefined;
  const traceId = row.trace_id ?? undefined;
  const scenario = row.scenario ?? undefined;
  const comfyPromptId = row.comfy_prompt_id ?? undefined;
  const leaseOwner = row.lease_owner ?? undefined;
  const leaseExpiresAt = optionalDatabaseTimestamp(row.lease_expires_at);
  const submittedAt = optionalDatabaseTimestamp(row.submitted_at);
  const finishedAt = optionalDatabaseTimestamp(row.finished_at);
  const computeSeconds = optionalDatabaseNumber(row.compute_seconds);
  const failureCode = attemptFailureCode(row.failure_code);
  const failureMessage = row.failure_message ?? undefined;
  const sourceAttemptId = row.source_attempt_id
    ? assertUuid(row.source_attempt_id)
    : undefined;
  const artifactId = row.artifact_id ? assertUuid(row.artifact_id) : undefined;
  const reviewDecision = row.review_decision ?? null;
  if (
    reviewDecision !== null &&
    reviewDecision !== 'accepted' &&
    reviewDecision !== 'rejected'
  ) {
    throw new RepositoryError(
      'DATABASE_ERROR',
      'Database returned an unknown attempt review decision.',
    );
  }
  const reviewedAt = optionalDatabaseTimestamp(row.reviewed_at ?? null);
  const attempt: GenerationAttempt = {
    id: assertUuid(row.id),
    tenantId: assertUuid(row.tenant_id),
    projectId: assertUuid(row.project_id),
    shotId: assertUuid(row.shot_id),
    idempotencyKey: row.idempotency_key,
    status: parseGenerationAttemptStatus(row.status),
    seed: databaseNumber(row.seed),
    steps: row.steps,
    requestedWidth: row.requested_width,
    requestedHeight: row.requested_height,
    requestedDurationSeconds: databaseNumber(row.requested_duration_seconds),
    workflowHash: row.workflow_hash,
    correlationId: row.correlation_id,
    estimatedCostMicrousd: assertMicrousd(
      databaseNumber(row.estimated_cost_microusd),
    ),
    version: row.version,
    queuedAt: databaseTimestamp(row.queued_at) as GenerationAttempt['queuedAt'],
    createdAt: databaseTimestamp(
      row.created_at,
    ) as GenerationAttempt['createdAt'],
    updatedAt: databaseTimestamp(
      row.updated_at,
    ) as GenerationAttempt['updatedAt'],
    ...(workflowVersionId ? { workflowVersionId } : {}),
    ...(workflowRevisionId ? { workflowRevisionId } : {}),
    ...(traceId ? { traceId } : {}),
    ...(scenario ? { scenario } : {}),
    ...(comfyPromptId ? { comfyPromptId } : {}),
    ...(leaseOwner ? { leaseOwner } : {}),
    ...(leaseExpiresAt
      ? {
          leaseExpiresAt: leaseExpiresAt as NonNullable<
            GenerationAttempt['leaseExpiresAt']
          >,
        }
      : {}),
    ...(submittedAt
      ? {
          submittedAt: submittedAt as NonNullable<
            GenerationAttempt['submittedAt']
          >,
        }
      : {}),
    ...(finishedAt
      ? {
          finishedAt: finishedAt as NonNullable<
            GenerationAttempt['finishedAt']
          >,
        }
      : {}),
    ...(computeSeconds !== undefined ? { computeSeconds } : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(failureMessage ? { failureMessage } : {}),
    ...(sourceAttemptId ? { sourceAttemptId } : {}),
    ...(artifactId ? { artifactId } : {}),
    ...(reviewDecision ? { reviewDecision } : {}),
    ...(row.review_note != null ? { reviewNote: row.review_note } : {}),
    ...(row.review_author != null ? { reviewAuthor: row.review_author } : {}),
    ...(reviewedAt
      ? {
          reviewedAt: reviewedAt as NonNullable<
            GenerationAttempt['reviewedAt']
          >,
        }
      : {}),
  };
  assertGenerationAttempt(attempt);
  return attempt;
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: assertUuid(row.id),
    tenantId: assertUuid(row.tenant_id),
    projectId: assertUuid(row.project_id),
    shotId: assertUuid(row.shot_id),
    attemptId: assertUuid(row.attempt_id),
    objectKey: row.object_key,
    mimeType: row.mime_type,
    byteSize: databaseNumber(row.byte_size),
    sha256: row.sha256,
    createdAt: databaseTimestamp(row.created_at) as ArtifactRecord['createdAt'],
  };
}

function mapEvaluation(row: EvaluationRow): EvaluationResult {
  if (row.status !== 'passed' && row.status !== 'failed') {
    throw new RepositoryError(
      'DATABASE_ERROR',
      'Database returned an unknown evaluation status.',
    );
  }
  return {
    id: assertUuid(row.id),
    tenantId: assertUuid(row.tenant_id),
    projectId: assertUuid(row.project_id),
    shotId: assertUuid(row.shot_id),
    attemptId: assertUuid(row.attempt_id),
    evaluatorVersion: row.evaluator_version,
    status: row.status,
    checks: (row.checks ?? {}) as EvaluationResult['checks'],
    details: (row.details ?? {}) as EvaluationResult['details'],
    evaluatedAt: databaseTimestamp(
      row.evaluated_at,
    ) as EvaluationResult['evaluatedAt'],
  };
}

function mapWorkflowVersion(row: WorkflowVersionRow): WorkflowVersionRecord {
  return {
    id: assertUuid(row.id),
    version: row.version,
    workflowHash: row.workflow_hash,
    workflowJson: (row.workflow_json ?? {}) as Readonly<
      Record<string, unknown>
    >,
    createdAt: databaseTimestamp(row.created_at),
  };
}

function mapWorkflowDraft(row: WorkflowDraftRow): WorkflowDraftRecord {
  const baseRevisionId = row.base_revision_id
    ? assertUuid(row.base_revision_id)
    : undefined;
  const lastApiGraphJson =
    row.last_api_graph_json === null
      ? undefined
      : databaseJsonRecord(
          row.last_api_graph_json,
          'Stored workflow draft API graph is invalid.',
        );
  return {
    id: assertUuid(row.id),
    tenantId: assertUuid(row.tenant_id),
    projectId: assertUuid(row.project_id),
    shotId: assertUuid(row.shot_id),
    ...(baseRevisionId ? { baseRevisionId } : {}),
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    editorGraphJson: databaseJsonRecord(
      row.editor_graph_json,
      'Stored workflow draft editor graph is invalid.',
    ),
    ...(lastApiGraphJson ? { lastApiGraphJson } : {}),
    authorType: row.author_type,
    authorId: row.author_id,
    version: row.version,
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  };
}

function mapWorkflowRevision(row: WorkflowRevisionRow): WorkflowRevisionRecord {
  const parentRevisionId = row.parent_revision_id
    ? assertUuid(row.parent_revision_id)
    : undefined;
  const validatedAt = row.validated_at
    ? databaseTimestamp(row.validated_at)
    : undefined;
  const executorFingerprint = row.executor_fingerprint ?? undefined;
  if (
    !WORKFLOW_REVISION_SOURCES.includes(row.source as WorkflowRevisionSource)
  ) {
    throw new RepositoryError(
      'DATABASE_ERROR',
      'Database returned an unknown workflow revision source.',
    );
  }
  if (
    !WORKFLOW_REVISION_VALIDATION_STATUSES.includes(
      row.validation_status as WorkflowRevisionValidationStatus,
    )
  ) {
    throw new RepositoryError(
      'DATABASE_ERROR',
      'Database returned an unknown workflow revision validation status.',
    );
  }
  const validationErrorsJson = databaseJsonArray(
    row.validation_errors_json,
    'Stored workflow validation errors are invalid.',
  ).map((value) => {
    const record =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
    if (
      !record ||
      typeof record.code !== 'string' ||
      typeof record.message !== 'string'
    ) {
      throw new RepositoryError(
        'DATABASE_ERROR',
        'Stored workflow validation error is invalid.',
      );
    }
    return { code: record.code, message: record.message };
  });
  return {
    id: assertUuid(row.id),
    tenantId: assertUuid(row.tenant_id),
    projectId: assertUuid(row.project_id),
    shotId: assertUuid(row.shot_id),
    revisionNumber: row.revision_number,
    ...(parentRevisionId ? { parentRevisionId } : {}),
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    source: row.source as WorkflowRevisionSource,
    ...(row.frontend_version ? { frontendVersion: row.frontend_version } : {}),
    ...(row.frontend_commit ? { frontendCommit: row.frontend_commit } : {}),
    authorType: row.author_type,
    authorId: row.author_id,
    editorGraphJson: databaseJsonRecord(
      row.editor_graph_json,
      'Stored workflow revision editor graph is invalid.',
    ),
    apiGraphJson: databaseJsonRecord(
      row.api_graph_json,
      'Stored workflow revision API graph is invalid.',
    ),
    executionHash: row.execution_hash,
    executionParametersJson: databaseJsonRecord(
      row.execution_parameters_json,
      'Stored workflow execution parameters are invalid.',
    ),
    validationStatus: row.validation_status as WorkflowRevisionValidationStatus,
    validationErrorsJson,
    ...(validatedAt ? { validatedAt } : {}),
    ...(executorFingerprint ? { executorFingerprint } : {}),
    createdAt: databaseTimestamp(row.created_at),
  };
}

function mapRecommendation(
  row: RecommendationRow,
): OperationalRecommendationRecord {
  const shotId = row.shot_id ? assertUuid(row.shot_id) : undefined;
  const attemptId = row.attempt_id ? assertUuid(row.attempt_id) : undefined;
  const piAgentRunId = row.pi_agent_run_id
    ? assertUuid(row.pi_agent_run_id)
    : undefined;
  if (
    !RECOMMENDATION_SEVERITIES.includes(row.severity as RecommendationSeverity)
  ) {
    throw new RepositoryError(
      'DATABASE_ERROR',
      'Database returned an unknown recommendation severity.',
    );
  }
  if (
    !RECOMMENDATION_ACTION_TYPES.includes(
      row.proposed_action_type as RecommendationActionType,
    )
  ) {
    throw new RepositoryError(
      'DATABASE_ERROR',
      'Database returned an unknown recommendation action.',
    );
  }
  if (!RECOMMENDATION_STATUSES.includes(row.status as RecommendationStatus)) {
    throw new RepositoryError(
      'DATABASE_ERROR',
      'Database returned an unknown recommendation status.',
    );
  }
  const evidenceReferencesJson = databaseJsonArray(
    row.evidence_references_json,
    'Stored recommendation evidence is invalid.',
  ).map((value) => {
    const record =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
    if (
      !record ||
      typeof record.type !== 'string' ||
      typeof record.resourceId !== 'string'
    ) {
      throw new RepositoryError(
        'DATABASE_ERROR',
        'Stored recommendation evidence reference is invalid.',
      );
    }
    return { type: record.type, resourceId: record.resourceId };
  });
  const proposedResourceIdsJson = databaseStringArray(
    row.proposed_resource_ids_json,
  );
  return {
    id: assertUuid(row.id),
    tenantId: assertUuid(row.tenant_id),
    projectId: assertUuid(row.project_id),
    ...(shotId ? { shotId } : {}),
    ...(attemptId ? { attemptId } : {}),
    triggerEventId: assertUuid(row.trigger_event_id),
    ...(piAgentRunId ? { piAgentRunId } : {}),
    severity: row.severity as RecommendationSeverity,
    recommendationCode: row.recommendation_code,
    title: row.title,
    detail: row.detail,
    evidenceReferencesJson,
    proposedActionType: row.proposed_action_type as RecommendationActionType,
    proposedResourceIdsJson,
    status: row.status as RecommendationStatus,
    version: row.version,
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  };
}

function mapEvent(row: EventRow): DomainEvent {
  const projectId = row.project_id ? assertUuid(row.project_id) : undefined;
  const shotId = row.shot_id ? assertUuid(row.shot_id) : undefined;
  const attemptId = row.attempt_id ? assertUuid(row.attempt_id) : undefined;
  const promptId = row.prompt_id ?? undefined;
  const traceId = row.trace_id ?? undefined;
  const event: DomainEvent = {
    id: assertUuid(row.id),
    ...(row.event_sequence !== undefined
      ? { eventSequence: Number(row.event_sequence) }
      : {}),
    type: parseDomainEventType(row.type),
    version: row.version,
    occurredAt: databaseTimestamp(row.occurred_at) as DomainEvent['occurredAt'],
    observedAt: databaseTimestamp(row.observed_at) as DomainEvent['observedAt'],
    producer: row.producer,
    tenantId: assertUuid(row.tenant_id),
    payload: (row.payload ?? {}) as Readonly<Record<string, unknown>>,
  };
  return {
    ...event,
    ...(projectId ? { projectId } : {}),
    ...(shotId ? { shotId } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(promptId ? { promptId } : {}),
    ...(traceId ? { traceId } : {}),
  };
}

function mapOutboxMessage(row: OutboxRow): OutboxMessage {
  const event = mapEvent({
    id: row.event_id,
    type: row.event_type,
    version: row.event_version,
    occurred_at: row.occurred_at,
    observed_at: row.observed_at,
    producer: row.producer,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    shot_id: row.shot_id,
    attempt_id: row.attempt_id,
    prompt_id: row.prompt_id,
    trace_id: row.trace_id,
    payload: row.payload,
  });
  return {
    id: assertUuid(row.outbox_id),
    event,
    availableAt: databaseTimestamp(row.available_at),
    attemptCount: row.attempt_count,
  };
}

async function assertProjectShotScope(
  executor: SqlExecutor,
  tenantId: Uuid,
  projectId: Uuid,
  shotId: Uuid,
): Promise<void> {
  const result = await executor.query<{
    tenant_id: string;
    project_id: string;
  }>(
    `SELECT project.tenant_id, shot.project_id
     FROM video_projects AS project
     JOIN shots AS shot ON shot.project_id = project.id
     WHERE project.tenant_id = $1 AND project.id = $2 AND shot.id = $3
     FOR UPDATE OF shot`,
    [tenantId, projectId, shotId],
  );
  if (result.rows.length === 0) {
    throw new RepositoryError(
      'SCOPE_VIOLATION',
      'The tenant, project, and shot scope does not match.',
    );
  }
}

interface ResourceMutationReservation {
  readonly key: string;
  readonly replayResourceId?: Uuid;
}

async function reserveResourceMutation(
  idempotency: IdempotencyRepository,
  tenantId: Uuid,
  key: string,
  operation: string,
  request: unknown,
  createdAt: string,
): Promise<ResourceMutationReservation> {
  const normalizedKey = mutationKey(key);
  const reservation = await idempotency.reserve(
    tenantId,
    normalizedKey,
    operation,
    mutationRequestHash(request),
    createdAt,
  );
  if (reservation.kind === 'reserved') {
    return { key: normalizedKey };
  }
  if (reservation.kind === 'replay') {
    const body = reservation.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as Record<string, unknown>).resourceId !== 'string'
    ) {
      throw new RepositoryError(
        'DATABASE_ERROR',
        'The stored workflow idempotency result is invalid.',
      );
    }
    return {
      key: normalizedKey,
      replayResourceId: assertUuid(
        (body as Record<string, unknown>).resourceId as string,
      ),
    };
  }
  throw new RepositoryError(
    'IDEMPOTENCY_CONFLICT',
    reservation.kind === 'conflict'
      ? 'The idempotency key was already used for a different workflow mutation.'
      : 'The workflow mutation is already in progress.',
  );
}

async function completeResourceMutation(
  idempotency: IdempotencyRepository,
  tenantId: Uuid,
  reservation: ResourceMutationReservation,
  resourceId: Uuid,
  completedAt: string,
): Promise<void> {
  if (reservation.replayResourceId) return;
  await idempotency.complete(
    tenantId,
    reservation.key,
    200,
    { resourceId },
    completedAt,
  );
}

async function releaseResourceMutation(
  idempotency: IdempotencyRepository,
  tenantId: Uuid,
  reservation: ResourceMutationReservation | undefined,
): Promise<void> {
  if (reservation && !reservation.replayResourceId) {
    // A failed PostgreSQL statement can abort the surrounding transaction.
    // Releasing the reservation is best effort in that case; rollback removes
    // it together with the failed mutation.
    try {
      await idempotency.release(tenantId, reservation.key);
    } catch {
      // Preserve the original mutation error.
    }
  }
}

class PostgresTenantRepository implements TenantRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async ensure(id: Uuid, name: string, createdAt: string): Promise<void> {
    await this.executor.query(
      `INSERT INTO tenants (id, name, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [id, name, createdAt],
    );
  }
}

class PostgresProjectRepository implements ProjectRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async create(project: VideoProject): Promise<void> {
    await this.executor.query(
      `INSERT INTO video_projects (
        id, tenant_id, title, brief, status, target_duration_seconds,
        budget_microusd, spent_microusd, auto_created, version, created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        project.id,
        project.tenantId,
        project.title,
        project.brief,
        project.status,
        project.targetDurationSeconds,
        project.budgetMicrousd,
        project.spentMicrousd,
        project.autoCreated ?? false,
        project.version,
        project.createdAt,
        project.updatedAt,
      ],
    );
  }

  async findById(
    tenantId: Uuid,
    projectId: Uuid,
  ): Promise<VideoProject | null> {
    const result = await this.executor.query<ProjectRow>(
      'SELECT * FROM video_projects WHERE tenant_id = $1 AND id = $2',
      [tenantId, projectId],
    );
    const row = result.rows[0];
    return row ? mapProject(row) : null;
  }

  async listByTenant(tenantId: Uuid): Promise<readonly VideoProject[]> {
    const result = await this.executor.query<ProjectRow>(
      'SELECT * FROM video_projects WHERE tenant_id = $1 ORDER BY created_at, id',
      [tenantId],
    );
    return result.rows.map(mapProject);
  }

  async update(
    project: VideoProject,
    expectedVersion: number,
  ): Promise<VideoProject> {
    const result = await this.executor.query<ProjectRow>(
      `UPDATE video_projects
       SET title = $1,
           brief = $2,
           status = $3,
           target_duration_seconds = $4,
           budget_microusd = $5,
           spent_microusd = $6,
           auto_created = $7,
           version = $8,
           updated_at = $9
       WHERE id = $10 AND tenant_id = $11 AND version = $12
       RETURNING *`,
      [
        project.title,
        project.brief,
        project.status,
        project.targetDurationSeconds,
        project.budgetMicrousd,
        project.spentMicrousd,
        project.autoCreated ?? false,
        project.version,
        project.updatedAt,
        project.id,
        project.tenantId,
        expectedVersion,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new RepositoryError(
        'OPTIMISTIC_CONFLICT',
        'The project was modified by another transaction.',
      );
    }
    return mapProject(row);
  }
}

class PostgresShotRepository implements ShotRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async createMany(shots: readonly Shot[]): Promise<void> {
    for (const shot of shots) {
      await this.executor.query(
        `INSERT INTO shots (
          id, project_id, ordinal, purpose, prompt,
          duration_seconds, mode, quality_tier, visual_description,
          camera_direction, audio_direction, dialogue, acceptance_criteria,
          required_asset_ids, status, accepted_attempt_id, pinned_attempt_id,
          version, created_at, updated_at, implicit
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, $20, $21)`,
        [
          shot.id,
          shot.projectId,
          shot.ordinal,
          shot.purpose,
          shot.prompt,
          shot.durationSeconds,
          shot.mode,
          shot.qualityTier,
          shot.visualDescription ?? null,
          shot.cameraDirection ?? null,
          shot.audioDirection ?? null,
          shot.dialogue ?? null,
          databaseJson(shot.acceptanceCriteria ?? []),
          databaseJson(shot.requiredAssetIds ?? []),
          shot.status,
          shot.acceptedAttemptId ?? null,
          shot.pinnedAttemptId ?? null,
          shot.version,
          shot.createdAt,
          shot.updatedAt,
          shot.implicit ?? false,
        ],
      );
    }
  }

  async listByProject(projectId: Uuid): Promise<readonly Shot[]> {
    const result = await this.executor.query<ShotRow>(
      'SELECT * FROM shots WHERE project_id = $1 ORDER BY ordinal',
      [projectId],
    );
    return result.rows.map(mapShot);
  }

  async findById(projectId: Uuid, shotId: Uuid): Promise<Shot | null> {
    const result = await this.executor.query<ShotRow>(
      'SELECT * FROM shots WHERE project_id = $1 AND id = $2',
      [projectId, shotId],
    );
    const row = result.rows[0];
    return row ? mapShot(row) : null;
  }

  async findByIdAny(shotId: Uuid): Promise<Shot | null> {
    const result = await this.executor.query<ShotRow>(
      'SELECT * FROM shots WHERE id = $1',
      [shotId],
    );
    const row = result.rows[0];
    return row ? mapShot(row) : null;
  }

  async update(shot: Shot, expectedVersion: number): Promise<Shot> {
    const result = await this.executor.query<ShotRow>(
      `UPDATE shots
       SET ordinal = $1,
           purpose = $2,
           prompt = $3,
           duration_seconds = $4,
           mode = $5,
           quality_tier = $6,
           status = $7,
           visual_description = $8,
           camera_direction = $9,
           audio_direction = $10,
           dialogue = $11,
           acceptance_criteria = $12::jsonb,
           required_asset_ids = $13::jsonb,
           accepted_attempt_id = $14,
           pinned_attempt_id = $15,
           implicit = $16,
           version = $17,
           updated_at = $18
       WHERE id = $19 AND project_id = $20 AND version = $21
       RETURNING *`,
      [
        shot.ordinal,
        shot.purpose,
        shot.prompt,
        shot.durationSeconds,
        shot.mode,
        shot.qualityTier,
        shot.status,
        shot.visualDescription ?? null,
        shot.cameraDirection ?? null,
        shot.audioDirection ?? null,
        shot.dialogue ?? null,
        databaseJson(shot.acceptanceCriteria ?? []),
        databaseJson(shot.requiredAssetIds ?? []),
        shot.acceptedAttemptId ?? null,
        shot.pinnedAttemptId ?? null,
        shot.implicit ?? false,
        shot.version,
        shot.updatedAt,
        shot.id,
        shot.projectId,
        expectedVersion,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new RepositoryError(
        'OPTIMISTIC_CONFLICT',
        'The shot was modified by another transaction.',
      );
    }
    return mapShot(row);
  }
}

class PostgresAttemptRepository implements AttemptRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async create(attempt: GenerationAttempt): Promise<void> {
    await this.executor.query(
      `INSERT INTO generation_attempts (
        id, tenant_id, project_id, shot_id, idempotency_key, status, seed, steps,
        requested_width, requested_height, requested_duration_seconds,
        workflow_version_id, workflow_hash, correlation_id, trace_id,
        scenario, comfy_prompt_id, lease_owner, lease_expires_at, queued_at, submitted_at,
        finished_at, compute_seconds, estimated_cost_microusd, failure_code,
        failure_message, source_attempt_id, artifact_id, version, created_at,
        updated_at, workflow_revision_id, review_decision, review_note,
        review_author, reviewed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29,
        $30, $31, $32, $33, $34, $35, $36
      )`,
      [
        attempt.id,
        attempt.tenantId,
        attempt.projectId,
        attempt.shotId,
        attempt.idempotencyKey,
        attempt.status,
        attempt.seed,
        attempt.steps,
        attempt.requestedWidth,
        attempt.requestedHeight,
        attempt.requestedDurationSeconds,
        attempt.workflowVersionId ?? null,
        attempt.workflowHash,
        attempt.correlationId,
        attempt.traceId ?? null,
        attempt.scenario ?? null,
        attempt.comfyPromptId ?? null,
        attempt.leaseOwner ?? null,
        attempt.leaseExpiresAt ?? null,
        attempt.queuedAt,
        attempt.submittedAt ?? null,
        attempt.finishedAt ?? null,
        attempt.computeSeconds ?? null,
        attempt.estimatedCostMicrousd,
        attempt.failureCode ?? null,
        attempt.failureMessage ?? null,
        attempt.sourceAttemptId ?? null,
        attempt.artifactId ?? null,
        attempt.version,
        attempt.createdAt,
        attempt.updatedAt,
        attempt.workflowRevisionId ?? null,
        attempt.reviewDecision ?? null,
        attempt.reviewNote ?? null,
        attempt.reviewAuthor ?? null,
        attempt.reviewedAt ?? null,
      ],
    );
  }

  async findById(
    tenantId: Uuid,
    attemptId: Uuid,
  ): Promise<GenerationAttempt | null> {
    const result = await this.executor.query<AttemptRow>(
      'SELECT * FROM generation_attempts WHERE tenant_id = $1 AND id = $2',
      [tenantId, attemptId],
    );
    const row = result.rows[0];
    return row ? mapAttempt(row) : null;
  }

  async findByPromptId(
    tenantId: Uuid,
    promptId: string,
  ): Promise<GenerationAttempt | null> {
    const result = await this.executor.query<AttemptRow>(
      'SELECT * FROM generation_attempts WHERE tenant_id = $1 AND comfy_prompt_id = $2',
      [tenantId, promptId],
    );
    const row = result.rows[0];
    return row ? mapAttempt(row) : null;
  }

  async findByCorrelationId(
    tenantId: Uuid,
    correlationId: string,
  ): Promise<GenerationAttempt | null> {
    const result = await this.executor.query<AttemptRow>(
      'SELECT * FROM generation_attempts WHERE tenant_id = $1 AND correlation_id = $2',
      [tenantId, correlationId],
    );
    const row = result.rows[0];
    return row ? mapAttempt(row) : null;
  }

  async listByShot(
    tenantId: Uuid,
    shotId: Uuid,
  ): Promise<readonly GenerationAttempt[]> {
    const result = await this.executor.query<AttemptRow>(
      `SELECT * FROM generation_attempts
       WHERE tenant_id = $1 AND shot_id = $2
       ORDER BY created_at, id`,
      [tenantId, shotId],
    );
    return result.rows.map(mapAttempt);
  }

  async listByProject(
    tenantId: Uuid,
    projectId: Uuid,
  ): Promise<readonly GenerationAttempt[]> {
    const result = await this.executor.query<AttemptRow>(
      `SELECT * FROM generation_attempts
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY created_at, id`,
      [tenantId, projectId],
    );
    return result.rows.map(mapAttempt);
  }

  async update(
    attempt: GenerationAttempt,
    expectedVersion: number,
  ): Promise<GenerationAttempt> {
    const result = await this.executor.query<AttemptRow>(
      `UPDATE generation_attempts
       SET status = $1,
           seed = $2,
           steps = $3,
           requested_width = $4,
           requested_height = $5,
           requested_duration_seconds = $6,
           workflow_version_id = $7,
           workflow_hash = $8,
           correlation_id = $9,
           trace_id = $10,
           scenario = $11,
           comfy_prompt_id = $12,
           lease_owner = $13,
           lease_expires_at = $14,
           submitted_at = $15,
           finished_at = $16,
           compute_seconds = $17,
           estimated_cost_microusd = $18,
           failure_code = $19,
           failure_message = $20,
           source_attempt_id = $21,
           artifact_id = $22,
           version = $23,
           updated_at = $24,
           workflow_revision_id = $25,
           review_decision = $26,
           review_note = $27,
           review_author = $28,
           reviewed_at = $29
       WHERE id = $30 AND tenant_id = $31 AND version = $32
       RETURNING *`,
      [
        attempt.status,
        attempt.seed,
        attempt.steps,
        attempt.requestedWidth,
        attempt.requestedHeight,
        attempt.requestedDurationSeconds,
        attempt.workflowVersionId ?? null,
        attempt.workflowHash,
        attempt.correlationId,
        attempt.traceId ?? null,
        attempt.scenario ?? null,
        attempt.comfyPromptId ?? null,
        attempt.leaseOwner ?? null,
        attempt.leaseExpiresAt ?? null,
        attempt.submittedAt ?? null,
        attempt.finishedAt ?? null,
        attempt.computeSeconds ?? null,
        attempt.estimatedCostMicrousd,
        attempt.failureCode ?? null,
        attempt.failureMessage ?? null,
        attempt.sourceAttemptId ?? null,
        attempt.artifactId ?? null,
        attempt.version,
        attempt.updatedAt,
        attempt.workflowRevisionId ?? null,
        attempt.reviewDecision ?? null,
        attempt.reviewNote ?? null,
        attempt.reviewAuthor ?? null,
        attempt.reviewedAt ?? null,
        attempt.id,
        attempt.tenantId,
        expectedVersion,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new RepositoryError(
        'OPTIMISTIC_CONFLICT',
        'The generation attempt was modified by another transaction.',
      );
    }
    return mapAttempt(row);
  }

  async review(
    tenantId: Uuid,
    attemptId: Uuid,
    decision: AttemptReviewDecision,
    note: string | null,
    author: string,
    reviewedAt: string,
  ): Promise<GenerationAttempt> {
    const result = await this.executor.query<AttemptRow>(
      `UPDATE generation_attempts
       SET review_decision = $1,
           review_note = $2,
           review_author = $3,
           reviewed_at = $4,
           version = version + 1,
           updated_at = $5
       WHERE tenant_id = $6 AND id = $7
       RETURNING *`,
      [decision, note, author, reviewedAt, reviewedAt, tenantId, attemptId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new RepositoryError(
        'NOT_FOUND',
        'The generation attempt was not found in the requested tenant.',
      );
    }
    return mapAttempt(row);
  }

  async claimNext(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<GenerationAttempt | null> {
    const result = await this.executor.query<AttemptRow>(
      `WITH candidate AS (
        SELECT id
        FROM generation_attempts
        WHERE status = 'queued'
          AND (lease_expires_at IS NULL OR lease_expires_at < $2)
          AND NOT EXISTS (
            SELECT 1
            FROM generation_attempts active
            WHERE active.lease_owner = $1
              AND active.lease_expires_at IS NOT NULL
              AND active.lease_expires_at >= $2
              AND active.status IN (
                'claimed', 'submitting', 'submitted', 'running',
                'generated', 'evaluating'
              )
          )
        ORDER BY queued_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE generation_attempts attempt
      SET status = 'claimed',
          lease_owner = $1,
          lease_expires_at = $3,
          version = attempt.version + 1,
          updated_at = $2
      FROM candidate
      WHERE attempt.id = candidate.id
      RETURNING attempt.*`,
      [workerId, now, leaseExpiresAt],
    );
    const row = result.rows[0];
    return row ? mapAttempt(row) : null;
  }

  async claimForRecovery(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<GenerationAttempt | null> {
    const result = await this.executor.query<AttemptRow>(
      `WITH candidate AS (
        SELECT id
        FROM generation_attempts
        WHERE status IN ('submitting', 'submitted', 'running', 'generated', 'evaluating')
          AND (lease_expires_at IS NULL OR lease_expires_at < $2)
          AND NOT EXISTS (
            SELECT 1
            FROM generation_attempts active
            WHERE active.lease_owner = $1
              AND active.lease_expires_at IS NOT NULL
              AND active.lease_expires_at >= $2
              AND active.status IN (
                'claimed', 'submitting', 'submitted', 'running',
                'generated', 'evaluating'
              )
          )
        ORDER BY updated_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE generation_attempts attempt
      SET lease_owner = $1,
          lease_expires_at = $3,
          version = attempt.version + 1,
          updated_at = $2
      FROM candidate
      WHERE attempt.id = candidate.id
      RETURNING attempt.*`,
      [workerId, now, leaseExpiresAt],
    );
    const row = result.rows[0];
    return row ? mapAttempt(row) : null;
  }

  async heartbeat(
    attemptId: Uuid,
    workerId: string,
    leaseExpiresAt: string,
  ): Promise<GenerationAttempt | null> {
    const result = await this.executor.query<AttemptRow>(
      `UPDATE generation_attempts
       SET lease_expires_at = $1,
           version = version + 1,
           updated_at = now()
       WHERE id = $2 AND lease_owner = $3
         AND status IN ('claimed', 'submitting', 'submitted', 'running', 'generated', 'evaluating')
       RETURNING *`,
      [leaseExpiresAt, attemptId, workerId],
    );
    const row = result.rows[0];
    return row ? mapAttempt(row) : null;
  }

  async release(
    attemptId: Uuid,
    workerId: string,
    updatedAt: string,
  ): Promise<GenerationAttempt | null> {
    const result = await this.executor.query<AttemptRow>(
      `UPDATE generation_attempts
       SET status = CASE
         WHEN status = 'claimed' THEN 'queued'
         ELSE status
       END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           version = version + 1,
           updated_at = $3
       WHERE id = $1 AND lease_owner = $2
         AND status IN ('claimed', 'submitting', 'submitted', 'running', 'generated', 'evaluating')
       RETURNING *`,
      [attemptId, workerId, updatedAt],
    );
    const row = result.rows[0];
    return row ? mapAttempt(row) : null;
  }

  async recoverStale(now: string): Promise<readonly GenerationAttempt[]> {
    const result = await this.executor.query<AttemptRow>(
      `UPDATE generation_attempts
       SET status = 'queued',
           lease_owner = NULL,
           lease_expires_at = NULL,
           version = version + 1,
           updated_at = $1
       WHERE lease_expires_at IS NOT NULL
         AND lease_expires_at < $1
         AND status = 'claimed'
       RETURNING *`,
      [now],
    );
    return result.rows.map(mapAttempt);
  }
}

class PostgresArtifactRepository implements ArtifactRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async create(artifact: ArtifactRecord): Promise<void> {
    await this.executor.query(
      `INSERT INTO artifacts (
        id, tenant_id, project_id, shot_id, attempt_id, object_key, mime_type,
        byte_size, sha256, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        artifact.id,
        artifact.tenantId,
        artifact.projectId,
        artifact.shotId,
        artifact.attemptId,
        artifact.objectKey,
        artifact.mimeType,
        artifact.byteSize,
        artifact.sha256,
        artifact.createdAt,
      ],
    );
  }

  async findById(
    tenantId: Uuid,
    artifactId: Uuid,
  ): Promise<ArtifactRecord | null> {
    const result = await this.executor.query<ArtifactRow>(
      'SELECT * FROM artifacts WHERE tenant_id = $1 AND id = $2',
      [tenantId, artifactId],
    );
    const row = result.rows[0];
    return row ? mapArtifact(row) : null;
  }

  async findByAttempt(
    tenantId: Uuid,
    attemptId: Uuid,
  ): Promise<ArtifactRecord | null> {
    const result = await this.executor.query<ArtifactRow>(
      `SELECT * FROM artifacts
       WHERE tenant_id = $1 AND attempt_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [tenantId, attemptId],
    );
    const row = result.rows[0];
    return row ? mapArtifact(row) : null;
  }
}

class PostgresEvaluationRepository implements EvaluationRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async create(result: EvaluationResult): Promise<void> {
    await this.executor.query(
      `INSERT INTO evaluation_results (
        id, tenant_id, project_id, shot_id, attempt_id, evaluator_version,
        status, checks, details, evaluated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [
        result.id,
        result.tenantId,
        result.projectId,
        result.shotId,
        result.attemptId,
        result.evaluatorVersion,
        result.status,
        databaseJson(result.checks),
        databaseJson(result.details),
        result.evaluatedAt,
      ],
    );
  }

  async findByAttempt(
    tenantId: Uuid,
    attemptId: Uuid,
  ): Promise<EvaluationResult | null> {
    const result = await this.executor.query<EvaluationRow>(
      'SELECT * FROM evaluation_results WHERE tenant_id = $1 AND attempt_id = $2',
      [tenantId, attemptId],
    );
    const row = result.rows[0];
    return row ? mapEvaluation(row) : null;
  }
}

class PostgresAgentRunRepository implements AgentRunRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async create(run: AgentRunRecord): Promise<void> {
    await this.executor.query(
      `INSERT INTO agent_runs (
        id, tenant_id, project_id, run_id, session_id, objective, provider,
        model, status, tool_calls, input_tokens, output_tokens, total_tokens,
        cache_read_tokens, cache_write_tokens, provider_cost_microusd,
        started_at, finished_at, failure_code, version, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        run.id,
        run.tenantId,
        run.projectId,
        run.runId,
        run.sessionId,
        run.objective,
        run.provider,
        run.model,
        run.status,
        run.toolCalls,
        run.inputTokens,
        run.outputTokens,
        run.totalTokens,
        run.cacheReadTokens,
        run.cacheWriteTokens,
        run.providerCostMicrousd,
        run.startedAt,
        run.finishedAt ?? null,
        run.failureCode ?? null,
        run.version,
        run.updatedAt,
      ],
    );
  }

  async findById(tenantId: Uuid, runId: Uuid): Promise<AgentRunRecord | null> {
    const result = await this.executor.query<AgentRunRow>(
      'SELECT * FROM agent_runs WHERE tenant_id = $1 AND id = $2',
      [tenantId, runId],
    );
    const row = result.rows[0];
    return row ? mapAgentRun(row) : null;
  }

  async listByProject(
    tenantId: Uuid,
    projectId: Uuid,
  ): Promise<readonly AgentRunRecord[]> {
    const result = await this.executor.query<AgentRunRow>(
      `SELECT * FROM agent_runs
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY started_at, id`,
      [tenantId, projectId],
    );
    return result.rows.map(mapAgentRun);
  }

  async update(
    run: AgentRunRecord,
    expectedVersion: number,
  ): Promise<AgentRunRecord> {
    const result = await this.executor.query<AgentRunRow>(
      `UPDATE agent_runs
       SET status = $1,
           tool_calls = $2,
           input_tokens = $3,
           output_tokens = $4,
           total_tokens = $5,
           cache_read_tokens = $6,
           cache_write_tokens = $7,
           provider_cost_microusd = $8,
           finished_at = $9,
           failure_code = $10,
           version = $11,
           updated_at = $12
       WHERE id = $13 AND tenant_id = $14 AND version = $15
       RETURNING *`,
      [
        run.status,
        run.toolCalls,
        run.inputTokens,
        run.outputTokens,
        run.totalTokens,
        run.cacheReadTokens,
        run.cacheWriteTokens,
        run.providerCostMicrousd,
        run.finishedAt ?? null,
        run.failureCode ?? null,
        run.version,
        run.updatedAt,
        run.id,
        run.tenantId,
        expectedVersion,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new RepositoryError(
        'OPTIMISTIC_CONFLICT',
        'The agent run was modified by another transaction.',
      );
    }
    return mapAgentRun(row);
  }
}

class PostgresWorkflowVersionRepository implements WorkflowVersionRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async findByHash(
    workflowHash: string,
  ): Promise<WorkflowVersionRecord | null> {
    const result = await this.executor.query<WorkflowVersionRow>(
      `SELECT * FROM workflow_versions
       WHERE workflow_hash = $1
       ORDER BY created_at, id
       LIMIT 1`,
      [workflowHash],
    );
    const row = result.rows[0];
    return row ? mapWorkflowVersion(row) : null;
  }

  async create(version: WorkflowVersionRecord): Promise<void> {
    await this.executor.query(
      `INSERT INTO workflow_versions (
        id, version, workflow_hash, workflow_json, created_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        version.id,
        version.version,
        version.workflowHash,
        databaseJson(version.workflowJson),
        version.createdAt,
      ],
    );
  }
}

class PostgresWorkflowDraftRepository implements WorkflowDraftRepository {
  private readonly executor: SqlExecutor;
  private readonly idempotency: IdempotencyRepository;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
    this.idempotency = new PostgresIdempotencyRepository(executor);
  }

  async findByShot(
    tenantId: Uuid,
    projectId: Uuid,
    shotId: Uuid,
  ): Promise<WorkflowDraftRecord | null> {
    const result = await this.executor.query<WorkflowDraftRow>(
      `SELECT * FROM workflow_drafts
       WHERE tenant_id = $1 AND project_id = $2 AND shot_id = $3`,
      [tenantId, projectId, shotId],
    );
    const row = result.rows[0];
    return row ? mapWorkflowDraft(row) : null;
  }

  async create(
    draft: WorkflowDraftRecord,
    idempotencyKey: string,
  ): Promise<WorkflowDraftRecord> {
    assertWorkflowDraftRecord(draft);
    await assertProjectShotScope(
      this.executor,
      draft.tenantId,
      draft.projectId,
      draft.shotId,
    );
    const reservation = await reserveResourceMutation(
      this.idempotency,
      draft.tenantId,
      idempotencyKey,
      'workflow-draft.create',
      draft,
      draft.createdAt,
    );
    if (reservation.replayResourceId) {
      const existing = await this.findByShot(
        draft.tenantId,
        draft.projectId,
        draft.shotId,
      );
      if (!existing || existing.id !== reservation.replayResourceId) {
        throw new RepositoryError(
          'DATABASE_ERROR',
          'The stored workflow draft idempotency result is missing.',
        );
      }
      return existing;
    }
    try {
      const result = await this.executor.query<WorkflowDraftRow>(
        `INSERT INTO workflow_drafts (
          id, tenant_id, project_id, shot_id, base_revision_id, profile_id,
          profile_version, editor_graph_json, last_api_graph_json, author_type,
          author_id, version, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10,
          $11, $12, $13, $14)
        RETURNING *`,
        [
          draft.id,
          draft.tenantId,
          draft.projectId,
          draft.shotId,
          draft.baseRevisionId ?? null,
          draft.profileId,
          draft.profileVersion,
          databaseJson(draft.editorGraphJson),
          draft.lastApiGraphJson === undefined
            ? null
            : databaseJson(draft.lastApiGraphJson),
          draft.authorType,
          draft.authorId,
          draft.version,
          draft.createdAt,
          draft.updatedAt,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new RepositoryError(
          'DATABASE_ERROR',
          'The workflow draft was not returned after creation.',
        );
      }
      const created = mapWorkflowDraft(row);
      await completeResourceMutation(
        this.idempotency,
        draft.tenantId,
        reservation,
        created.id,
        draft.updatedAt,
      );
      return created;
    } catch (error) {
      await releaseResourceMutation(
        this.idempotency,
        draft.tenantId,
        reservation,
      );
      throw error;
    }
  }

  async update(
    draft: WorkflowDraftRecord,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<WorkflowDraftRecord> {
    assertWorkflowDraftRecord(draft);
    await assertProjectShotScope(
      this.executor,
      draft.tenantId,
      draft.projectId,
      draft.shotId,
    );
    const reservation = await reserveResourceMutation(
      this.idempotency,
      draft.tenantId,
      idempotencyKey,
      'workflow-draft.update',
      { draft, expectedVersion },
      draft.updatedAt,
    );
    if (reservation.replayResourceId) {
      const existing = await this.findByShot(
        draft.tenantId,
        draft.projectId,
        draft.shotId,
      );
      if (!existing || existing.id !== reservation.replayResourceId) {
        throw new RepositoryError(
          'DATABASE_ERROR',
          'The stored workflow draft idempotency result is missing.',
        );
      }
      return existing;
    }
    try {
      const result = await this.executor.query<WorkflowDraftRow>(
        `UPDATE workflow_drafts
         SET base_revision_id = $1,
             profile_id = $2,
             profile_version = $3,
             editor_graph_json = $4::jsonb,
             last_api_graph_json = $5::jsonb,
             author_type = $6,
             author_id = $7,
             version = $8,
             updated_at = $9
         WHERE id = $10 AND tenant_id = $11 AND project_id = $12
           AND shot_id = $13 AND version = $14
         RETURNING *`,
        [
          draft.baseRevisionId ?? null,
          draft.profileId,
          draft.profileVersion,
          databaseJson(draft.editorGraphJson),
          draft.lastApiGraphJson === undefined
            ? null
            : databaseJson(draft.lastApiGraphJson),
          draft.authorType,
          draft.authorId,
          draft.version,
          draft.updatedAt,
          draft.id,
          draft.tenantId,
          draft.projectId,
          draft.shotId,
          expectedVersion,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new RepositoryError(
          'OPTIMISTIC_CONFLICT',
          'The workflow draft was modified by another transaction.',
        );
      }
      const updated = mapWorkflowDraft(row);
      await completeResourceMutation(
        this.idempotency,
        draft.tenantId,
        reservation,
        updated.id,
        draft.updatedAt,
      );
      return updated;
    } catch (error) {
      await releaseResourceMutation(
        this.idempotency,
        draft.tenantId,
        reservation,
      );
      throw error;
    }
  }
}

class PostgresWorkflowRevisionRepository implements WorkflowRevisionRepository {
  private readonly executor: SqlExecutor;
  private readonly idempotency: IdempotencyRepository;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
    this.idempotency = new PostgresIdempotencyRepository(executor);
  }

  async create(
    revision: WorkflowRevisionRecord,
    idempotencyKey: string,
  ): Promise<WorkflowRevisionRecord> {
    assertWorkflowRevisionRecord(revision);
    await assertProjectShotScope(
      this.executor,
      revision.tenantId,
      revision.projectId,
      revision.shotId,
    );
    const { revisionNumber: _revisionNumber, ...request } = revision;
    const reservation = await reserveResourceMutation(
      this.idempotency,
      revision.tenantId,
      idempotencyKey,
      'workflow-revision.create',
      request,
      revision.createdAt,
    );
    if (reservation.replayResourceId) {
      const existing = await this.findById(
        revision.tenantId,
        revision.projectId,
        revision.shotId,
        reservation.replayResourceId,
      );
      if (!existing) {
        throw new RepositoryError(
          'DATABASE_ERROR',
          'The stored workflow revision idempotency result is missing.',
        );
      }
      return existing;
    }
    try {
      // Serialize revision-number allocation per shot. The unique constraint
      // remains a final guard, while the advisory lock prevents concurrent
      // transactions from selecting the same MAX(revision_number) + 1.
      await this.executor.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended($1, 0)
         )`,
        [
          `workflow-revision:${revision.tenantId}:${revision.projectId}:${revision.shotId}`,
        ],
      );
      const nextNumber = await this.executor.query<{ revision_number: number }>(
        `SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number
         FROM workflow_revisions
         WHERE tenant_id = $1 AND project_id = $2 AND shot_id = $3`,
        [revision.tenantId, revision.projectId, revision.shotId],
      );
      const revisionNumber = nextNumber.rows[0]?.revision_number;
      if (!revisionNumber) {
        throw new RepositoryError(
          'DATABASE_ERROR',
          'The next workflow revision number could not be allocated.',
        );
      }
      const result = await this.executor.query<WorkflowRevisionRow>(
        `INSERT INTO workflow_revisions (
          id, tenant_id, project_id, shot_id, revision_number,
          parent_revision_id, profile_id, profile_version, source, author_type,
          author_id, editor_graph_json, api_graph_json, execution_hash,
          execution_parameters_json, validation_status, validation_errors_json,
          validated_at, executor_fingerprint, frontend_version, frontend_commit,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
          $13::jsonb, $14, $15::jsonb, $16, $17::jsonb, $18, $19, $20, $21,
          $22)
        RETURNING *`,
        [
          revision.id,
          revision.tenantId,
          revision.projectId,
          revision.shotId,
          revisionNumber,
          revision.parentRevisionId ?? null,
          revision.profileId,
          revision.profileVersion,
          revision.source,
          revision.authorType,
          revision.authorId,
          databaseJson(revision.editorGraphJson),
          databaseJson(revision.apiGraphJson),
          revision.executionHash,
          databaseJson(revision.executionParametersJson),
          revision.validationStatus,
          databaseJson(revision.validationErrorsJson),
          revision.validatedAt ?? null,
          revision.executorFingerprint ?? null,
          revision.frontendVersion ?? null,
          revision.frontendCommit ?? null,
          revision.createdAt,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new RepositoryError(
          'DATABASE_ERROR',
          'The workflow revision was not returned after creation.',
        );
      }
      const created = mapWorkflowRevision(row);
      await completeResourceMutation(
        this.idempotency,
        revision.tenantId,
        reservation,
        created.id,
        revision.createdAt,
      );
      return created;
    } catch (error) {
      await releaseResourceMutation(
        this.idempotency,
        revision.tenantId,
        reservation,
      );
      throw error;
    }
  }

  async findById(
    tenantId: Uuid,
    projectId: Uuid,
    shotId: Uuid,
    revisionId: Uuid,
  ): Promise<WorkflowRevisionRecord | null> {
    const result = await this.executor.query<WorkflowRevisionRow>(
      `SELECT * FROM workflow_revisions
       WHERE tenant_id = $1 AND project_id = $2 AND shot_id = $3 AND id = $4`,
      [tenantId, projectId, shotId, revisionId],
    );
    const row = result.rows[0];
    return row ? mapWorkflowRevision(row) : null;
  }

  async findByIdAny(
    tenantId: Uuid,
    revisionId: Uuid,
  ): Promise<WorkflowRevisionRecord | null> {
    const result = await this.executor.query<WorkflowRevisionRow>(
      `SELECT * FROM workflow_revisions
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, revisionId],
    );
    const row = result.rows[0];
    return row ? mapWorkflowRevision(row) : null;
  }

  async listByShot(
    tenantId: Uuid,
    projectId: Uuid,
    shotId: Uuid,
  ): Promise<readonly WorkflowRevisionRecord[]> {
    const result = await this.executor.query<WorkflowRevisionRow>(
      `SELECT * FROM workflow_revisions
       WHERE tenant_id = $1 AND project_id = $2 AND shot_id = $3
       ORDER BY revision_number`,
      [tenantId, projectId, shotId],
    );
    return result.rows.map(mapWorkflowRevision);
  }

  async updateValidation(
    tenantId: Uuid,
    projectId: Uuid,
    shotId: Uuid,
    revisionId: Uuid,
    update: WorkflowRevisionValidationUpdate,
  ): Promise<WorkflowRevisionRecord> {
    assertWorkflowValidationUpdate(update);
    const result = await this.executor.query<WorkflowRevisionRow>(
      `UPDATE workflow_revisions
       SET validation_status = $1,
           validation_errors_json = $2::jsonb,
           validated_at = $3,
           executor_fingerprint = $4
       WHERE tenant_id = $5 AND project_id = $6 AND shot_id = $7 AND id = $8
       RETURNING *`,
      [
        update.validationStatus,
        databaseJson(update.validationErrorsJson),
        update.validatedAt,
        update.executorFingerprint,
        tenantId,
        projectId,
        shotId,
        revisionId,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new RepositoryError(
        'NOT_FOUND',
        'The workflow revision was not found in the requested scope.',
      );
    }
    return mapWorkflowRevision(row);
  }
}

class PostgresOperationalRecommendationRepository
  implements OperationalRecommendationRepository
{
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async create(recommendation: OperationalRecommendationRecord): Promise<void> {
    assertRecommendationRecord(recommendation);
    const project = await this.executor.query<{ id: string }>(
      'SELECT id FROM video_projects WHERE id = $1 AND tenant_id = $2',
      [recommendation.projectId, recommendation.tenantId],
    );
    if (project.rows.length === 0) {
      throw new RepositoryError(
        'SCOPE_VIOLATION',
        'The recommendation project is outside its tenant scope.',
      );
    }
    if (recommendation.shotId) {
      await assertProjectShotScope(
        this.executor,
        recommendation.tenantId,
        recommendation.projectId,
        recommendation.shotId,
      );
    }
    await this.executor.query(
      `INSERT INTO operational_recommendations (
        id, tenant_id, project_id, shot_id, attempt_id, trigger_event_id,
        pi_agent_run_id, severity, recommendation_code, title, detail,
        evidence_references_json, proposed_action_type,
        proposed_resource_ids_json, status, version, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
        $13, $14::jsonb, $15, $16, $17, $18)`,
      [
        recommendation.id,
        recommendation.tenantId,
        recommendation.projectId,
        recommendation.shotId ?? null,
        recommendation.attemptId ?? null,
        recommendation.triggerEventId,
        recommendation.piAgentRunId ?? null,
        recommendation.severity,
        recommendation.recommendationCode,
        recommendation.title,
        recommendation.detail,
        databaseJson(recommendation.evidenceReferencesJson),
        recommendation.proposedActionType,
        databaseJson(recommendation.proposedResourceIdsJson),
        recommendation.status,
        recommendation.version,
        recommendation.createdAt,
        recommendation.updatedAt,
      ],
    );
  }

  async findByTriggerEventAndCode(
    tenantId: Uuid,
    triggerEventId: Uuid,
    recommendationCode: string,
  ): Promise<OperationalRecommendationRecord | null> {
    const result = await this.executor.query<RecommendationRow>(
      `SELECT * FROM operational_recommendations
       WHERE tenant_id = $1
         AND trigger_event_id = $2
         AND recommendation_code = $3`,
      [tenantId, triggerEventId, recommendationCode],
    );
    const row = result.rows[0];
    return row ? mapRecommendation(row) : null;
  }

  async findById(
    tenantId: Uuid,
    projectId: Uuid,
    recommendationId: Uuid,
  ): Promise<OperationalRecommendationRecord | null> {
    const result = await this.executor.query<RecommendationRow>(
      `SELECT * FROM operational_recommendations
       WHERE tenant_id = $1 AND project_id = $2 AND id = $3`,
      [tenantId, projectId, recommendationId],
    );
    const row = result.rows[0];
    return row ? mapRecommendation(row) : null;
  }

  async listByProject(
    tenantId: Uuid,
    projectId: Uuid,
  ): Promise<readonly OperationalRecommendationRecord[]> {
    const result = await this.executor.query<RecommendationRow>(
      `SELECT * FROM operational_recommendations
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY created_at, id`,
      [tenantId, projectId],
    );
    return result.rows.map(mapRecommendation);
  }

  async updateStatus(
    tenantId: Uuid,
    projectId: Uuid,
    recommendationId: Uuid,
    status: RecommendationStatus,
    expectedVersion: number,
    updatedAt: string,
  ): Promise<OperationalRecommendationRecord> {
    if (!RECOMMENDATION_STATUSES.includes(status)) {
      throw new RepositoryError(
        'INVALID_ARGUMENT',
        'Recommendation status is unknown.',
      );
    }
    const result = await this.executor.query<RecommendationRow>(
      `UPDATE operational_recommendations
       SET status = $1, version = version + 1, updated_at = $2
       WHERE tenant_id = $3 AND project_id = $4 AND id = $5
         AND version = $6 AND status = 'pending'
       RETURNING *`,
      [
        status,
        updatedAt,
        tenantId,
        projectId,
        recommendationId,
        expectedVersion,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new RepositoryError(
        'OPTIMISTIC_CONFLICT',
        'The recommendation was modified or is no longer pending.',
      );
    }
    return mapRecommendation(row);
  }
}

class PostgresEventRepository implements EventRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async append(event: DomainEvent): Promise<void> {
    await this.executor.query(
      `INSERT INTO domain_events (
        id, type, version, occurred_at, observed_at, producer, tenant_id,
        project_id, shot_id, attempt_id, prompt_id, trace_id, payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
      [
        event.id,
        event.type,
        event.version,
        event.occurredAt,
        event.observedAt,
        event.producer,
        event.tenantId,
        event.projectId ?? null,
        event.shotId ?? null,
        event.attemptId ?? null,
        event.promptId ?? null,
        event.traceId ?? null,
        databaseJson(event.payload),
      ],
    );
  }

  async listByProject(projectId: Uuid): Promise<readonly DomainEvent[]> {
    const result = await this.executor.query<EventRow>(
      `SELECT * FROM domain_events
       WHERE project_id = $1
       ORDER BY event_sequence`,
      [projectId],
    );
    return result.rows.map(mapEvent);
  }

  async listOrphans(tenantId: Uuid): Promise<readonly DomainEvent[]> {
    const result = await this.executor.query<EventRow>(
      `SELECT * FROM domain_events
       WHERE tenant_id = $1 AND project_id IS NULL AND type = 'orphan.event'
       ORDER BY event_sequence`,
      [tenantId],
    );
    return result.rows.map(mapEvent);
  }
}

class PostgresOutboxRepository implements OutboxRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async enqueue(event: DomainEvent): Promise<void> {
    await this.executor.query(
      `INSERT INTO outbox_events (id, event_id, available_at)
       VALUES ($1, $2, $3)`,
      [event.id, event.id, event.observedAt],
    );
  }

  async claimNext(now: string): Promise<OutboxMessage | null> {
    const result = await this.executor.query<OutboxRow>(
      `SELECT
         o.id AS outbox_id,
         o.event_id,
         o.available_at,
         o.attempt_count,
         e.type AS event_type,
         e.version AS event_version,
         e.occurred_at,
         e.observed_at,
         e.producer,
         e.tenant_id,
         e.project_id,
         e.shot_id,
         e.attempt_id,
         e.prompt_id,
         e.trace_id,
         e.payload
       FROM outbox_events o
       JOIN domain_events e ON e.id = o.event_id
       WHERE o.delivered_at IS NULL AND o.available_at <= $1
       ORDER BY o.available_at, o.id
       FOR UPDATE OF o SKIP LOCKED
       LIMIT 1`,
      [now],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    await this.executor.query(
      'UPDATE outbox_events SET attempt_count = attempt_count + 1 WHERE id = $1',
      [row.outbox_id],
    );
    return mapOutboxMessage({ ...row, attempt_count: row.attempt_count + 1 });
  }

  async markDelivered(id: Uuid, deliveredAt: string): Promise<void> {
    await this.executor.query(
      'UPDATE outbox_events SET delivered_at = $1 WHERE id = $2 AND delivered_at IS NULL',
      [deliveredAt, id],
    );
  }

  async markFailed(id: Uuid, errorMessage: string): Promise<void> {
    await this.executor.query(
      `UPDATE outbox_events
       SET last_error = $1,
           available_at = now() + interval '1 second'
       WHERE id = $2 AND delivered_at IS NULL`,
      [errorMessage.slice(0, 500), id],
    );
  }
}

class PostgresIdempotencyRepository implements IdempotencyRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async reserve(
    tenantId: Uuid,
    key: string,
    operation: string,
    requestHash: string,
    createdAt: string,
  ): Promise<IdempotencyReservation> {
    const inserted = await this.executor.query<IdempotencyRow>(
      `INSERT INTO idempotency_records (
        tenant_id, idempotency_key, operation, request_hash, created_at
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      RETURNING *`,
      [tenantId, key, operation, requestHash, createdAt],
    );
    if (inserted.rows.length > 0) {
      return { kind: 'reserved' };
    }

    const existing = await this.executor.query<IdempotencyRow>(
      `SELECT * FROM idempotency_records
       WHERE tenant_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [tenantId, key],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new RepositoryError(
        'DATABASE_ERROR',
        'Idempotency record disappeared during reservation.',
      );
    }
    if (row.operation !== operation || row.request_hash !== requestHash) {
      return { kind: 'conflict' };
    }
    if (row.response_status !== null && row.response_body !== null) {
      return {
        kind: 'replay',
        status: row.response_status,
        body: row.response_body,
      };
    }
    return { kind: 'in_progress' };
  }

  async complete(
    tenantId: Uuid,
    key: string,
    status: number,
    body: unknown,
    completedAt: string,
  ): Promise<void> {
    const result = await this.executor.query(
      `UPDATE idempotency_records
       SET response_status = $1,
           response_body = $2::jsonb,
           completed_at = $3
       WHERE tenant_id = $4 AND idempotency_key = $5
         AND response_status IS NULL`,
      [status, databaseJson(body), completedAt, tenantId, key],
    );
    if (result.rowCount !== 1) {
      throw new RepositoryError(
        'DATABASE_ERROR',
        'Idempotency record could not be completed.',
      );
    }
  }

  async release(tenantId: Uuid, key: string): Promise<void> {
    await this.executor.query(
      `DELETE FROM idempotency_records
       WHERE tenant_id = $1 AND idempotency_key = $2
         AND response_status IS NULL`,
      [tenantId, key],
    );
  }
}

function createPostgresRepositories(executor: SqlExecutor): Repositories {
  const recommendations = new PostgresOperationalRecommendationRepository(
    executor,
  );
  return {
    tenants: new PostgresTenantRepository(executor),
    projects: new PostgresProjectRepository(executor),
    shots: new PostgresShotRepository(executor),
    attempts: new PostgresAttemptRepository(executor),
    artifacts: new PostgresArtifactRepository(executor),
    evaluations: new PostgresEvaluationRepository(executor),
    agentRuns: new PostgresAgentRunRepository(executor),
    workflowVersions: new PostgresWorkflowVersionRepository(executor),
    workflowDrafts: new PostgresWorkflowDraftRepository(executor),
    workflowRevisions: new PostgresWorkflowRevisionRepository(executor),
    recommendations,
    operationalRecommendations: recommendations,
    events: new PostgresEventRepository(executor),
    outbox: new PostgresOutboxRepository(executor),
    idempotency: new PostgresIdempotencyRepository(executor),
  };
}

export async function withDatabaseTransaction<Result>(
  pool: Pool,
  work: (repositories: Repositories) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(createPostgresRepositories(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresStore implements TransactionalStore {
  readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  withTransaction<Result>(
    work: (repositories: Repositories) => Promise<Result>,
  ): Promise<Result> {
    return withDatabaseTransaction(this.pool, work);
  }
}

export function createPostgresStore(pool: Pool): PostgresStore {
  return new PostgresStore(pool);
}

interface MemoryTenant {
  readonly id: Uuid;
  readonly name: string;
  readonly createdAt: string;
}

interface MemoryState {
  readonly tenants: Map<Uuid, MemoryTenant>;
  readonly projects: Map<Uuid, VideoProject>;
  readonly shots: Map<Uuid, Shot>;
  readonly attempts: Map<Uuid, GenerationAttempt>;
  readonly artifacts: Map<Uuid, ArtifactRecord>;
  readonly evaluations: Map<Uuid, EvaluationResult>;
  readonly agentRuns: Map<Uuid, AgentRunRecord>;
  readonly workflowVersions: Map<Uuid, WorkflowVersionRecord>;
  readonly workflowDrafts: Map<Uuid, WorkflowDraftRecord>;
  readonly workflowRevisions: Map<Uuid, WorkflowRevisionRecord>;
  readonly recommendations: Map<Uuid, OperationalRecommendationRecord>;
  readonly events: Map<Uuid, DomainEvent>;
  nextEventSequence: number;
  readonly outbox: Map<
    Uuid,
    OutboxMessage & {
      readonly deliveredAt: string | null;
      readonly lastError: string | null;
    }
  >;
  readonly idempotency: Map<string, IdempotencyRecord>;
}

function emptyMemoryState(): MemoryState {
  return {
    tenants: new Map(),
    projects: new Map(),
    shots: new Map(),
    attempts: new Map(),
    artifacts: new Map(),
    evaluations: new Map(),
    agentRuns: new Map(),
    workflowVersions: new Map(),
    workflowDrafts: new Map(),
    workflowRevisions: new Map(),
    recommendations: new Map(),
    events: new Map(),
    nextEventSequence: 1,
    outbox: new Map(),
    idempotency: new Map(),
  };
}

function cloneMemoryState(state: MemoryState): MemoryState {
  return {
    tenants: new Map(state.tenants),
    projects: new Map(state.projects),
    shots: new Map([...state.shots].map(([id, shot]) => [id, cloneShot(shot)])),
    attempts: new Map(
      [...state.attempts].map(([id, attempt]) => [id, { ...attempt }]),
    ),
    artifacts: new Map(
      [...state.artifacts].map(([id, artifact]) => [id, { ...artifact }]),
    ),
    evaluations: new Map(
      [...state.evaluations].map(([id, result]) => [
        id,
        {
          ...result,
          checks: { ...result.checks },
          details: { ...result.details },
        },
      ]),
    ),
    agentRuns: new Map(
      [...state.agentRuns].map(([id, run]) => [id, { ...run }]),
    ),
    workflowVersions: new Map(
      [...state.workflowVersions].map(([id, version]) => [
        id,
        { ...version, workflowJson: { ...version.workflowJson } },
      ]),
    ),
    workflowDrafts: new Map(
      [...state.workflowDrafts].map(([id, draft]) => [
        id,
        {
          ...draft,
          editorGraphJson: structuredClone(draft.editorGraphJson),
          ...(draft.lastApiGraphJson !== undefined
            ? { lastApiGraphJson: structuredClone(draft.lastApiGraphJson) }
            : {}),
        },
      ]),
    ),
    workflowRevisions: new Map(
      [...state.workflowRevisions].map(([id, revision]) => [
        id,
        {
          ...revision,
          editorGraphJson: structuredClone(revision.editorGraphJson),
          apiGraphJson: structuredClone(revision.apiGraphJson),
          executionParametersJson: structuredClone(
            revision.executionParametersJson,
          ),
          validationErrorsJson: structuredClone(revision.validationErrorsJson),
        },
      ]),
    ),
    recommendations: new Map(
      [...state.recommendations].map(([id, recommendation]) => [
        id,
        {
          ...recommendation,
          evidenceReferencesJson: structuredClone(
            recommendation.evidenceReferencesJson,
          ),
          proposedResourceIdsJson: [...recommendation.proposedResourceIdsJson],
        },
      ]),
    ),
    events: new Map(
      [...state.events].map(([id, event]) => [
        id,
        { ...event, payload: { ...event.payload } },
      ]),
    ),
    nextEventSequence: state.nextEventSequence,
    outbox: new Map(
      [...state.outbox].map(([id, message]) => [id, { ...message }]),
    ),
    idempotency: new Map(
      [...state.idempotency].map(([id, record]) => [id, { ...record }]),
    ),
  };
}

function cloneShot(shot: Shot): Shot {
  return {
    ...shot,
    ...(shot.acceptanceCriteria !== undefined
      ? { acceptanceCriteria: [...shot.acceptanceCriteria] }
      : {}),
    ...(shot.requiredAssetIds !== undefined
      ? { requiredAssetIds: [...shot.requiredAssetIds] }
      : {}),
  };
}

function memoryIdempotencyKey(tenantId: Uuid, key: string): string {
  return `${tenantId}:${key}`;
}

class MemoryRepositories implements Repositories {
  readonly tenants: TenantRepository;
  readonly projects: ProjectRepository;
  readonly shots: ShotRepository;
  readonly attempts: AttemptRepository;
  readonly artifacts: ArtifactRepository;
  readonly evaluations: EvaluationRepository;
  readonly agentRuns: AgentRunRepository;
  readonly workflowVersions: WorkflowVersionRepository;
  readonly workflowDrafts: WorkflowDraftRepository;
  readonly workflowRevisions: WorkflowRevisionRepository;
  readonly recommendations: OperationalRecommendationRepository;
  readonly operationalRecommendations: OperationalRecommendationRepository;
  readonly events: EventRepository;
  readonly outbox: OutboxRepository;
  readonly idempotency: IdempotencyRepository;

  private readonly state: MemoryState;

  constructor(state: MemoryState) {
    this.state = state;
    this.tenants = {
      ensure: async (id, name, createdAt) => {
        if (!this.state.tenants.has(id)) {
          this.state.tenants.set(id, { id, name, createdAt });
        }
      },
    };
    this.projects = {
      create: async (project) => {
        if (this.state.projects.has(project.id)) {
          throw new RepositoryError(
            'UNIQUE_VIOLATION',
            'Project already exists.',
          );
        }
        this.state.projects.set(project.id, { ...project });
      },
      findById: async (tenantId, projectId) => {
        const project = this.state.projects.get(projectId);
        return project && project.tenantId === tenantId ? { ...project } : null;
      },
      listByTenant: async (tenantId) =>
        [...this.state.projects.values()]
          .filter((project) => project.tenantId === tenantId)
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) ||
              left.id.localeCompare(right.id),
          )
          .map((project) => ({ ...project })),
      update: async (project, expectedVersion) => {
        const current = this.state.projects.get(project.id);
        if (!current || current.version !== expectedVersion) {
          throw new RepositoryError(
            'OPTIMISTIC_CONFLICT',
            'The project was modified by another transaction.',
          );
        }
        this.state.projects.set(project.id, { ...project });
        return { ...project };
      },
    };
    this.shots = {
      createMany: async (shots) => {
        const keys = new Set<string>();
        for (const shot of shots) {
          const key = `${shot.projectId}:${shot.ordinal}`;
          if (
            keys.has(key) ||
            [...this.state.shots.values()].some(
              (current) => `${current.projectId}:${current.ordinal}` === key,
            )
          ) {
            throw new RepositoryError(
              'UNIQUE_VIOLATION',
              'Shot ordinal already exists.',
            );
          }
          keys.add(key);
        }
        for (const shot of shots) {
          this.state.shots.set(shot.id, cloneShot(shot));
        }
      },
      listByProject: async (projectId) =>
        [...this.state.shots.values()]
          .filter((shot) => shot.projectId === projectId)
          .sort((left, right) => left.ordinal - right.ordinal)
          .map(cloneShot),
      findById: async (projectId, shotId) => {
        const shot = this.state.shots.get(shotId);
        return shot && shot.projectId === projectId ? cloneShot(shot) : null;
      },
      findByIdAny: async (shotId) => {
        const shot = this.state.shots.get(shotId);
        return shot ? cloneShot(shot) : null;
      },
      update: async (shot, expectedVersion) => {
        const current = this.state.shots.get(shot.id);
        if (!current || current.version !== expectedVersion) {
          throw new RepositoryError(
            'OPTIMISTIC_CONFLICT',
            'The shot was modified by another transaction.',
          );
        }
        this.state.shots.set(shot.id, cloneShot(shot));
        return cloneShot(shot);
      },
    };
    this.attempts = {
      create: async (attempt) => {
        if (attempt.workflowRevisionId) {
          const revision = this.state.workflowRevisions.get(
            attempt.workflowRevisionId,
          );
          if (
            !revision ||
            revision.tenantId !== attempt.tenantId ||
            revision.projectId !== attempt.projectId ||
            revision.shotId !== attempt.shotId ||
            revision.validationStatus !== 'validated' ||
            revision.executionHash !== attempt.workflowHash
          ) {
            throw new RepositoryError(
              'SCOPE_VIOLATION',
              'Managed attempts require one validated workflow revision in the same scope.',
            );
          }
        }
        if (this.state.attempts.has(attempt.id)) {
          throw new RepositoryError(
            'UNIQUE_VIOLATION',
            'Generation attempt already exists.',
          );
        }
        if (
          [...this.state.attempts.values()].some(
            (current) =>
              current.idempotencyKey === attempt.idempotencyKey &&
              current.tenantId === attempt.tenantId,
          )
        ) {
          throw new RepositoryError(
            'UNIQUE_VIOLATION',
            'Generation attempt idempotency key already exists.',
          );
        }
        if (
          attempt.comfyPromptId &&
          [...this.state.attempts.values()].some(
            (current) => current.comfyPromptId === attempt.comfyPromptId,
          )
        ) {
          throw new RepositoryError(
            'UNIQUE_VIOLATION',
            'Comfy prompt identifier already exists.',
          );
        }
        if (
          [...this.state.attempts.values()].some(
            (current) =>
              current.tenantId === attempt.tenantId &&
              current.correlationId === attempt.correlationId,
          )
        ) {
          throw new RepositoryError(
            'UNIQUE_VIOLATION',
            'Generation attempt correlation identifier already exists.',
          );
        }
        this.state.attempts.set(attempt.id, { ...attempt });
      },
      findById: async (tenantId, attemptId) => {
        const attempt = this.state.attempts.get(attemptId);
        return attempt && attempt.tenantId === tenantId ? { ...attempt } : null;
      },
      findByPromptId: async (tenantId, promptId) => {
        const attempt = [...this.state.attempts.values()].find(
          (current) =>
            current.tenantId === tenantId && current.comfyPromptId === promptId,
        );
        return attempt ? { ...attempt } : null;
      },
      findByCorrelationId: async (tenantId, correlationId) => {
        const attempt = [...this.state.attempts.values()].find(
          (current) =>
            current.tenantId === tenantId &&
            current.correlationId === correlationId,
        );
        return attempt ? { ...attempt } : null;
      },
      listByShot: async (tenantId, shotId) =>
        [...this.state.attempts.values()]
          .filter(
            (attempt) =>
              attempt.tenantId === tenantId && attempt.shotId === shotId,
          )
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) ||
              left.id.localeCompare(right.id),
          )
          .map((attempt) => ({ ...attempt })),
      listByProject: async (tenantId, projectId) =>
        [...this.state.attempts.values()]
          .filter(
            (attempt) =>
              attempt.tenantId === tenantId && attempt.projectId === projectId,
          )
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) ||
              left.id.localeCompare(right.id),
          )
          .map((attempt) => ({ ...attempt })),
      update: async (attempt, expectedVersion) => {
        const current = this.state.attempts.get(attempt.id);
        if (!current || current.version !== expectedVersion) {
          throw new RepositoryError(
            'OPTIMISTIC_CONFLICT',
            'The generation attempt was modified by another transaction.',
          );
        }
        if (isTerminalGenerationAttempt(current.status)) {
          throw new RepositoryError(
            'INVALID_ARGUMENT',
            'Terminal generation attempts are immutable.',
          );
        }
        if (
          current.workflowRevisionId &&
          (attempt.workflowRevisionId !== current.workflowRevisionId ||
            attempt.workflowVersionId !== current.workflowVersionId ||
            attempt.seed !== current.seed ||
            attempt.steps !== current.steps ||
            attempt.requestedWidth !== current.requestedWidth ||
            attempt.requestedHeight !== current.requestedHeight ||
            attempt.requestedDurationSeconds !==
              current.requestedDurationSeconds ||
            attempt.workflowHash !== current.workflowHash)
        ) {
          throw new RepositoryError(
            'INVALID_ARGUMENT',
            'Managed attempt execution data is immutable.',
          );
        }
        this.state.attempts.set(attempt.id, { ...attempt });
        return { ...attempt };
      },
      review: async (
        tenantId,
        attemptId,
        decision,
        note,
        author,
        reviewedAt,
      ) => {
        const current = this.state.attempts.get(attemptId);
        if (!current || current.tenantId !== tenantId) {
          throw new RepositoryError(
            'NOT_FOUND',
            'The generation attempt was not found in the requested tenant.',
          );
        }
        if (decision !== 'accepted' && decision !== 'rejected') {
          throw new RepositoryError(
            'INVALID_ARGUMENT',
            'Attempt review decision is unknown.',
          );
        }
        const { reviewNote: _reviewNote, ...withoutReviewNote } = current;
        const reviewed: GenerationAttempt = {
          ...withoutReviewNote,
          reviewDecision: decision,
          ...(note !== null ? { reviewNote: note } : {}),
          reviewAuthor: author,
          reviewedAt: reviewedAt as NonNullable<
            GenerationAttempt['reviewedAt']
          >,
          version: current.version + 1,
          updatedAt: reviewedAt as GenerationAttempt['updatedAt'],
        };
        this.state.attempts.set(attemptId, reviewed);
        return { ...reviewed };
      },
      claimNext: async (workerId, now, leaseExpiresAt) => {
        const activeStatuses = new Set([
          'claimed',
          'submitting',
          'submitted',
          'running',
          'generated',
          'evaluating',
        ]);
        const hasActiveClaim = [...this.state.attempts.values()].some(
          (attempt) =>
            attempt.leaseOwner === workerId &&
            attempt.leaseExpiresAt !== undefined &&
            attempt.leaseExpiresAt >= now &&
            activeStatuses.has(attempt.status),
        );
        if (hasActiveClaim) {
          return null;
        }
        const candidate = [...this.state.attempts.values()]
          .filter(
            (attempt) =>
              attempt.status === 'queued' &&
              (attempt.leaseExpiresAt === undefined ||
                attempt.leaseExpiresAt < now),
          )
          .sort(
            (left, right) =>
              left.queuedAt.localeCompare(right.queuedAt) ||
              left.id.localeCompare(right.id),
          )[0];
        if (!candidate) {
          return null;
        }
        const claimed: GenerationAttempt = {
          ...candidate,
          status: 'claimed',
          leaseOwner: workerId,
          leaseExpiresAt: leaseExpiresAt as NonNullable<
            GenerationAttempt['leaseExpiresAt']
          >,
          version: candidate.version + 1,
          updatedAt: now as GenerationAttempt['updatedAt'],
        };
        this.state.attempts.set(candidate.id, claimed);
        return { ...claimed };
      },
      claimForRecovery: async (workerId, now, leaseExpiresAt) => {
        const activeStatuses = new Set([
          'claimed',
          'submitting',
          'submitted',
          'running',
          'generated',
          'evaluating',
        ]);
        const hasActiveClaim = [...this.state.attempts.values()].some(
          (attempt) =>
            attempt.leaseOwner === workerId &&
            attempt.leaseExpiresAt !== undefined &&
            attempt.leaseExpiresAt >= now &&
            activeStatuses.has(attempt.status),
        );
        if (hasActiveClaim) return null;
        const candidate = [...this.state.attempts.values()]
          .filter(
            (attempt) =>
              [
                'submitting',
                'submitted',
                'running',
                'generated',
                'evaluating',
              ].includes(attempt.status) &&
              (attempt.leaseExpiresAt === undefined ||
                attempt.leaseExpiresAt < now),
          )
          .sort(
            (left, right) =>
              left.updatedAt.localeCompare(right.updatedAt) ||
              left.id.localeCompare(right.id),
          )[0];
        if (!candidate) return null;
        const recovered: GenerationAttempt = {
          ...candidate,
          leaseOwner: workerId,
          leaseExpiresAt: leaseExpiresAt as NonNullable<
            GenerationAttempt['leaseExpiresAt']
          >,
          version: candidate.version + 1,
          updatedAt: now as GenerationAttempt['updatedAt'],
        };
        this.state.attempts.set(candidate.id, recovered);
        return { ...recovered };
      },
      heartbeat: async (attemptId, workerId, leaseExpiresAt) => {
        const current = this.state.attempts.get(attemptId);
        if (
          !current ||
          current.leaseOwner !== workerId ||
          ![
            'claimed',
            'submitting',
            'submitted',
            'running',
            'generated',
            'evaluating',
          ].includes(current.status)
        ) {
          return null;
        }
        const updated: GenerationAttempt = {
          ...current,
          leaseExpiresAt: leaseExpiresAt as NonNullable<
            GenerationAttempt['leaseExpiresAt']
          >,
          version: current.version + 1,
          updatedAt: leaseExpiresAt as GenerationAttempt['updatedAt'],
        };
        this.state.attempts.set(attemptId, updated);
        return { ...updated };
      },
      release: async (attemptId, workerId, updatedAt) => {
        const current = this.state.attempts.get(attemptId);
        if (
          !current ||
          current.leaseOwner !== workerId ||
          ![
            'claimed',
            'submitting',
            'submitted',
            'running',
            'generated',
            'evaluating',
          ].includes(current.status)
        ) {
          return null;
        }
        const {
          leaseOwner: _leaseOwner,
          leaseExpiresAt: _leaseExpiresAt,
          ...withoutLease
        } = current;
        const released: GenerationAttempt = {
          ...withoutLease,
          ...(current.status === 'claimed' ? { status: 'queued' } : {}),
          version: current.version + 1,
          updatedAt: updatedAt as GenerationAttempt['updatedAt'],
        };
        this.state.attempts.set(attemptId, released);
        return { ...released };
      },
      recoverStale: async (now) => {
        const recovered: GenerationAttempt[] = [];
        for (const current of this.state.attempts.values()) {
          if (
            !current.leaseExpiresAt ||
            current.leaseExpiresAt >= now ||
            current.status !== 'claimed'
          ) {
            continue;
          }
          const {
            leaseOwner: _leaseOwner,
            leaseExpiresAt: _leaseExpiresAt,
            ...withoutLease
          } = current;
          const updated: GenerationAttempt = {
            ...withoutLease,
            status: 'queued',
            version: current.version + 1,
            updatedAt: now as GenerationAttempt['updatedAt'],
          };
          this.state.attempts.set(current.id, updated);
          recovered.push({ ...updated });
        }
        return recovered;
      },
    };
    this.artifacts = {
      create: async (artifact) => {
        if (
          this.state.artifacts.has(artifact.id) ||
          [...this.state.artifacts.values()].some(
            (current) =>
              current.objectKey === artifact.objectKey ||
              current.attemptId === artifact.attemptId,
          )
        ) {
          throw new RepositoryError(
            'UNIQUE_VIOLATION',
            'Artifact already exists for this attempt.',
          );
        }
        this.state.artifacts.set(artifact.id, { ...artifact });
      },
      findById: async (tenantId, artifactId) => {
        const artifact = this.state.artifacts.get(artifactId);
        return artifact && artifact.tenantId === tenantId
          ? { ...artifact }
          : null;
      },
      findByAttempt: async (tenantId, attemptId) => {
        const artifact = [...this.state.artifacts.values()].find(
          (current) =>
            current.tenantId === tenantId && current.attemptId === attemptId,
        );
        return artifact ? { ...artifact } : null;
      },
    };
    this.evaluations = {
      create: async (result) => {
        if (
          this.state.evaluations.has(result.id) ||
          [...this.state.evaluations.values()].some(
            (current) => current.attemptId === result.attemptId,
          )
        ) {
          throw new RepositoryError(
            'UNIQUE_VIOLATION',
            'An evaluation already exists for this attempt.',
          );
        }
        this.state.evaluations.set(result.id, {
          ...result,
          checks: { ...result.checks },
          details: { ...result.details },
        });
      },
      findByAttempt: async (tenantId, attemptId) => {
        const result = [...this.state.evaluations.values()].find(
          (current) =>
            current.tenantId === tenantId && current.attemptId === attemptId,
        );
        return result
          ? {
              ...result,
              checks: { ...result.checks },
              details: { ...result.details },
            }
          : null;
      },
    };
    this.agentRuns = {
      create: async (run) => {
        if (
          this.state.agentRuns.has(run.id) ||
          [...this.state.agentRuns.values()].some(
            (current) =>
              current.tenantId === run.tenantId && current.runId === run.runId,
          )
        ) {
          throw new RepositoryError(
            'UNIQUE_VIOLATION',
            'Agent run already exists.',
          );
        }
        this.state.agentRuns.set(run.id, { ...run });
      },
      findById: async (tenantId, runId) => {
        const run = this.state.agentRuns.get(runId);
        return run && run.tenantId === tenantId ? { ...run } : null;
      },
      listByProject: async (tenantId, projectId) =>
        [...this.state.agentRuns.values()]
          .filter(
            (run) => run.tenantId === tenantId && run.projectId === projectId,
          )
          .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
          .map((run) => ({ ...run })),
      update: async (run, expectedVersion) => {
        const current = this.state.agentRuns.get(run.id);
        if (!current || current.tenantId !== run.tenantId) {
          throw new RepositoryError('NOT_FOUND', 'Agent run not found.');
        }
        if (current.version !== expectedVersion) {
          throw new RepositoryError(
            'OPTIMISTIC_CONFLICT',
            'Agent run was changed by another writer.',
          );
        }
        this.state.agentRuns.set(run.id, { ...run });
        return { ...run };
      },
    };
    this.workflowVersions = {
      findByHash: async (workflowHash) => {
        const version = [...this.state.workflowVersions.values()].find(
          (current) => current.workflowHash === workflowHash,
        );
        return version
          ? { ...version, workflowJson: { ...version.workflowJson } }
          : null;
      },
      create: async (version) => {
        if (
          this.state.workflowVersions.has(version.id) ||
          [...this.state.workflowVersions.values()].some(
            (current) => current.workflowHash === version.workflowHash,
          )
        ) {
          throw new RepositoryError(
            'UNIQUE_VIOLATION',
            'Workflow version already exists for this hash.',
          );
        }
        this.state.workflowVersions.set(version.id, {
          ...version,
          workflowJson: { ...version.workflowJson },
        });
      },
    };
    const copyDraft = (draft: WorkflowDraftRecord): WorkflowDraftRecord => ({
      ...draft,
      editorGraphJson: structuredClone(draft.editorGraphJson),
      ...(draft.lastApiGraphJson !== undefined
        ? { lastApiGraphJson: structuredClone(draft.lastApiGraphJson) }
        : {}),
    });
    const copyRevision = (
      revision: WorkflowRevisionRecord,
    ): WorkflowRevisionRecord => ({
      ...revision,
      editorGraphJson: structuredClone(revision.editorGraphJson),
      apiGraphJson: structuredClone(revision.apiGraphJson),
      executionParametersJson: structuredClone(
        revision.executionParametersJson,
      ),
      validationErrorsJson: structuredClone(revision.validationErrorsJson),
    });
    const copyRecommendation = (
      recommendation: OperationalRecommendationRecord,
    ): OperationalRecommendationRecord => ({
      ...recommendation,
      evidenceReferencesJson: structuredClone(
        recommendation.evidenceReferencesJson,
      ),
      proposedResourceIdsJson: [...recommendation.proposedResourceIdsJson],
    });
    const assertMemoryProjectShotScope = (
      tenantId: Uuid,
      projectId: Uuid,
      shotId: Uuid,
    ): void => {
      const project = this.state.projects.get(projectId);
      const shot = this.state.shots.get(shotId);
      if (
        !project ||
        project.tenantId !== tenantId ||
        !shot ||
        shot.projectId !== projectId
      ) {
        throw new RepositoryError(
          'SCOPE_VIOLATION',
          'The tenant, project, and shot scope does not match.',
        );
      }
    };
    this.workflowDrafts = {
      findByShot: async (tenantId, projectId, shotId) => {
        const draft = [...this.state.workflowDrafts.values()].find(
          (current) =>
            current.tenantId === tenantId &&
            current.projectId === projectId &&
            current.shotId === shotId,
        );
        return draft ? copyDraft(draft) : null;
      },
      create: async (draft, idempotencyKey) => {
        assertWorkflowDraftRecord(draft);
        const reservation = await reserveResourceMutation(
          this.idempotency,
          draft.tenantId,
          idempotencyKey,
          'workflow-draft.create',
          draft,
          draft.createdAt,
        );
        if (reservation.replayResourceId) {
          const existing = [...this.state.workflowDrafts.values()].find(
            (current) =>
              current.id === reservation.replayResourceId &&
              current.tenantId === draft.tenantId &&
              current.projectId === draft.projectId &&
              current.shotId === draft.shotId,
          );
          if (!existing) {
            throw new RepositoryError(
              'DATABASE_ERROR',
              'The stored workflow draft idempotency result is missing.',
            );
          }
          return copyDraft(existing);
        }
        try {
          assertMemoryProjectShotScope(
            draft.tenantId,
            draft.projectId,
            draft.shotId,
          );
          if (
            draft.baseRevisionId &&
            ![...this.state.workflowRevisions.values()].some(
              (revision) =>
                revision.id === draft.baseRevisionId &&
                revision.tenantId === draft.tenantId &&
                revision.projectId === draft.projectId &&
                revision.shotId === draft.shotId,
            )
          ) {
            throw new RepositoryError(
              'SCOPE_VIOLATION',
              'The workflow draft base revision is outside its shot scope.',
            );
          }
          if (
            this.state.workflowDrafts.has(draft.id) ||
            [...this.state.workflowDrafts.values()].some(
              (current) =>
                current.tenantId === draft.tenantId &&
                current.projectId === draft.projectId &&
                current.shotId === draft.shotId,
            )
          ) {
            throw new RepositoryError(
              'UNIQUE_VIOLATION',
              'A workflow draft already exists for this shot.',
            );
          }
          this.state.workflowDrafts.set(draft.id, copyDraft(draft));
          await completeResourceMutation(
            this.idempotency,
            draft.tenantId,
            reservation,
            draft.id,
            draft.updatedAt,
          );
          return copyDraft(draft);
        } catch (error) {
          await releaseResourceMutation(
            this.idempotency,
            draft.tenantId,
            reservation,
          );
          throw error;
        }
      },
      update: async (draft, expectedVersion, idempotencyKey) => {
        assertWorkflowDraftRecord(draft);
        const reservation = await reserveResourceMutation(
          this.idempotency,
          draft.tenantId,
          idempotencyKey,
          'workflow-draft.update',
          { draft, expectedVersion },
          draft.updatedAt,
        );
        if (reservation.replayResourceId) {
          const existing = [...this.state.workflowDrafts.values()].find(
            (current) =>
              current.id === reservation.replayResourceId &&
              current.tenantId === draft.tenantId &&
              current.projectId === draft.projectId &&
              current.shotId === draft.shotId,
          );
          if (!existing) {
            throw new RepositoryError(
              'DATABASE_ERROR',
              'The stored workflow draft idempotency result is missing.',
            );
          }
          return copyDraft(existing);
        }
        try {
          assertMemoryProjectShotScope(
            draft.tenantId,
            draft.projectId,
            draft.shotId,
          );
          const current = this.state.workflowDrafts.get(draft.id);
          if (
            !current ||
            current.tenantId !== draft.tenantId ||
            current.projectId !== draft.projectId ||
            current.shotId !== draft.shotId ||
            current.version !== expectedVersion
          ) {
            throw new RepositoryError(
              'OPTIMISTIC_CONFLICT',
              'The workflow draft was modified by another transaction.',
            );
          }
          if (
            draft.baseRevisionId &&
            ![...this.state.workflowRevisions.values()].some(
              (revision) =>
                revision.id === draft.baseRevisionId &&
                revision.tenantId === draft.tenantId &&
                revision.projectId === draft.projectId &&
                revision.shotId === draft.shotId,
            )
          ) {
            throw new RepositoryError(
              'SCOPE_VIOLATION',
              'The workflow draft base revision is outside its shot scope.',
            );
          }
          this.state.workflowDrafts.set(draft.id, copyDraft(draft));
          await completeResourceMutation(
            this.idempotency,
            draft.tenantId,
            reservation,
            draft.id,
            draft.updatedAt,
          );
          return copyDraft(draft);
        } catch (error) {
          await releaseResourceMutation(
            this.idempotency,
            draft.tenantId,
            reservation,
          );
          throw error;
        }
      },
    };
    this.workflowRevisions = {
      create: async (revision, idempotencyKey) => {
        assertWorkflowRevisionRecord(revision);
        const { revisionNumber: _revisionNumber, ...request } = revision;
        const reservation = await reserveResourceMutation(
          this.idempotency,
          revision.tenantId,
          idempotencyKey,
          'workflow-revision.create',
          request,
          revision.createdAt,
        );
        if (reservation.replayResourceId) {
          const existing = this.state.workflowRevisions.get(
            reservation.replayResourceId,
          );
          if (
            !existing ||
            existing.tenantId !== revision.tenantId ||
            existing.projectId !== revision.projectId ||
            existing.shotId !== revision.shotId
          ) {
            throw new RepositoryError(
              'DATABASE_ERROR',
              'The stored workflow revision idempotency result is missing.',
            );
          }
          return copyRevision(existing);
        }
        try {
          assertMemoryProjectShotScope(
            revision.tenantId,
            revision.projectId,
            revision.shotId,
          );
          if (
            revision.parentRevisionId &&
            ![...this.state.workflowRevisions.values()].some(
              (current) =>
                current.id === revision.parentRevisionId &&
                current.tenantId === revision.tenantId &&
                current.projectId === revision.projectId &&
                current.shotId === revision.shotId,
            )
          ) {
            throw new RepositoryError(
              'SCOPE_VIOLATION',
              'The workflow revision parent is outside its shot scope.',
            );
          }
          if (this.state.workflowRevisions.has(revision.id)) {
            throw new RepositoryError(
              'UNIQUE_VIOLATION',
              'Workflow revision already exists.',
            );
          }
          const nextRevisionNumber =
            Math.max(
              0,
              ...[...this.state.workflowRevisions.values()]
                .filter(
                  (current) =>
                    current.tenantId === revision.tenantId &&
                    current.projectId === revision.projectId &&
                    current.shotId === revision.shotId,
                )
                .map((current) => current.revisionNumber),
            ) + 1;
          const created = copyRevision({
            ...revision,
            revisionNumber: nextRevisionNumber,
          });
          this.state.workflowRevisions.set(created.id, created);
          await completeResourceMutation(
            this.idempotency,
            revision.tenantId,
            reservation,
            created.id,
            revision.createdAt,
          );
          return copyRevision(created);
        } catch (error) {
          await releaseResourceMutation(
            this.idempotency,
            revision.tenantId,
            reservation,
          );
          throw error;
        }
      },
      findById: async (tenantId, projectId, shotId, revisionId) => {
        const revision = this.state.workflowRevisions.get(revisionId);
        return revision &&
          revision.tenantId === tenantId &&
          revision.projectId === projectId &&
          revision.shotId === shotId
          ? copyRevision(revision)
          : null;
      },
      findByIdAny: async (tenantId, revisionId) => {
        const revision = this.state.workflowRevisions.get(revisionId);
        return revision && revision.tenantId === tenantId
          ? copyRevision(revision)
          : null;
      },
      listByShot: async (tenantId, projectId, shotId) =>
        [...this.state.workflowRevisions.values()]
          .filter(
            (revision) =>
              revision.tenantId === tenantId &&
              revision.projectId === projectId &&
              revision.shotId === shotId,
          )
          .sort((left, right) => left.revisionNumber - right.revisionNumber)
          .map(copyRevision),
      updateValidation: async (
        tenantId,
        projectId,
        shotId,
        revisionId,
        update,
      ) => {
        assertWorkflowValidationUpdate(update);
        const current = this.state.workflowRevisions.get(revisionId);
        if (
          !current ||
          current.tenantId !== tenantId ||
          current.projectId !== projectId ||
          current.shotId !== shotId
        ) {
          throw new RepositoryError(
            'NOT_FOUND',
            'The workflow revision was not found in the requested scope.',
          );
        }
        const {
          validatedAt: _validatedAt,
          executorFingerprint: _executorFingerprint,
          ...withoutValidationTimestamps
        } = current;
        const updated = copyRevision({
          ...withoutValidationTimestamps,
          validationStatus: update.validationStatus,
          validationErrorsJson: [...update.validationErrorsJson],
          ...(update.validatedAt !== null
            ? { validatedAt: update.validatedAt }
            : {}),
          ...(update.executorFingerprint !== null
            ? { executorFingerprint: update.executorFingerprint }
            : {}),
        });
        this.state.workflowRevisions.set(revisionId, updated);
        return copyRevision(updated);
      },
    };
    this.recommendations = {
      create: async (recommendation) => {
        assertRecommendationRecord(recommendation);
        const project = this.state.projects.get(recommendation.projectId);
        if (!project || project.tenantId !== recommendation.tenantId) {
          throw new RepositoryError(
            'SCOPE_VIOLATION',
            'The recommendation project is outside its tenant scope.',
          );
        }
        if (recommendation.shotId) {
          assertMemoryProjectShotScope(
            recommendation.tenantId,
            recommendation.projectId,
            recommendation.shotId,
          );
        }
        const attempt = recommendation.attemptId
          ? this.state.attempts.get(recommendation.attemptId)
          : undefined;
        if (
          recommendation.attemptId &&
          (!attempt ||
            attempt.tenantId !== recommendation.tenantId ||
            attempt.projectId !== recommendation.projectId ||
            (recommendation.shotId !== undefined &&
              attempt.shotId !== recommendation.shotId))
        ) {
          throw new RepositoryError(
            'SCOPE_VIOLATION',
            'The recommendation attempt is outside its resource scope.',
          );
        }
        const event = this.state.events.get(recommendation.triggerEventId);
        if (
          !event ||
          event.tenantId !== recommendation.tenantId ||
          event.projectId !== recommendation.projectId ||
          (recommendation.shotId !== undefined &&
            event.shotId !== recommendation.shotId) ||
          (recommendation.attemptId !== undefined &&
            event.attemptId !== recommendation.attemptId)
        ) {
          throw new RepositoryError(
            'SCOPE_VIOLATION',
            'The recommendation trigger event is outside its resource scope.',
          );
        }
        if (recommendation.piAgentRunId) {
          const run = this.state.agentRuns.get(recommendation.piAgentRunId);
          if (
            !run ||
            run.tenantId !== recommendation.tenantId ||
            run.projectId !== recommendation.projectId
          ) {
            throw new RepositoryError(
              'SCOPE_VIOLATION',
              'The recommendation Pi run is outside its project scope.',
            );
          }
        }
        if (
          this.state.recommendations.has(recommendation.id) ||
          [...this.state.recommendations.values()].some(
            (current) =>
              current.triggerEventId === recommendation.triggerEventId &&
              current.recommendationCode === recommendation.recommendationCode,
          )
        ) {
          throw new RepositoryError(
            'UNIQUE_VIOLATION',
            'A recommendation already exists for this trigger and code.',
          );
        }
        this.state.recommendations.set(
          recommendation.id,
          copyRecommendation(recommendation),
        );
      },
      findByTriggerEventAndCode: async (
        tenantId,
        triggerEventId,
        recommendationCode,
      ) => {
        const recommendation = [...this.state.recommendations.values()].find(
          (current) =>
            current.tenantId === tenantId &&
            current.triggerEventId === triggerEventId &&
            current.recommendationCode === recommendationCode,
        );
        return recommendation ? copyRecommendation(recommendation) : null;
      },
      findById: async (tenantId, projectId, recommendationId) => {
        const recommendation = this.state.recommendations.get(recommendationId);
        return recommendation &&
          recommendation.tenantId === tenantId &&
          recommendation.projectId === projectId
          ? copyRecommendation(recommendation)
          : null;
      },
      listByProject: async (tenantId, projectId) =>
        [...this.state.recommendations.values()]
          .filter(
            (recommendation) =>
              recommendation.tenantId === tenantId &&
              recommendation.projectId === projectId,
          )
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) ||
              left.id.localeCompare(right.id),
          )
          .map(copyRecommendation),
      updateStatus: async (
        tenantId,
        projectId,
        recommendationId,
        status,
        expectedVersion,
        updatedAt,
      ) => {
        if (!RECOMMENDATION_STATUSES.includes(status)) {
          throw new RepositoryError(
            'INVALID_ARGUMENT',
            'Recommendation status is unknown.',
          );
        }
        const current = this.state.recommendations.get(recommendationId);
        if (
          !current ||
          current.tenantId !== tenantId ||
          current.projectId !== projectId ||
          current.version !== expectedVersion ||
          current.status !== 'pending'
        ) {
          throw new RepositoryError(
            'OPTIMISTIC_CONFLICT',
            'The recommendation was modified or is no longer pending.',
          );
        }
        const updated = copyRecommendation({
          ...current,
          status,
          version: current.version + 1,
          updatedAt,
        });
        this.state.recommendations.set(recommendationId, updated);
        return copyRecommendation(updated);
      },
    };
    this.operationalRecommendations = this.recommendations;
    this.events = {
      append: async (event) => {
        if (this.state.events.has(event.id)) {
          throw new RepositoryError(
            'UNIQUE_VIOLATION',
            'Event already exists.',
          );
        }
        this.state.events.set(event.id, {
          ...event,
          eventSequence: this.state.nextEventSequence,
          payload: { ...event.payload },
        });
        this.state.nextEventSequence += 1;
      },
      listByProject: async (projectId) =>
        [...this.state.events.values()]
          .filter((event) => event.projectId === projectId)
          .sort(
            (left, right) =>
              (left.eventSequence ?? 0) - (right.eventSequence ?? 0),
          )
          .map((event) => ({ ...event, payload: { ...event.payload } })),
      listOrphans: async (tenantId) =>
        [...this.state.events.values()]
          .filter(
            (event) =>
              event.tenantId === tenantId &&
              event.projectId === undefined &&
              event.type === 'orphan.event',
          )
          .sort(
            (left, right) =>
              (left.eventSequence ?? 0) - (right.eventSequence ?? 0),
          )
          .map((event) => ({ ...event, payload: { ...event.payload } })),
    };
    this.outbox = {
      enqueue: async (event) => {
        if (this.state.outbox.has(event.id)) {
          throw new RepositoryError(
            'UNIQUE_VIOLATION',
            'Outbox event already exists.',
          );
        }
        this.state.outbox.set(event.id, {
          id: event.id,
          event: { ...event, payload: { ...event.payload } },
          availableAt: event.observedAt,
          attemptCount: 0,
          deliveredAt: null,
          lastError: null,
        });
      },
      claimNext: async (now) => {
        const pending = [...this.state.outbox.values()]
          .filter(
            (message) =>
              message.deliveredAt === null && message.availableAt <= now,
          )
          .sort(
            (left, right) =>
              left.availableAt.localeCompare(right.availableAt) ||
              left.id.localeCompare(right.id),
          );
        const message = pending[0];
        if (!message) {
          return null;
        }
        const updated = { ...message, attemptCount: message.attemptCount + 1 };
        this.state.outbox.set(message.id, updated);
        return {
          ...updated,
          event: { ...updated.event, payload: { ...updated.event.payload } },
        };
      },
      markDelivered: async (id, deliveredAt) => {
        const message = this.state.outbox.get(id);
        if (message && message.deliveredAt === null) {
          this.state.outbox.set(id, { ...message, deliveredAt });
        }
      },
      markFailed: async (id, errorMessage) => {
        const message = this.state.outbox.get(id);
        if (message && message.deliveredAt === null) {
          this.state.outbox.set(id, {
            ...message,
            lastError: errorMessage.slice(0, 500),
          });
        }
      },
    };
    this.idempotency = {
      reserve: async (tenantId, key, operation, requestHash, createdAt) => {
        const recordKey = memoryIdempotencyKey(tenantId, key);
        const existing = this.state.idempotency.get(recordKey);
        if (!existing) {
          this.state.idempotency.set(recordKey, {
            tenantId,
            key,
            operation,
            requestHash,
            responseStatus: null,
            responseBody: null,
            createdAt,
            completedAt: null,
          });
          return { kind: 'reserved' };
        }
        if (
          existing.operation !== operation ||
          existing.requestHash !== requestHash
        ) {
          return { kind: 'conflict' };
        }
        if (
          existing.responseStatus !== null &&
          existing.responseBody !== null
        ) {
          return {
            kind: 'replay',
            status: existing.responseStatus,
            body: existing.responseBody,
          };
        }
        return { kind: 'in_progress' };
      },
      complete: async (tenantId, key, status, body, completedAt) => {
        const recordKey = memoryIdempotencyKey(tenantId, key);
        const existing = this.state.idempotency.get(recordKey);
        if (!existing || existing.responseStatus !== null) {
          throw new RepositoryError(
            'DATABASE_ERROR',
            'Idempotency record could not be completed.',
          );
        }
        this.state.idempotency.set(recordKey, {
          ...existing,
          responseStatus: status,
          responseBody: body,
          completedAt,
        });
      },
      release: async (tenantId, key) => {
        const recordKey = memoryIdempotencyKey(tenantId, key);
        const existing = this.state.idempotency.get(recordKey);
        if (existing?.responseStatus === null) {
          this.state.idempotency.delete(recordKey);
        }
      },
    };
  }
}

export class InMemoryStore implements TransactionalStore {
  private state = emptyMemoryState();
  private transactionTail: Promise<void> = Promise.resolve();

  async withTransaction<Result>(
    work: (repositories: Repositories) => Promise<Result>,
  ): Promise<Result> {
    const previous = this.transactionTail;
    let release: (() => void) | undefined;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const snapshot = cloneMemoryState(this.state);
    try {
      const result = await work(new MemoryRepositories(this.state));
      release?.();
      return result;
    } catch (error) {
      this.state = snapshot;
      release?.();
      throw error;
    }
  }
}

export function createInMemoryStore(): InMemoryStore {
  return new InMemoryStore();
}

export interface OutboxConsumer {
  /** The repositories are from the claim transaction when supplied. */
  consume(message: OutboxMessage, repositories?: Repositories): Promise<void>;
}

export class NoopOutboxConsumer implements OutboxConsumer {
  async consume(_message: OutboxMessage): Promise<void> {}
}

export class OutboxDispatcher {
  private readonly store: TransactionalStore;
  private readonly consumer: OutboxConsumer;
  private readonly clock: Clock;

  constructor(
    store: TransactionalStore,
    consumer: OutboxConsumer = new NoopOutboxConsumer(),
    clock: Clock = { now: () => new Date() },
  ) {
    this.store = store;
    this.consumer = consumer;
    this.clock = clock;
  }

  async pollOnce(): Promise<boolean> {
    let dispatched = false;
    await this.store.withTransaction(async (repositories) => {
      const now = toIsoUtc(this.clock.now());
      const message = await repositories.outbox.claimNext(now);
      if (!message) {
        return;
      }
      try {
        await this.consumer.consume(message, repositories);
        await repositories.outbox.markDelivered(message.id, now);
        dispatched = true;
      } catch (error) {
        await repositories.outbox.markFailed(
          message.id,
          error instanceof Error ? error.message : 'outbox consumer failed',
        );
      }
    });
    return dispatched;
  }
}

/**
 * Test teardown closes the pool. Business data is intentionally not deleted
 * by this helper; callers can use a dedicated test database or transaction.
 */
export async function teardownTestDatabase(pool: Pool): Promise<void> {
  await closeDatabase(pool);
}
