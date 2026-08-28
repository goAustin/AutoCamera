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
  parseStoryboardStatus,
  toIsoUtc,
  type ArtifactRecord,
  type AttemptFailureCode,
  type EvaluationResult,
  type GenerationAttempt,
  type Shot,
  type StoryboardProposal,
  type Uuid,
  type VideoProject,
} from '@h3/domain';

export interface SqlExecutor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}

export function createDatabasePool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    application_name: 'h3-videoops-api',
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

export interface StoryboardRepository {
  create(proposal: StoryboardProposal): Promise<void>;
  findById(
    projectId: Uuid,
    proposalId: Uuid,
  ): Promise<StoryboardProposal | null>;
  findLatest(projectId: Uuid): Promise<StoryboardProposal | null>;
  update(
    proposal: StoryboardProposal,
    expectedVersion: number,
  ): Promise<StoryboardProposal>;
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
  claimNext(
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
}

export interface Repositories {
  readonly tenants: TenantRepository;
  readonly projects: ProjectRepository;
  readonly storyboards: StoryboardRepository;
  readonly shots: ShotRepository;
  readonly attempts: AttemptRepository;
  readonly artifacts: ArtifactRepository;
  readonly evaluations: EvaluationRepository;
  readonly workflowVersions: WorkflowVersionRepository;
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
  budget_microusd: string | number;
  spent_microusd: string | number;
  version: number;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
}

interface StoryboardRow extends QueryResultRow {
  id: string;
  project_id: string;
  revision: number;
  status: string;
  shot_definitions: unknown;
  total_duration_seconds: string | number;
  duration_tolerance_seconds: string | number;
  version: number;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
}

interface ShotRow extends QueryResultRow {
  id: string;
  project_id: string;
  storyboard_proposal_id: string;
  ordinal: number;
  purpose: string;
  prompt: string;
  duration_seconds: string | number;
  mode: string;
  quality_tier: string;
  status: string;
  accepted_attempt_id: string | null;
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

interface WorkflowVersionRow extends QueryResultRow {
  id: string;
  version: string;
  workflow_hash: string;
  workflow_json: unknown;
  created_at: DatabaseTimestamp;
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

function parseShotDefinitions(value: unknown): StoryboardProposal['shots'] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new DomainError(
      'INVALID_STORYBOARD',
      'Stored storyboard shots are invalid.',
    );
  }
  return parsed.map((candidate: unknown) => {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new DomainError(
        'INVALID_SHOT',
        'Stored storyboard shot is invalid.',
      );
    }
    const valueRecord = candidate as Record<string, unknown>;
    const ordinal = valueRecord.ordinal;
    if (ordinal !== 1 && ordinal !== 2 && ordinal !== 3) {
      throw new DomainError('INVALID_SHOT', 'Stored shot ordinal is invalid.');
    }
    if (
      typeof valueRecord.purpose !== 'string' ||
      typeof valueRecord.prompt !== 'string' ||
      typeof valueRecord.durationSeconds !== 'number' ||
      valueRecord.mode !== 't2v' ||
      valueRecord.qualityTier !== 'preview'
    ) {
      throw new DomainError(
        'INVALID_SHOT',
        'Stored storyboard shot is invalid.',
      );
    }
    return {
      ordinal,
      purpose: valueRecord.purpose,
      prompt: valueRecord.prompt,
      durationSeconds: valueRecord.durationSeconds,
      mode: 't2v',
      qualityTier: 'preview',
    };
  });
}

function mapProject(row: ProjectRow): VideoProject {
  return {
    id: assertUuid(row.id),
    tenantId: assertUuid(row.tenant_id),
    title: row.title,
    brief: row.brief,
    status: parseProjectStatus(row.status),
    targetDurationSeconds: databaseNumber(row.target_duration_seconds),
    budgetMicrousd: assertMicrousd(databaseNumber(row.budget_microusd)),
    spentMicrousd: assertMicrousd(databaseNumber(row.spent_microusd)),
    version: row.version,
    createdAt: databaseTimestamp(row.created_at) as VideoProject['createdAt'],
    updatedAt: databaseTimestamp(row.updated_at) as VideoProject['updatedAt'],
  };
}

