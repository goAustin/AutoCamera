import {
  createDomainEvent,
  createShot,
  createStoryboardProposal,
  createVideoProject,
  assertUuid,
  subtractMicrousd,
  systemClock,
  systemIdGenerator,
  toIsoUtc,
  transitionProject,
  transitionShot,
  transitionStoryboard,
  type Clock,
  type DomainEventType,
  type DomainEvent,
  type IdGenerator,
  type IsoUtcTimestamp,
  type MicroUsd,
  type Shot,
  type StoryboardProposal,
  type StoryboardShotDefinition,
  type Uuid,
  type VideoProject,
  isUuidV7,
  STORYBOARD_DURATION_TOLERANCE_SECONDS,
} from '@h3/domain';
import {
  type Repositories,
  RepositoryError,
  type TransactionalStore,
} from '@h3/db';

export const DEV_TENANT_ID = assertUuid('00000000-0000-7000-8000-000000000001');

export interface PlanProjectInput {
  readonly projectId: Uuid;
  readonly tenantId: Uuid;
  readonly project: VideoProject;
}

export interface PlanningShot {
  readonly ordinal: 1 | 2 | 3;
  readonly purpose: string;
  readonly generationMode: 't2v';
  readonly durationSeconds: number;
  readonly visualDescription: string;
  readonly cameraDirection: string;
  readonly audioDirection: string;
  readonly dialogue?: string;
  readonly requiredAssetIds: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

export interface PlannedStoryboard {
  readonly projectId: Uuid;
  readonly objective: string;
  readonly assumptions: readonly string[];
  readonly shots: readonly PlanningShot[];
  readonly totalDurationSeconds: number;
  readonly risks: readonly string[];
}

export interface AgentRunCorrelation {
  readonly runId: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly providerCostMicrousd?: number;
}

export interface PlanProjectResult {
  readonly storyboard: PlannedStoryboard;
  readonly agentRun?: AgentRunCorrelation;
}

export interface PlanningAgent {
  planProject(
    input: PlanProjectInput,
    signal?: AbortSignal,
  ): Promise<PlanProjectResult>;
}

/** A deterministic planner retained for direct application-service tests. */
export class StaticStoryboardPlanner implements PlanningAgent {
  async planProject(
    input: PlanProjectInput,
    signal?: AbortSignal,
  ): Promise<PlanProjectResult> {
    if (signal?.aborted) {
      throw new ApplicationError(
        'PLANNING_ABORTED',
        'Storyboard planning was aborted.',
        499,
        false,
      );
    }
    const project = input.project;
    const durationMilliseconds = Math.round(
      project.targetDurationSeconds * 1000,
    );
    if (durationMilliseconds < 3_000) {
      throw new ApplicationError(
        'PROJECT_DURATION_INVALID',
        'The project target duration cannot be split into three shots.',
        422,
        false,
      );
    }
    const baseMilliseconds = Math.floor(durationMilliseconds / 3);
    const durations = [
      baseMilliseconds,
      baseMilliseconds,
      durationMilliseconds - baseMilliseconds * 2,
    ].map((value) => value / 1000);
    const firstDuration = durations[0] ?? 0;
    const secondDuration = durations[1] ?? 0;
    const thirdDuration = durations[2] ?? 0;
    const brief = project.brief.replace(/\s+/g, ' ').trim();
    return {
      storyboard: {
        projectId: input.projectId,
        objective: 'Create a concise three-shot preview storyboard.',
        assumptions: ['Preview generation is text-to-video only.'],
        totalDurationSeconds: project.targetDurationSeconds,
        risks: [],
        shots: [
          {
            ordinal: 1,
            purpose: 'Establish the visual hook and setting.',
            visualDescription: `A polished opening shot for ${project.title}: ${brief}.`,
            cameraDirection:
              'Start with a steady wide shot and a gentle push-in.',
            audioDirection: 'Use a clean, restrained opening sound bed.',
            durationSeconds: firstDuration,
            generationMode: 't2v',
            requiredAssetIds: [],
            acceptanceCriteria: [
              'The setting and subject are immediately legible.',
            ],
          },
          {
            ordinal: 2,
            purpose: 'Show the central product or story action.',
            visualDescription: `A clear product-focused middle shot for ${project.title}: ${brief}.`,
            cameraDirection: 'Track the subject with a smooth medium shot.',
            audioDirection: 'Build the sound bed with a clear action accent.',
            durationSeconds: secondDuration,
            generationMode: 't2v',
            requiredAssetIds: [],
            acceptanceCriteria: [
              'The central action reads without extra context.',
            ],
          },
          {
            ordinal: 3,
            purpose: 'Close with a memorable outcome and call to action.',
            visualDescription: `A confident closing shot for ${project.title}: ${brief}.`,
            cameraDirection:
              'End on a composed hero frame with a subtle pull-back.',
            audioDirection:
              'Resolve with a memorable but unobtrusive closing cue.',
            durationSeconds: thirdDuration,
            generationMode: 't2v',
            requiredAssetIds: [],
            acceptanceCriteria: [
              'The outcome is clear and visually memorable.',
            ],
          },
        ],
      },
    };
  }
}

export type ApplicationErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'STORYBOARD_NOT_FOUND'
  | 'PROJECT_DURATION_INVALID'
  | 'PLANNING_ABORTED'
  | 'INVALID_PLANNING_RESULT'
  | 'PROJECT_NOT_READY_FOR_PLANNING'
  | 'STORYBOARD_NOT_APPROVABLE'
  | 'STALE_STORYBOARD'
  | 'STORYBOARD_ALREADY_MATERIALIZED'
  | 'MISSING_STORYBOARD'
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
  readonly planner?: PlanningAgent;
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
  readonly budgetMicrousd: MicroUsd;
}

