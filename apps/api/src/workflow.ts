import { createHash } from 'node:crypto';
import {
  assertUuid,
  createDomainEvent,
  systemClock,
  systemIdGenerator,
  toIsoUtc,
  type Clock,
  type IdGenerator,
  type Uuid,
} from '@h3/domain';
import type {
  Repositories,
  TransactionalStore,
  WorkflowDraftRecord,
  WorkflowRevisionRecord,
  WorkflowRevisionSource,
} from '@h3/db';
import { RepositoryError } from '@h3/db';
import {
  canonicalizeJson,
  hashWorkflowExecutionEnvelope,
  jsonByteLength,
  MINIMAX_H3_PROFILE_ID,
  MINIMAX_H3_PROFILE_VERSION,
  validateMinimaxH3T2vaPreview,
  type MinimaxH3ValidationResult,
} from '@h3/workflow-compiler';
import type { AgentTelemetry, MetricsRegistry } from '@h3/telemetry';

export type WorkflowGraph = Readonly<Record<string, unknown>>;

export type WorkflowApplicationErrorCode =
  | 'WORKFLOW_PROJECT_NOT_FOUND'
  | 'WORKFLOW_SHOT_NOT_FOUND'
  | 'WORKFLOW_DRAFT_NOT_FOUND'
  | 'WORKFLOW_REVISION_NOT_FOUND'
  | 'WORKFLOW_SCOPE_VIOLATION'
  | 'WORKFLOW_IDEMPOTENCY_CONFLICT'
  | 'WORKFLOW_MUTATION_IN_PROGRESS'
  | 'WORKFLOW_IDEMPOTENCY_STATE_INVALID'
  | 'INVALID_MUTATION_KEY'
  | 'PROFILE_UNSUPPORTED'
  | 'INVALID_WORKFLOW_GRAPH'
  | 'INVALID_DRAFT_VERSION';

export class WorkflowApplicationError extends Error {
  readonly code: WorkflowApplicationErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: WorkflowApplicationErrorCode,
    message: string,
    status = 409,
    retryable = false,
  ) {
    super(message);
    this.name = 'WorkflowApplicationError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface WorkflowCapabilityProvider {
  getObjectInfo(): Promise<unknown>;
}

export interface WorkflowApplicationServiceOptions {
  readonly store: TransactionalStore;
  readonly tenantId: Uuid;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly executor?: WorkflowCapabilityProvider;
  readonly requireExecutor?: boolean;
  readonly telemetry?: AgentTelemetry;
  readonly metrics?: MetricsRegistry;
}

export interface CreateWorkflowDraftCommand {
  readonly idempotencyKey: string;
  readonly traceId?: string;
  readonly editorGraphJson: WorkflowGraph;
  readonly lastApiGraphJson?: WorkflowGraph | null;
  readonly baseRevisionId?: Uuid | null;
  readonly profileId?: string;
  readonly profileVersion?: string;
  readonly authorType: string;
  readonly authorId: string;
}

export interface UpdateWorkflowDraftCommand extends CreateWorkflowDraftCommand {
  readonly expectedVersion: number;
}

export interface SaveWorkflowDraftCommand extends CreateWorkflowDraftCommand {
  readonly expectedVersion?: number;
}

export interface CreateWorkflowRevisionCommand {
  readonly idempotencyKey: string;
  readonly traceId?: string;
  readonly editorGraphJson: WorkflowGraph;
  readonly apiGraphJson: WorkflowGraph;
  readonly parentRevisionId?: Uuid | null;
  readonly profileId?: string;
  readonly profileVersion?: string;
  readonly source?: WorkflowRevisionSource;
  readonly frontendVersion?: string;
  readonly frontendCommit?: string;
  readonly authorType: string;
  readonly authorId: string;
  /** Used by deterministic tests; production callers use the capability provider. */
  readonly executorObjectInfo?: unknown;
}

export interface WorkflowRevisionValidationResult {
  readonly revision: WorkflowRevisionRecord;
  readonly validation: MinimaxH3ValidationResult;
}