function mapStoryboard(row: StoryboardRow): StoryboardProposal {
  return {
    id: assertUuid(row.id),
    projectId: assertUuid(row.project_id),
    revision: row.revision,
    status: parseStoryboardStatus(row.status),
    shots: parseShotDefinitions(row.shot_definitions),
    totalDurationSeconds: databaseNumber(row.total_duration_seconds),
    durationToleranceSeconds: databaseNumber(row.duration_tolerance_seconds),
    version: row.version,
    createdAt: databaseTimestamp(
      row.created_at,
    ) as StoryboardProposal['createdAt'],
    updatedAt: databaseTimestamp(
      row.updated_at,
    ) as StoryboardProposal['updatedAt'],
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
  const shot: Shot = {
    id: assertUuid(row.id),
    projectId: assertUuid(row.project_id),
    storyboardProposalId: assertUuid(row.storyboard_proposal_id),
    ordinal: shotOrdinal(row.ordinal),
    purpose: row.purpose,
    prompt: row.prompt,
    durationSeconds: databaseNumber(row.duration_seconds),
    mode: 't2v',
    qualityTier: 'preview',
    status: parseShotStatus(row.status),
    version: row.version,
    createdAt: databaseTimestamp(row.created_at) as Shot['createdAt'],
    updatedAt: databaseTimestamp(row.updated_at) as Shot['updatedAt'],
  };
  if (acceptedAttemptId) {
    return { ...shot, acceptedAttemptId };
  }
  return shot;
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

function mapEvent(row: EventRow): DomainEvent {
  const projectId = row.project_id ? assertUuid(row.project_id) : undefined;
  const shotId = row.shot_id ? assertUuid(row.shot_id) : undefined;
  const attemptId = row.attempt_id ? assertUuid(row.attempt_id) : undefined;
  const promptId = row.prompt_id ?? undefined;
  const traceId = row.trace_id ?? undefined;
  const event: DomainEvent = {
    id: assertUuid(row.id),
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
        budget_microusd, spent_microusd, version, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        project.id,
        project.tenantId,
        project.title,
        project.brief,
        project.status,
        project.targetDurationSeconds,
        project.budgetMicrousd,
        project.spentMicrousd,
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
           version = $7,
           updated_at = $8
       WHERE id = $9 AND tenant_id = $10 AND version = $11
       RETURNING *`,
      [
        project.title,
        project.brief,
        project.status,
        project.targetDurationSeconds,
        project.budgetMicrousd,
        project.spentMicrousd,
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

class PostgresStoryboardRepository implements StoryboardRepository {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async create(proposal: StoryboardProposal): Promise<void> {
    await this.executor.query(
      `INSERT INTO storyboard_proposals (
        id, project_id, revision, status, shot_definitions,
        total_duration_seconds, duration_tolerance_seconds, version,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
      [
        proposal.id,
        proposal.projectId,
        proposal.revision,
        proposal.status,
        databaseJson(proposal.shots),
        proposal.totalDurationSeconds,
        proposal.durationToleranceSeconds,
        proposal.version,
        proposal.createdAt,
        proposal.updatedAt,
      ],
    );
  }

  async findById(
    projectId: Uuid,
    proposalId: Uuid,
  ): Promise<StoryboardProposal | null> {
    const result = await this.executor.query<StoryboardRow>(
      'SELECT * FROM storyboard_proposals WHERE project_id = $1 AND id = $2',
      [projectId, proposalId],
    );
    const row = result.rows[0];
    return row ? mapStoryboard(row) : null;
  }

  async findLatest(projectId: Uuid): Promise<StoryboardProposal | null> {
    const result = await this.executor.query<StoryboardRow>(
      `SELECT * FROM storyboard_proposals
       WHERE project_id = $1
       ORDER BY revision DESC
       LIMIT 1`,
      [projectId],
    );
    const row = result.rows[0];
    return row ? mapStoryboard(row) : null;
  }

  async update(
    proposal: StoryboardProposal,
    expectedVersion: number,
  ): Promise<StoryboardProposal> {
    const result = await this.executor.query<StoryboardRow>(
      `UPDATE storyboard_proposals
       SET status = $1,
           shot_definitions = $2::jsonb,
           total_duration_seconds = $3,
           duration_tolerance_seconds = $4,
           version = $5,
           updated_at = $6
       WHERE id = $7 AND project_id = $8 AND version = $9
       RETURNING *`,
      [
        proposal.status,
        databaseJson(proposal.shots),
        proposal.totalDurationSeconds,
        proposal.durationToleranceSeconds,
        proposal.version,
        proposal.updatedAt,
        proposal.id,
        proposal.projectId,
        expectedVersion,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new RepositoryError(
        'OPTIMISTIC_CONFLICT',
        'The storyboard was modified by another transaction.',
      );
    }
    return mapStoryboard(row);
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
          id, project_id, storyboard_proposal_id, ordinal, purpose, prompt,
          duration_seconds, mode, quality_tier, status, accepted_attempt_id,
          version, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          shot.id,
          shot.projectId,
          shot.storyboardProposalId,
          shot.ordinal,
          shot.purpose,
          shot.prompt,
          shot.durationSeconds,
          shot.mode,
          shot.qualityTier,
          shot.status,
          shot.acceptedAttemptId ?? null,
          shot.version,
          shot.createdAt,
          shot.updatedAt,
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
       SET status = $1,
           accepted_attempt_id = $2,
           version = $3,
           updated_at = $4
       WHERE id = $5 AND project_id = $6 AND version = $7
       RETURNING *`,
      [
        shot.status,
        shot.acceptedAttemptId ?? null,
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
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29,
        $30, $31
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
           workflow_version_id = $2,
           workflow_hash = $3,
           correlation_id = $4,
           trace_id = $5,
           scenario = $6,
           comfy_prompt_id = $7,
           lease_owner = $8,
           lease_expires_at = $9,
           submitted_at = $10,
           finished_at = $11,
           compute_seconds = $12,
           estimated_cost_microusd = $13,
           failure_code = $14,
           failure_message = $15,
           source_attempt_id = $16,
           artifact_id = $17,
           version = $18,
           updated_at = $19
       WHERE id = $20 AND tenant_id = $21 AND version = $22
       RETURNING *`,
      [
        attempt.status,
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
       SET status = 'queued',
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
         AND status IN ('claimed', 'submitting', 'submitted', 'running', 'generated', 'evaluating')
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
}

function createPostgresRepositories(executor: SqlExecutor): Repositories {
  return {
    tenants: new PostgresTenantRepository(executor),
    projects: new PostgresProjectRepository(executor),
    storyboards: new PostgresStoryboardRepository(executor),
    shots: new PostgresShotRepository(executor),
    attempts: new PostgresAttemptRepository(executor),
    artifacts: new PostgresArtifactRepository(executor),
    evaluations: new PostgresEvaluationRepository(executor),
    workflowVersions: new PostgresWorkflowVersionRepository(executor),
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
  readonly storyboards: Map<Uuid, StoryboardProposal>;
  readonly shots: Map<Uuid, Shot>;
  readonly attempts: Map<Uuid, GenerationAttempt>;
  readonly artifacts: Map<Uuid, ArtifactRecord>;
  readonly evaluations: Map<Uuid, EvaluationResult>;
  readonly workflowVersions: Map<Uuid, WorkflowVersionRecord>;
  readonly events: Map<Uuid, DomainEvent>;
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
    storyboards: new Map(),
    shots: new Map(),
    attempts: new Map(),
    artifacts: new Map(),
    evaluations: new Map(),
    workflowVersions: new Map(),
    events: new Map(),
    outbox: new Map(),
    idempotency: new Map(),
  };
}

function cloneMemoryState(state: MemoryState): MemoryState {
  return {
    tenants: new Map(state.tenants),
    projects: new Map(state.projects),
    storyboards: new Map(
      [...state.storyboards].map(([id, proposal]) => [
        id,
        { ...proposal, shots: [...proposal.shots] },
      ]),
    ),
    shots: new Map([...state.shots].map(([id, shot]) => [id, { ...shot }])),
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
    workflowVersions: new Map(
      [...state.workflowVersions].map(([id, version]) => [
        id,
        { ...version, workflowJson: { ...version.workflowJson } },
      ]),
    ),
    events: new Map(
      [...state.events].map(([id, event]) => [
        id,
        { ...event, payload: { ...event.payload } },
      ]),
    ),
    outbox: new Map(
      [...state.outbox].map(([id, message]) => [id, { ...message }]),
    ),
    idempotency: new Map(
      [...state.idempotency].map(([id, record]) => [id, { ...record }]),
    ),
  };
}

function memoryIdempotencyKey(tenantId: Uuid, key: string): string {
  return `${tenantId}:${key}`;
}

class MemoryRepositories implements Repositories {
  readonly tenants: TenantRepository;
  readonly projects: ProjectRepository;
  readonly storyboards: StoryboardRepository;
  readonly shots: ShotRepository;
  readonly attempts: AttemptRepository;
  readonly artifacts: ArtifactRepository;
  readonly evaluations: EvaluationRepository;
  readonly workflowVersions: WorkflowVersionRepository;
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
    this.storyboards = {
      create: async (proposal) => {
        if (this.state.storyboards.has(proposal.id)) {
          throw new RepositoryError(
            'UNIQUE_VIOLATION',
            'Storyboard already exists.',
          );
        }
        if (
          [...this.state.storyboards.values()].some(
            (current) =>
              current.projectId === proposal.projectId &&
              current.revision === proposal.revision,
          )
        ) {
          throw new RepositoryError(
            'UNIQUE_VIOLATION',
            'Storyboard revision already exists.',
          );
        }
        this.state.storyboards.set(proposal.id, {
          ...proposal,
          shots: [...proposal.shots],
        });
      },
      findById: async (projectId, proposalId) => {
        const proposal = this.state.storyboards.get(proposalId);
        return proposal && proposal.projectId === projectId
          ? { ...proposal, shots: [...proposal.shots] }
          : null;
      },
      findLatest: async (projectId) => {
        const proposals = [...this.state.storyboards.values()]
          .filter((proposal) => proposal.projectId === projectId)
          .sort((left, right) => right.revision - left.revision);
        const proposal = proposals[0];
        return proposal ? { ...proposal, shots: [...proposal.shots] } : null;
      },
      update: async (proposal, expectedVersion) => {
        const current = this.state.storyboards.get(proposal.id);
        if (!current || current.version !== expectedVersion) {
          throw new RepositoryError(
            'OPTIMISTIC_CONFLICT',
            'The storyboard was modified by another transaction.',
          );
        }
        this.state.storyboards.set(proposal.id, {
          ...proposal,
          shots: [...proposal.shots],
        });
        return { ...proposal, shots: [...proposal.shots] };
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
          this.state.shots.set(shot.id, { ...shot });
        }
      },
      listByProject: async (projectId) =>
        [...this.state.shots.values()]
          .filter((shot) => shot.projectId === projectId)
          .sort((left, right) => left.ordinal - right.ordinal)
          .map((shot) => ({ ...shot })),
      findById: async (projectId, shotId) => {
        const shot = this.state.shots.get(shotId);
        return shot && shot.projectId === projectId ? { ...shot } : null;
      },
      findByIdAny: async (shotId) => {
        const shot = this.state.shots.get(shotId);
        return shot ? { ...shot } : null;
      },
      update: async (shot, expectedVersion) => {
        const current = this.state.shots.get(shot.id);
        if (!current || current.version !== expectedVersion) {
          throw new RepositoryError(
            'OPTIMISTIC_CONFLICT',
            'The shot was modified by another transaction.',
          );
        }
        this.state.shots.set(shot.id, { ...shot });
        return { ...shot };
      },
    };
    this.attempts = {
      create: async (attempt) => {
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
        this.state.attempts.set(attempt.id, { ...attempt });
        return { ...attempt };
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
          status: 'queued',
          version: current.version + 1,
          updatedAt: updatedAt as GenerationAttempt['updatedAt'],
        };
        this.state.attempts.set(attemptId, released);
        return { ...released };
      },
      recoverStale: async (now) => {
        const activeStatuses = new Set([
          'claimed',
          'submitting',
          'submitted',
          'running',
          'generated',
          'evaluating',
        ]);
        const recovered: GenerationAttempt[] = [];
        for (const current of this.state.attempts.values()) {
          if (
            !current.leaseExpiresAt ||
            current.leaseExpiresAt >= now ||
            !activeStatuses.has(current.status)
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
          payload: { ...event.payload },
        });
      },
      listByProject: async (projectId) =>
        [...this.state.events.values()]
          .filter((event) => event.projectId === projectId)
          .map((event) => ({ ...event, payload: { ...event.payload } })),
      listOrphans: async (tenantId) =>
        [...this.state.events.values()]
          .filter(
            (event) =>
              event.tenantId === tenantId &&
              event.projectId === undefined &&
              event.type === 'orphan.event',
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
  consume(message: OutboxMessage): Promise<void>;
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
        await this.consumer.consume(message);
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