export interface ProjectPlanResult {
  readonly project: VideoProject;
  readonly proposal: StoryboardProposal;
  readonly agentRun?: AgentRunCorrelation;
}

export interface ApprovalResult {
  readonly project: VideoProject;
  readonly shots: readonly Shot[];
}

export interface ProjectCost {
  readonly budgetMicrousd: MicroUsd;
  readonly spentMicrousd: MicroUsd;
  readonly remainingMicrousd: MicroUsd;
}

function withTimestamp<Value extends { readonly updatedAt: IsoUtcTimestamp }>(
  value: Value,
  updatedAt: IsoUtcTimestamp,
): Value {
  return { ...value, updatedAt };
}

export class ProjectApplicationService {
  readonly store: TransactionalStore;
  readonly planner: PlanningAgent;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly tenantId: Uuid;
  readonly defaultBudgetMicrousd: MicroUsd;
  readonly producer: string;

  constructor(options: ProjectApplicationServiceOptions) {
    this.store = options.store;
    this.planner = options.planner ?? new StaticStoryboardPlanner();
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
      now,
    });
    await repositories.projects.create(project);
    await this.appendEvent(repositories, {
      type: 'project.created',
      projectId: project.id,
      payload: { status: project.status },
    });
    return project;
  }

  async planProject(
    projectId: Uuid,
    signal?: AbortSignal,
  ): Promise<ProjectPlanResult> {
    const project = await this.store.withTransaction((repositories) =>
      this.requirePlanningProject(repositories, projectId),
    );
    const result = await this.planner.planProject(
      { projectId, tenantId: this.tenantId, project },
      signal,
    );
    return this.store.withTransaction((repositories) =>
      this.persistPlanProjectInTransaction(repositories, projectId, result),
    );
  }

  async planProjectInTransaction(
    repositories: Repositories,
    projectId: Uuid,
    signal?: AbortSignal,
  ): Promise<ProjectPlanResult> {
    const project = await this.requirePlanningProject(repositories, projectId);
    const result = await this.planner.planProject(
      { projectId, tenantId: this.tenantId, project },
      signal,
    );
    return this.persistPlanProjectInTransaction(
      repositories,
      projectId,
      result,
    );
  }

  async persistPlanProjectInTransaction(
    repositories: Repositories,
    projectId: Uuid,
    result: PlanProjectResult,
  ): Promise<ProjectPlanResult> {
    const project = await this.requirePlanningProject(repositories, projectId);
    if (result.storyboard.projectId !== projectId) {
      throw new ApplicationError(
        'INVALID_PLANNING_RESULT',
        'The planning agent returned a different project identifier.',
        422,
        false,
      );
    }
    const plan = result.storyboard;
    const planOrdinals = plan.shots.map((shot) => shot.ordinal);
    const planTotal = plan.shots.reduce(
      (sum, shot) => sum + shot.durationSeconds,
      0,
    );
    if (
      plan.shots.length !== 3 ||
      planOrdinals.join(',') !== '1,2,3' ||
      Math.abs(planTotal - plan.totalDurationSeconds) >
        STORYBOARD_DURATION_TOLERANCE_SECONDS ||
      Math.abs(planTotal - project.targetDurationSeconds) >
        STORYBOARD_DURATION_TOLERANCE_SECONDS
    ) {
      throw new ApplicationError(
        'INVALID_PLANNING_RESULT',
        'The planning agent returned an invalid storyboard proposal.',
        422,
        false,
      );
    }
    const now = toIsoUtc(this.clock.now());
    let workingProject = project;
    if (
      workingProject.status === 'draft' ||
      workingProject.status === 'awaiting_storyboard_approval'
    ) {
      const planningProject = withTimestamp(
        transitionProject(workingProject, 'planning'),
        now,
      );
      await repositories.projects.update(
        planningProject,
        workingProject.version,
      );
      await this.appendEvent(repositories, {
        type: 'project.planning_started',
        projectId,
        payload: { previousStatus: workingProject.status },
      });
      workingProject = planningProject;
    }

    const latestProposal = await repositories.storyboards.findLatest(projectId);
    if (latestProposal?.status === 'proposed') {
      const superseded = withTimestamp(
        transitionStoryboard(latestProposal, 'superseded'),
        now,
      );
      await repositories.storyboards.update(superseded, latestProposal.version);
      await this.appendEvent(repositories, {
        type: 'storyboard.superseded',
        projectId,
        payload: { revision: latestProposal.revision },
      });
    }

    const shotDefinitions: readonly StoryboardShotDefinition[] = plan.shots.map(
      (shot) => ({
        ordinal: shot.ordinal,
        purpose: shot.purpose,
        prompt: [
          shot.visualDescription,
          `Camera: ${shot.cameraDirection}`,
          `Audio: ${shot.audioDirection}`,
          ...(shot.dialogue ? [`Dialogue: ${shot.dialogue}`] : []),
          `Acceptance: ${shot.acceptanceCriteria.join('; ')}`,
        ].join(' '),
        durationSeconds: shot.durationSeconds,
        mode: shot.generationMode,
        qualityTier: 'preview',
        visualDescription: shot.visualDescription,
        cameraDirection: shot.cameraDirection,
        audioDirection: shot.audioDirection,
        ...(shot.dialogue ? { dialogue: shot.dialogue } : {}),
        acceptanceCriteria: [...shot.acceptanceCriteria],
        requiredAssetIds: [...shot.requiredAssetIds],
      }),
    );
    const agentRunId =
      result.agentRun && isUuidV7(result.agentRun.runId)
        ? result.agentRun.runId
        : undefined;
    const proposal = createStoryboardProposal({
      id: this.idGenerator.next(),
      projectId,
      revision: (latestProposal?.revision ?? 0) + 1,
      shots: shotDefinitions,
      durationToleranceSeconds: STORYBOARD_DURATION_TOLERANCE_SECONDS,
      objective: plan.objective,
      assumptions: plan.assumptions,
      risks: plan.risks,
      ...(agentRunId ? { agentRunId } : {}),
      now,
    });
    await repositories.storyboards.create(proposal);

    const awaitingApproval = withTimestamp(
      transitionProject(workingProject, 'awaiting_storyboard_approval'),
      now,
    );
    await repositories.projects.update(
      awaitingApproval,
      workingProject.version,
    );
    await this.appendEvent(repositories, {
      type: 'storyboard.proposed',
      projectId,
      payload: {
        revision: proposal.revision,
        shotCount: proposal.shots.length,
        totalDurationSeconds: proposal.totalDurationSeconds,
      },
    });
    await this.appendEvent(repositories, {
      type: 'project.planned',
      projectId,
      payload: { status: awaitingApproval.status, revision: proposal.revision },
    });
    return {
      project: awaitingApproval,
      proposal,
      ...(result.agentRun ? { agentRun: result.agentRun } : {}),
    };
  }

  async approveStoryboard(
    projectId: Uuid,
    proposalId?: Uuid,
  ): Promise<ApprovalResult> {
    return this.store.withTransaction((repositories) =>
      this.approveStoryboardInTransaction(repositories, projectId, proposalId),
    );
  }

  async approveStoryboardInTransaction(
    repositories: Repositories,
    projectId: Uuid,
    proposalId?: Uuid,
  ): Promise<ApprovalResult> {
    const project = await this.requireProject(repositories, projectId);
    if (project.status !== 'awaiting_storyboard_approval') {
      throw new ApplicationError(
        'STORYBOARD_NOT_APPROVABLE',
        'The project does not have a storyboard awaiting approval.',
        409,
        false,
      );
    }
    const proposal = proposalId
      ? await repositories.storyboards.findById(projectId, proposalId)
      : await repositories.storyboards.findLatest(projectId);
    if (!proposal) {
      throw new ApplicationError(
        'MISSING_STORYBOARD',
        'No storyboard proposal is available for approval.',
        404,
        false,
      );
    }
    const latestProposal = await repositories.storyboards.findLatest(projectId);
    if (
      proposal.status !== 'proposed' ||
      !latestProposal ||
      latestProposal.id !== proposal.id
    ) {
      throw new ApplicationError(
        'STALE_STORYBOARD',
        'The requested storyboard is no longer the current proposal.',
        409,
        false,
      );
    }

    const existingShots = await repositories.shots.listByProject(projectId);
    if (existingShots.length > 0) {
      throw new ApplicationError(
        'STORYBOARD_ALREADY_MATERIALIZED',
        'The project storyboard has already been materialized into shots.',
        409,
        false,
      );
    }

    const now = toIsoUtc(this.clock.now());
    const shots = proposal.shots.map((definition) =>
      createShot({
        id: this.idGenerator.next(),
        projectId,
        storyboardProposalId: proposal.id,
        definition,
        now,
      }),
    );
    const approvedProposal = withTimestamp(
      transitionStoryboard(proposal, 'approved'),
      now,
    );
    await repositories.storyboards.update(approvedProposal, proposal.version);
    await repositories.shots.createMany(shots);
    const readyProject = withTimestamp(
      transitionProject(project, 'ready_for_generation'),
      now,
    );
    await repositories.projects.update(readyProject, project.version);

    await this.appendEvent(repositories, {
      type: 'storyboard.approved',
      projectId,
      payload: { revision: proposal.revision, shotCount: shots.length },
    });
    for (const shot of shots) {
      await this.appendEvent(repositories, {
        type: 'shot.created',
        projectId,
        shotId: shot.id,
        payload: { ordinal: shot.ordinal, status: shot.status },
      });
    }
    await this.appendEvent(repositories, {
      type: 'project.ready_for_generation',
      projectId,
      payload: { status: readyProject.status },
    });
    return { project: readyProject, shots };
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

  async listShots(projectId: Uuid): Promise<readonly Shot[]> {
    return this.store.withTransaction(async (repositories) => {
      await this.requireProject(repositories, projectId);
      return repositories.shots.listByProject(projectId);
    });
  }

  async getStoryboard(projectId: Uuid): Promise<StoryboardProposal | null> {
    return this.store.withTransaction(async (repositories) => {
      await this.requireProject(repositories, projectId);
      return repositories.storyboards.findLatest(projectId);
    });
  }

  async listEvents(projectId: Uuid): Promise<readonly DomainEvent[]> {
    return this.store.withTransaction(async (repositories) => {
      await this.requireProject(repositories, projectId);
      return repositories.events.listByProject(projectId);
    });
  }

  async getCost(projectId: Uuid): Promise<ProjectCost> {
    return this.store.withTransaction(async (repositories) => {
      const project = await this.requireProject(repositories, projectId);
      return {
        budgetMicrousd: project.budgetMicrousd,
        spentMicrousd: project.spentMicrousd,
        remainingMicrousd: subtractMicrousd(
          project.budgetMicrousd,
          project.spentMicrousd,
        ),
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

  private async requirePlanningProject(
    repositories: Repositories,
    projectId: Uuid,
  ): Promise<VideoProject> {
    const project = await this.requireProject(repositories, projectId);
    if (
      project.status !== 'draft' &&
      project.status !== 'planning' &&
      project.status !== 'awaiting_storyboard_approval'
    ) {
      throw new ApplicationError(
        'PROJECT_NOT_READY_FOR_PLANNING',
        'The project is not available for storyboard planning.',
        409,
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

export function transitionStoryboardForFuturePhases(
  proposal: StoryboardProposal,
  nextStatus: 'approved' | 'superseded',
): StoryboardProposal {
  return transitionStoryboard(proposal, nextStatus);
}
