import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import {
  assertMicrousd,
  assertUuid,
  type Clock,
  type DomainEvent,
  DomainError,
  parseDomainEventType,
  parseProjectStatus,
  parseShotStatus,
  parseStoryboardStatus,
  toIsoUtc,
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
  update(shot: Shot, expectedVersion: number): Promise<Shot>;
}

export interface EventRepository {
  append(event: DomainEvent): Promise<void>;
  listByProject(projectId: Uuid): Promise<readonly DomainEvent[]>;
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