const MAX_WORKFLOW_JSON_BYTES = 1_048_576;
const MAX_PERSISTED_VALIDATION_ERRORS = 32;
const APPLICATION_MUTATION_OPERATION_PREFIX = 'workflow-application.';

function isPlainRecord(value: unknown): value is WorkflowGraph {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function graphWithBoundedJson(value: unknown, label: string): WorkflowGraph {
  if (!isPlainRecord(value)) {
    throw new WorkflowApplicationError(
      'INVALID_WORKFLOW_GRAPH',
      `${label} must be a JSON object.`,
      422,
    );
  }
  try {
    if (jsonByteLength(value) > MAX_WORKFLOW_JSON_BYTES) {
      throw new WorkflowApplicationError(
        'INVALID_WORKFLOW_GRAPH',
        `${label} exceeds the stored JSON size limit.`,
        422,
      );
    }
    // Force a complete JSON walk before opening a revision. This prevents an
    // invalid value such as undefined or NaN from reaching a repository.
    canonicalizeJson(value);
  } catch (error) {
    if (error instanceof WorkflowApplicationError) throw error;
    throw new WorkflowApplicationError(
      'INVALID_WORKFLOW_GRAPH',
      `${label} contains a non-JSON value.`,
      422,
    );
  }
  return value;
}

function optionalUuid(value: Uuid | null | undefined): Uuid | undefined {
  return value === null || value === undefined ? undefined : assertUuid(value);
}

function optionalGraph(
  value: WorkflowGraph | null | undefined,
  label: string,
): WorkflowGraph | undefined {
  return value === null || value === undefined
    ? undefined
    : graphWithBoundedJson(value, label);
}

interface WorkflowMutationReservation {
  readonly key: string;
  readonly replayResourceId?: Uuid;
  readonly replayBody?: unknown;
}

function boundedMutationKey(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new WorkflowApplicationError(
      'INVALID_MUTATION_KEY',
      'Workflow mutations require a bounded idempotency key.',
      422,
    );
  }
  return value;
}

function mutationRequestHash(value: unknown): string {
  return createHash('sha256')
    .update(canonicalizeJson(value), 'utf8')
    .digest('hex');
}

function resourceMutationKey(operation: string, key: string): string {
  return `workflow-resource-${createHash('sha256')
    .update(`${operation}\u0000${key}`, 'utf8')
    .digest('hex')}`;
}

async function reserveApplicationMutation(
  repositories: Repositories,
  tenantId: Uuid,
  operation: string,
  idempotencyKey: string,
  request: unknown,
  createdAt: string,
): Promise<WorkflowMutationReservation> {
  const key = boundedMutationKey(idempotencyKey);
  const reservation = await repositories.idempotency.reserve(
    tenantId,
    key,
    `${APPLICATION_MUTATION_OPERATION_PREFIX}${operation}`,
    mutationRequestHash(request),
    createdAt,
  );
  if (reservation.kind === 'reserved') return { key };
  if (reservation.kind === 'replay') {
    const body = reservation.body;
    if (!isPlainRecord(body) || typeof body.resourceId !== 'string') {
      throw new WorkflowApplicationError(
        'WORKFLOW_IDEMPOTENCY_STATE_INVALID',
        'The stored workflow idempotency result is invalid.',
        500,
      );
    }
    try {
      return {
        key,
        replayResourceId: assertUuid(body.resourceId),
        replayBody: body,
      };
    } catch {
      throw new WorkflowApplicationError(
        'WORKFLOW_IDEMPOTENCY_STATE_INVALID',
        'The stored workflow idempotency result has an invalid resource ID.',
        500,
      );
    }
  }
  if (reservation.kind === 'conflict') {
    throw new WorkflowApplicationError(
      'WORKFLOW_IDEMPOTENCY_CONFLICT',
      'The idempotency key was already used for a different workflow mutation.',
      409,
    );
  }
  throw new WorkflowApplicationError(
    'WORKFLOW_MUTATION_IN_PROGRESS',
    'The workflow mutation is already in progress.',
    409,
    true,
  );
}

