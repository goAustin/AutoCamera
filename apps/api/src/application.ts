import {
  createDomainEvent,
  createShot,
  createVideoProject,
  assertMicrousd,
  assertUuid,
  subtractMicrousd,
  systemClock,
  systemIdGenerator,
  toIsoUtc,
  transitionShot,
  type Clock,
  type DomainEventType,
  type DomainEvent,
  type IdGenerator,
  type MicroUsd,
  type Shot,
  type ShotOrdinal,
  type Uuid,
  type VideoProject,
} from '@h3/domain';
import {
  type Repositories,
  RepositoryError,
  type TransactionalStore,
} from '@h3/db';

export const DEV_TENANT_ID = assertUuid('00000000-0000-7000-8000-000000000001');

export type ApplicationErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'OPTIMISTIC_CONFLICT'
  | 'PERSISTENCE_UNAVAILABLE';

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: ApplicationErrorCode,
    message: string,
    status: number,
    retryable: boolean,
  ) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface ProjectApplicationServiceOptions {
  readonly store: TransactionalStore;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly tenantId?: Uuid;
  readonly defaultBudgetMicrousd: MicroUsd;
  readonly producer?: string;
}

export interface CreateProjectCommand {
  readonly title: string;
  readonly brief: string;
  readonly targetDurationSeconds: number;
  readonly budgetMicrousd: MicroUsd | null;
  readonly initialStatus?: VideoProject['status'];
  readonly autoCreated?: boolean;
  readonly traceId?: string;
}

export interface ProjectCost {
  readonly budgetMicrousd: MicroUsd | null;
  readonly spentMicrousd: MicroUsd;
  readonly remainingMicrousd: MicroUsd | null;
  readonly inferenceCostMicrousd: MicroUsd;
}

export class ProjectApplicationService {
  readonly store: TransactionalStore;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly tenantId: Uuid;
  readonly defaultBudgetMicrousd: MicroUsd;
  readonly producer: string;

  constructor(options: ProjectApplicationServiceOptions) {
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
    this.idGenerator = options.idGenerator ?? systemIdGenerator;
    this.tenantId = options.tenantId ?? DEV_TENANT_ID;
    this.defaultBudgetMicrousd = options.defaultBudgetMicrousd;
    this.producer = options.producer ?? 'h3-api';
  }

  withTransaction<Result>(
    work: (repositories: Repositories) => Promise<Result>,
  ): Promise<Result> {
    return this.store.withTransaction(work);
  }

  async createProject(command: CreateProjectCommand): Promise<VideoProject> {
    return this.store.withTransaction((repositories) =>
      this.createProjectInTransaction(repositories, command),
    );
  }

  async createProjectInTransaction(
    repositories: Repositories,
    command: CreateProjectCommand,
  ): Promise<VideoProject> {
    const now = toIsoUtc(this.clock.now());
    await repositories.tenants.ensure(this.tenantId, 'Development tenant', now);
    const project = createVideoProject({
      id: this.idGenerator.next(),
      tenantId: this.tenantId,
      title: command.title,
      brief: command.brief,
      targetDurationSeconds: command.targetDurationSeconds,
      budgetMicrousd: command.budgetMicrousd,
      ...(command.initialStatus ? { status: command.initialStatus } : {}),
      ...(command.autoCreated ? { autoCreated: true } : {}),
      now,
    });
    await repositories.projects.create(project);
    await this.appendEvent(repositories, {
      type: 'project.created',
      projectId: project.id,
      ...(command.traceId ? { traceId: command.traceId } : {}),
      payload: { status: project.status },
    });
    if (project.status === 'ready_for_generation') {
      await this.appendEvent(repositories, {
        type: 'project.ready_for_generation',
        projectId: project.id,
        ...(command.traceId ? { traceId: command.traceId } : {}),
        payload: { status: project.status },
      });
    }
    return project;
  }

  async getProject(projectId: Uuid): Promise<VideoProject> {
    return this.store.withTransaction((repositories) =>
      this.requireProject(repositories, projectId),
    );
  }

  async listProjects(): Promise<readonly VideoProject[]> {
    return this.store.withTransaction((repositories) =>
      repositories.projects.listByTenant(this.tenantId),
    );
  }

  async listEvents(projectId: Uuid): Promise<readonly DomainEvent[]> {
    return this.store.withTransaction(async (repositories) => {
      await this.requireProject(repositories, projectId);
      return repositories.events.listByProject(projectId);
    });
  }