async function completeApplicationMutation(
  repositories: Repositories,
  tenantId: Uuid,
  reservation: WorkflowMutationReservation,
  resourceId: Uuid,
  completedAt: string,
  extraBody?: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (reservation.replayResourceId) return;
  await repositories.idempotency.complete(
    tenantId,
    reservation.key,
    200,
    { resourceId, ...(extraBody ?? {}) },
    completedAt,
  );
}

async function releaseApplicationMutation(
  repositories: Repositories,
  tenantId: Uuid,
  reservation: WorkflowMutationReservation,
): Promise<void> {
  if (reservation.replayResourceId) return;
  try {
    await repositories.idempotency.release(tenantId, reservation.key);
  } catch {
    // PostgreSQL rolls the reservation back with an aborted transaction.
  }
}

function replayResourceError(): WorkflowApplicationError {
  return new WorkflowApplicationError(
    'WORKFLOW_IDEMPOTENCY_STATE_INVALID',
    'The stored workflow idempotency result points to a missing resource.',
    500,
  );
}

export class WorkflowApplicationService {
  readonly store: TransactionalStore;
  readonly tenantId: Uuid;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly executor: WorkflowCapabilityProvider | undefined;
  readonly requireExecutor: boolean;
  readonly telemetry: AgentTelemetry | undefined;
  readonly metrics: MetricsRegistry | undefined;

  constructor(options: WorkflowApplicationServiceOptions) {
    this.store = options.store;
    this.tenantId = options.tenantId;
    this.clock = options.clock ?? systemClock;
    this.idGenerator = options.idGenerator ?? systemIdGenerator;
    this.executor = options.executor;
    this.requireExecutor = options.requireExecutor ?? false;
    this.telemetry = options.telemetry;
    this.metrics = options.metrics;
  }

  withTransaction<Result>(
    work: (repositories: Repositories) => Promise<Result>,
  ): Promise<Result> {
    return this.store.withTransaction(work);
  }

  async getWorkflowDraft(
    projectId: Uuid,
    shotId: Uuid,
  ): Promise<WorkflowDraftRecord | null> {
    return this.store.withTransaction(async (repositories) => {
      await this.requireShotScope(repositories, projectId, shotId);
      return repositories.workflowDrafts.findByShot(
        this.tenantId,
        projectId,
        shotId,
      );
    });
  }

  async createWorkflowDraft(
    projectId: Uuid,
    shotId: Uuid,
    command: CreateWorkflowDraftCommand,
  ): Promise<WorkflowDraftRecord> {
    return this.store.withTransaction((repositories) =>
      this.createWorkflowDraftInTransaction(
        repositories,
        projectId,
        shotId,
        command,
      ),
    );
  }

  async createWorkflowDraftInTransaction(
    repositories: Repositories,
    projectId: Uuid,
    shotId: Uuid,
    command: CreateWorkflowDraftCommand,
  ): Promise<WorkflowDraftRecord> {
    await this.requireShotScope(repositories, projectId, shotId);
    const profile = this.profile(command.profileId, command.profileVersion);
    const editorGraphJson = graphWithBoundedJson(
      command.editorGraphJson,
      'Workflow draft editor graph',
    );
    const lastApiGraphJson = optionalGraph(
      command.lastApiGraphJson,
      'Workflow draft API graph',
    );
    const baseRevisionId = optionalUuid(command.baseRevisionId);
    if (baseRevisionId) {
      await this.requireRevision(
        repositories,
        projectId,
        shotId,
        baseRevisionId,
        'Workflow draft base revision is outside its shot scope.',
      );
    }
    const now = toIsoUtc(this.clock.now());
    const reservation = await reserveApplicationMutation(
      repositories,
      this.tenantId,
      'draft.create',
      command.idempotencyKey,
      {
        projectId,
        shotId,
        profileId: profile.profileId,
        profileVersion: profile.profileVersion,
        editorGraphJson,
        lastApiGraphJson: lastApiGraphJson ?? null,
        baseRevisionId: baseRevisionId ?? null,
        authorType: command.authorType,
        authorId: command.authorId,
      },
      now,
    );
    if (reservation.replayResourceId) {
      const existing = await repositories.workflowDrafts.findByShot(
        this.tenantId,
        projectId,
        shotId,
      );
      if (!existing || existing.id !== reservation.replayResourceId) {
        throw replayResourceError();
      }
      return existing;
    }
    const draft: WorkflowDraftRecord = {
      id: this.idGenerator.next(),
      tenantId: this.tenantId,
      projectId,
      shotId,
      ...(baseRevisionId ? { baseRevisionId } : {}),
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      editorGraphJson,
      ...(lastApiGraphJson ? { lastApiGraphJson } : {}),
      authorType: command.authorType,
      authorId: command.authorId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    try {
      const created = await repositories.workflowDrafts.create(
        draft,
        resourceMutationKey('draft.create', reservation.key),
      );
      await completeApplicationMutation(
        repositories,
        this.tenantId,
        reservation,
        created.id,
        now,
      );
      return created;
    } catch (error) {
      await releaseApplicationMutation(
        repositories,
        this.tenantId,
        reservation,
      );
      throw error;
    }
  }

  async updateWorkflowDraft(
    projectId: Uuid,
    shotId: Uuid,
    command: UpdateWorkflowDraftCommand,
  ): Promise<WorkflowDraftRecord> {
    return this.store.withTransaction((repositories) =>
      this.updateWorkflowDraftInTransaction(
        repositories,
        projectId,
        shotId,
        command,
      ),
    );
  }

  async updateWorkflowDraftInTransaction(
    repositories: Repositories,
    projectId: Uuid,
    shotId: Uuid,
    command: UpdateWorkflowDraftCommand,
  ): Promise<WorkflowDraftRecord> {
    await this.requireShotScope(repositories, projectId, shotId);
    if (
      !Number.isSafeInteger(command.expectedVersion) ||
      command.expectedVersion < 1
    ) {
      throw new WorkflowApplicationError(
        'INVALID_DRAFT_VERSION',
        'Workflow draft expectedVersion must be a positive safe integer.',
        422,
      );
    }
    const current = await repositories.workflowDrafts.findByShot(
      this.tenantId,
      projectId,
      shotId,
    );
    if (!current) {
      throw new WorkflowApplicationError(
        'WORKFLOW_DRAFT_NOT_FOUND',
        'The workflow draft was not found.',
        404,
      );
    }
    const profile = this.profile(
      command.profileId ?? current.profileId,
      command.profileVersion ?? current.profileVersion,
    );
    const editorGraphJson = graphWithBoundedJson(
      command.editorGraphJson,
      'Workflow draft editor graph',
    );
    const lastApiGraphJson = optionalGraph(
      command.lastApiGraphJson,
      'Workflow draft API graph',
    );
    const baseRevisionId = optionalUuid(
      command.baseRevisionId === undefined
        ? current.baseRevisionId
        : command.baseRevisionId,
    );
    if (baseRevisionId) {
      await this.requireRevision(
        repositories,
        projectId,
        shotId,
        baseRevisionId,
        'Workflow draft base revision is outside its shot scope.',
      );
    }
    const updatedAt = toIsoUtc(this.clock.now());
    const {
      baseRevisionId: _currentBaseRevisionId,
      lastApiGraphJson: _currentLastApiGraphJson,
      ...currentWithoutMutableGraphReferences
    } = current;
    const draft: WorkflowDraftRecord = {
      ...currentWithoutMutableGraphReferences,
      ...(baseRevisionId ? { baseRevisionId } : {}),
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      editorGraphJson,
      ...(lastApiGraphJson ? { lastApiGraphJson } : {}),
      authorType: command.authorType,
      authorId: command.authorId,
      version: current.version + 1,
      updatedAt,
    };
    const reservation = await reserveApplicationMutation(
      repositories,
      this.tenantId,
      'draft.update',
      command.idempotencyKey,
      {
        draftId: current.id,
        projectId,
        shotId,
        expectedVersion: command.expectedVersion,
        profileId: profile.profileId,
        profileVersion: profile.profileVersion,
        editorGraphJson,
        lastApiGraphJson: lastApiGraphJson ?? null,
        baseRevisionId: baseRevisionId ?? null,
        authorType: command.authorType,
        authorId: command.authorId,
      },
      updatedAt,
    );
    if (reservation.replayResourceId) {
      const existing = await repositories.workflowDrafts.findByShot(
        this.tenantId,
        projectId,
        shotId,
      );
      if (!existing || existing.id !== reservation.replayResourceId) {
        throw replayResourceError();
      }
      return existing;
    }
    try {
      const update = lastApiGraphJson
        ? draft
        : (() => {
            const { lastApiGraphJson: _lastApiGraphJson, ...withoutApiGraph } =
              draft;
            return withoutApiGraph;
          })();
      const updated = await repositories.workflowDrafts.update(
        update,
        command.expectedVersion,
        resourceMutationKey('draft.update', reservation.key),
      );
      await completeApplicationMutation(
        repositories,
        this.tenantId,
        reservation,
        updated.id,
        updatedAt,
      );
      return updated;
    } catch (error) {
      await releaseApplicationMutation(
        repositories,
        this.tenantId,
        reservation,
      );
      throw error;
    }
  }

  async saveWorkflowDraft(
    projectId: Uuid,
    shotId: Uuid,
    command: SaveWorkflowDraftCommand,
  ): Promise<WorkflowDraftRecord> {
    return this.store.withTransaction((repositories) =>
      this.saveWorkflowDraftInTransaction(
        repositories,
        projectId,
        shotId,
        command,
      ),
    );
  }

  async saveWorkflowDraftInTransaction(
    repositories: Repositories,
    projectId: Uuid,
    shotId: Uuid,
    command: SaveWorkflowDraftCommand,
  ): Promise<WorkflowDraftRecord> {
    const current = await repositories.workflowDrafts.findByShot(
      this.tenantId,
      projectId,
      shotId,
    );
    if (!current) {
      return this.createWorkflowDraftInTransaction(
        repositories,
        projectId,
        shotId,
        command,
      );
    }
    if (command.expectedVersion === undefined) {
      // Re-run the create path so an identical retry of the initial PUT can
      // replay its application idempotency result. A new key against an
      // existing draft is still an optimistic-version error.
      try {
        return await this.createWorkflowDraftInTransaction(
          repositories,
          projectId,
          shotId,
          command,
        );
      } catch (error) {
        if (
          error instanceof RepositoryError &&
          error.code === 'UNIQUE_VIOLATION'
        ) {
          throw new WorkflowApplicationError(
            'INVALID_DRAFT_VERSION',
            'Updating an existing workflow draft requires expectedVersion.',
            422,
          );
        }
        throw error;
      }
    }
    return this.updateWorkflowDraftInTransaction(
      repositories,
      projectId,
      shotId,
      command as UpdateWorkflowDraftCommand,
    );
  }

  async getWorkflowRevision(
    projectId: Uuid,
    shotId: Uuid,
    revisionId: Uuid,
  ): Promise<WorkflowRevisionRecord | null> {
    return this.store.withTransaction(async (repositories) => {
      await this.requireShotScope(repositories, projectId, shotId);
      return repositories.workflowRevisions.findById(
        this.tenantId,
        projectId,
        shotId,
        revisionId,
      );
    });
  }

  async getWorkflowRevisionById(
    revisionId: Uuid,
  ): Promise<WorkflowRevisionRecord | null> {
    return this.store.withTransaction((repositories) =>
      repositories.workflowRevisions.findByIdAny(this.tenantId, revisionId),
    );
  }

  async listWorkflowRevisions(
    projectId: Uuid,
    shotId: Uuid,
  ): Promise<readonly WorkflowRevisionRecord[]> {
    return this.store.withTransaction(async (repositories) => {
      await this.requireShotScope(repositories, projectId, shotId);
      return repositories.workflowRevisions.listByShot(
        this.tenantId,
        projectId,
        shotId,
      );
    });
  }

  async createWorkflowRevision(
    projectId: Uuid,
    shotId: Uuid,
    command: CreateWorkflowRevisionCommand,
  ): Promise<WorkflowRevisionValidationResult> {
    return this.store.withTransaction((repositories) =>
      this.createWorkflowRevisionInTransaction(
        repositories,
        projectId,
        shotId,
        command,
      ),
    );
  }

  async createWorkflowRevisionInTransaction(
    repositories: Repositories,
    projectId: Uuid,
    shotId: Uuid,
    command: CreateWorkflowRevisionCommand,
  ): Promise<WorkflowRevisionValidationResult> {
    await this.requireShotScope(repositories, projectId, shotId);
    const profileId = command.profileId ?? MINIMAX_H3_PROFILE_ID;
    const profileVersion = command.profileVersion ?? MINIMAX_H3_PROFILE_VERSION;
    const editorGraphJson = graphWithBoundedJson(
      command.editorGraphJson,
      'Workflow revision editor graph',
    );
    const apiGraphJson = graphWithBoundedJson(
      command.apiGraphJson,
      'Workflow revision API graph',
    );
    const parentRevisionId = optionalUuid(command.parentRevisionId);
    if (parentRevisionId) {
      await this.requireRevision(
        repositories,
        projectId,
        shotId,
        parentRevisionId,
        'Workflow revision parent is outside its shot scope.',
      );
    }
    const validationStartedAt = Date.now();
    const validation = await this.validateGraphs(
      editorGraphJson,
      apiGraphJson,
      profileId,
      profileVersion,
      command.executorObjectInfo,
    );
    this.observeValidation(validation, validationStartedAt);
    const executionHash = hashWorkflowExecutionEnvelope({
      profileId,
      profileVersion,
      apiGraph: apiGraphJson,
      parameters: validation.executionParameters,
    });
    const now = toIsoUtc(this.clock.now());
    const persistedValidationErrors = validation.errors
      .slice(0, MAX_PERSISTED_VALIDATION_ERRORS)
      .map(({ code, message }) => ({ code, message }));
    const revision: WorkflowRevisionRecord = {
      id: this.idGenerator.next(),
      tenantId: this.tenantId,
      projectId,
      shotId,
      // The repository allocates the authoritative next number transactionally.
      revisionNumber: 1,
      ...(parentRevisionId ? { parentRevisionId } : {}),
      profileId,
      profileVersion,
      source: command.source ?? 'comfy_editor',
      ...(command.frontendVersion
        ? { frontendVersion: command.frontendVersion }
        : {}),
      ...(command.frontendCommit
        ? { frontendCommit: command.frontendCommit }
        : {}),
      authorType: command.authorType,
      authorId: command.authorId,
      editorGraphJson,
      apiGraphJson,
      executionHash,
      executionParametersJson: validation.executionParameters,
      validationStatus:
        validation.errors.length === 0 ? 'validated' : 'invalid',
      validationErrorsJson: persistedValidationErrors,
      validatedAt: now,
      ...(validation.executorFingerprint
        ? { executorFingerprint: validation.executorFingerprint }
        : {}),
      createdAt: now,
    };
    const reservation = await reserveApplicationMutation(
      repositories,
      this.tenantId,
      'revision.create',
      command.idempotencyKey,
      {
        projectId,
        shotId,
        parentRevisionId: parentRevisionId ?? null,
        profileId,
        profileVersion,
        source: command.source ?? 'comfy_editor',
        frontendVersion: command.frontendVersion ?? null,
        frontendCommit: command.frontendCommit ?? null,
        authorType: command.authorType,
        authorId: command.authorId,
        editorGraphJson,
        apiGraphJson,
      },
      now,
    );
    if (reservation.replayResourceId) {
      const existing = await repositories.workflowRevisions.findById(
        this.tenantId,
        projectId,
        shotId,
        reservation.replayResourceId,
      );
      if (!existing) throw replayResourceError();
      const storedBody = reservation.replayBody;
      const storedValidation =
        isPlainRecord(storedBody) && isPlainRecord(storedBody.validation)
          ? (storedBody.validation as unknown as MinimaxH3ValidationResult)
          : validation;
      return { revision: existing, validation: storedValidation };
    }
    try {
      const created = await repositories.workflowRevisions.create(
        revision,
        resourceMutationKey('revision.create', reservation.key),
      );
      this.incrementRevisionMetric(
        created.profileId,
        created.validationStatus,
        created.source,
      );
      if (validation.errors.length > 0) {
        await this.appendValidationEvents(
          repositories,
          projectId,
          shotId,
          created.id,
          validation.errors.map((issue) => issue.code),
          command.traceId,
        );
      }
      await completeApplicationMutation(
        repositories,
        this.tenantId,
        reservation,
        created.id,
        now,
        { validation },
      );
      return { revision: created, validation };
    } catch (error) {
      await releaseApplicationMutation(
        repositories,
        this.tenantId,
        reservation,
      );
      throw error;
    }
  }

  async validateWorkflowRevision(
    projectId: Uuid,
    shotId: Uuid,
    revisionId: Uuid,
    executorObjectInfo?: unknown,
    traceId?: string,
  ): Promise<WorkflowRevisionValidationResult> {
    return this.store.withTransaction((repositories) =>
      this.validateWorkflowRevisionInTransaction(
        repositories,
        projectId,
        shotId,
        revisionId,
        executorObjectInfo,
        traceId,
      ),
    );
  }

  async validateWorkflowRevisionInTransaction(
    repositories: Repositories,
    projectId: Uuid,
    shotId: Uuid,
    revisionId: Uuid,
    executorObjectInfo?: unknown,
    traceId?: string,
  ): Promise<WorkflowRevisionValidationResult> {
    await this.requireShotScope(repositories, projectId, shotId);
    const revision = await this.requireRevision(
      repositories,
      projectId,
      shotId,
      revisionId,
      'The workflow revision was not found.',
    );
    const validationStartedAt = Date.now();
    const validation = await this.validateGraphs(
      revision.editorGraphJson,
      revision.apiGraphJson,
      revision.profileId,
      revision.profileVersion,
      executorObjectInfo,
    );
    this.observeValidation(validation, validationStartedAt);
    const updated = await repositories.workflowRevisions.updateValidation(
      this.tenantId,
      projectId,
      shotId,
      revisionId,
      {
        validationStatus:
          validation.errors.length === 0 ? 'validated' : 'invalid',
        validationErrorsJson: validation.errors
          .slice(0, MAX_PERSISTED_VALIDATION_ERRORS)
          .map(({ code, message }) => ({ code, message })),
        validatedAt: toIsoUtc(this.clock.now()),
        executorFingerprint: validation.executorFingerprint ?? null,
      },
    );
    if (validation.errors.length > 0) {
      await this.appendValidationEvents(
        repositories,
        projectId,
        shotId,
        updated.id,
        validation.errors.map((issue) => issue.code),
        traceId,
      );
    }
    return { revision: updated, validation };
  }

  private async appendValidationEvents(
    repositories: Repositories,
    projectId: Uuid,
    shotId: Uuid,
    revisionId: Uuid,
    validationCodes: readonly string[],
    traceId?: string,
  ): Promise<void> {
    const now = toIsoUtc(this.clock.now());
    const append = async (
      type: 'workflow.revision.invalid' | 'executor.unavailable',
      payload: Readonly<Record<string, unknown>>,
    ): Promise<void> => {
      const event = createDomainEvent({
        id: this.idGenerator.next(),
        type,
        producer: 'h3-workflow',
        tenantId: this.tenantId,
        projectId,
        shotId,
        clock: { now: () => new Date(now) },
        payload,
        ...(traceId ? { traceId } : {}),
      });
      await repositories.events.append(event);
      await repositories.outbox.enqueue(event);
    };
    await append('workflow.revision.invalid', {
      workflowRevisionId: revisionId,
      validationCodes: validationCodes.slice(0, 16),
    });
    if (validationCodes.includes('EXECUTOR_UNAVAILABLE')) {
      await append('executor.unavailable', {
        workflowRevisionId: revisionId,
        reasonCode: 'EXECUTOR_UNAVAILABLE',
      });
    }
  }

  private observeValidation(
    validation: MinimaxH3ValidationResult,
    startedAt: number,
  ): void {
    if (!this.metrics) return;
    try {
      this.metrics.observe(
        'video_workflow_validation_duration_seconds',
        {
          profile_id: MINIMAX_H3_PROFILE_ID,
          result: validation.errors.length === 0 ? 'success' : 'failure',
        },
        Math.max(0, (Date.now() - startedAt) / 1_000),
      );
    } catch {
      // Metrics are diagnostic and cannot change revision persistence.
    }
  }

  private incrementRevisionMetric(
    profileId: string,
    validationStatus: WorkflowRevisionRecord['validationStatus'],
    source: WorkflowRevisionSource,
  ): void {
    if (!this.metrics) return;
    try {
      this.metrics.increment('video_workflow_revisions_total', {
        profile_id: profileId,
        validation_status: validationStatus,
        source,
      });
    } catch {
      // Metrics are diagnostic and cannot change revision persistence.
    }
  }

  private profile(
    profileId: string | undefined,
    profileVersion: string | undefined,
  ): { readonly profileId: string; readonly profileVersion: string } {
    const resolvedProfileId = profileId ?? MINIMAX_H3_PROFILE_ID;
    const resolvedProfileVersion = profileVersion ?? MINIMAX_H3_PROFILE_VERSION;
    if (
      resolvedProfileId !== MINIMAX_H3_PROFILE_ID ||
      resolvedProfileVersion !== MINIMAX_H3_PROFILE_VERSION
    ) {
      throw new WorkflowApplicationError(
        'PROFILE_UNSUPPORTED',
        'Only the pinned MiniMax H3 preview profile is supported.',
        422,
      );
    }
    return {
      profileId: resolvedProfileId,
      profileVersion: resolvedProfileVersion,
    };
  }

  private async validateGraphs(
    editorGraph: WorkflowGraph,
    apiGraph: WorkflowGraph,
    profileId: string,
    profileVersion: string,
    suppliedObjectInfo: unknown,
  ): Promise<MinimaxH3ValidationResult> {
    let objectInfo = suppliedObjectInfo;
    let hasObjectInfo = suppliedObjectInfo !== undefined;
    if (!hasObjectInfo && this.executor) {
      try {
        objectInfo = await this.executor.getObjectInfo();
        hasObjectInfo = true;
      } catch {
        objectInfo = null;
        hasObjectInfo = true;
      }
    }
    return validateMinimaxH3T2vaPreview({
      editorGraph,
      apiGraph,
      profileId,
      profileVersion,
      ...(hasObjectInfo ? { objectInfo } : {}),
      ...(this.requireExecutor ? { requireExecutor: true } : {}),
    });
  }

  private async requireShotScope(
    repositories: Repositories,
    projectId: Uuid,
    shotId: Uuid,
  ): Promise<void> {
    const project = await repositories.projects.findById(
      this.tenantId,
      projectId,
    );
    if (!project) {
      throw new WorkflowApplicationError(
        'WORKFLOW_PROJECT_NOT_FOUND',
        'The requested project was not found.',
        404,
      );
    }
    const shot = await repositories.shots.findById(projectId, shotId);
    if (!shot) {
      throw new WorkflowApplicationError(
        'WORKFLOW_SHOT_NOT_FOUND',
        'The requested shot was not found in the project.',
        404,
      );
    }
  }

  private async requireRevision(
    repositories: Repositories,
    projectId: Uuid,
    shotId: Uuid,
    revisionId: Uuid,
    message: string,
  ): Promise<WorkflowRevisionRecord> {
    const revision = await repositories.workflowRevisions.findById(
      this.tenantId,
      projectId,
      shotId,
      revisionId,
    );
    if (!revision) {
      throw new WorkflowApplicationError(
        message === 'The workflow revision was not found.'
          ? 'WORKFLOW_REVISION_NOT_FOUND'
          : 'WORKFLOW_SCOPE_VIOLATION',
        message,
        message === 'The workflow revision was not found.' ? 404 : 409,
      );
    }
    return revision;
  }
}