  async createImplicitShotInTransaction(
    repositories: Repositories,
    projectId: Uuid,
    input: {
      readonly purpose: string;
      readonly prompt: string;
      readonly durationSeconds: number;
      readonly traceId?: string;
    },
  ): Promise<Shot> {
    await this.requireProject(repositories, projectId);
    const existingShots = await repositories.shots.listByProject(projectId);
    // One implicit shot per run, so a project's run count is unbounded. The
    // three-shot limit belongs to storyboard proposals, which are validated
    // separately; it must not cap direct graph-first submissions.
    const ordinal: ShotOrdinal =
      existingShots.reduce(
        (highest, shot) => Math.max(highest, shot.ordinal),
        0,
      ) + 1;
    const now = toIsoUtc(this.clock.now());
    const shot = createShot({
      id: this.idGenerator.next(),
      projectId,
      definition: {
        ordinal,
        purpose: input.purpose,
        prompt: input.prompt,
        durationSeconds: input.durationSeconds,
        mode: 't2v',
        qualityTier: 'preview',
      },
      implicit: true,
      now,
    });
    await repositories.shots.createMany([shot]);
    await this.appendEvent(repositories, {
      type: 'shot.created',
      projectId,
      shotId: shot.id,
      ...(input.traceId ? { traceId: input.traceId } : {}),
      payload: { ordinal: shot.ordinal, status: shot.status, implicit: true },
    });
    return shot;
  }

  // `planning` and `awaiting_storyboard_approval` are not reachable any more --
  // nothing writes them since Phase 7D removed the planner. They stay here, in
  // the domain status union, and in the telemetry label allowlist because the
  // `video_projects_status_check` constraint still permits them and a database
  // seeded before 7D can still hold a row in one. Promoting such a project is
  // the point of this method; dropping the cases would strand it.
  async prepareDirectRunProjectInTransaction(
    repositories: Repositories,
    projectId: Uuid,
    traceId?: string,
  ): Promise<VideoProject> {
    const project = await this.requireProject(repositories, projectId);
    if (
      project.status !== 'draft' &&
      project.status !== 'planning' &&
      project.status !== 'awaiting_storyboard_approval'
    ) {
      return project;
    }
    const now = toIsoUtc(this.clock.now());
    const readyProject: VideoProject = {
      ...project,
      status: 'ready_for_generation',
      version: project.version + 1,
      updatedAt: now,
    };
    await repositories.projects.update(readyProject, project.version);
    await this.appendEvent(repositories, {
      type: 'project.ready_for_generation',
      projectId,
      ...(traceId ? { traceId } : {}),
      payload: { status: readyProject.status, directRun: true },
    });
    return readyProject;
  }

  async getCost(projectId: Uuid): Promise<ProjectCost> {
    return this.store.withTransaction(async (repositories) => {
      const project = await this.requireProject(repositories, projectId);
      const inferenceCostMicrousd = assertMicrousd(
        await repositories.agentRuns.sumProviderCostMicrousd(
          this.tenantId,
          projectId,
        ),
      );
      return {
        budgetMicrousd: project.budgetMicrousd,
        spentMicrousd: project.spentMicrousd,
        remainingMicrousd: subtractMicrousd(
          project.budgetMicrousd,
          project.spentMicrousd,
        ),
        inferenceCostMicrousd,
      };
    });
  }

  private async requireProject(
    repositories: Repositories,
    projectId: Uuid,
  ): Promise<VideoProject> {
    const project = await repositories.projects.findById(
      this.tenantId,
      projectId,
    );
    if (!project) {
      throw new ApplicationError(
        'PROJECT_NOT_FOUND',
        'The requested project was not found.',
        404,
        false,
      );
    }
    return project;
  }

  private async appendEvent(
    repositories: Repositories,
    input: {
      readonly type: DomainEventType;
      readonly projectId: Uuid;
      readonly shotId?: Uuid;
      readonly traceId?: string;
      readonly payload: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    const event = createDomainEvent({
      id: this.idGenerator.next(),
      type: input.type,
      producer: this.producer,
      tenantId: this.tenantId,
      projectId: input.projectId,
      payload: input.payload,
      clock: this.clock,
      ...(input.shotId ? { shotId: input.shotId } : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
    });
    await repositories.events.append(event);
    await repositories.outbox.enqueue(event);
  }
}

export function mapRepositoryError(
  error: unknown,
): ApplicationError | undefined {
  if (error instanceof RepositoryError) {
    if (error.code === 'OPTIMISTIC_CONFLICT') {
      return new ApplicationError(
        'OPTIMISTIC_CONFLICT',
        'The resource changed; retry the operation with fresh state.',
        409,
        true,
      );
    }
    if (error.code === 'DATABASE_ERROR') {
      return new ApplicationError(
        'PERSISTENCE_UNAVAILABLE',
        'The persistence operation could not be completed.',
        503,
        true,
      );
    }
  }
  return undefined;
}

export function isUuid(value: unknown): value is Uuid {
  return typeof value === 'string' && value.length > 0;
}

export function normalizeProjectId(value: string): Uuid {
  return assertUuid(value);
}

export function transitionShotForFuturePhases(
  shot: Shot,
  nextStatus:
    | 'queued'
    | 'generating'
    | 'retryable'
    | 'awaiting_review'
    | 'rejected'
    | 'cancelled'
    | 'failed',
): Shot {
  return transitionShot(shot, nextStatus);
}
