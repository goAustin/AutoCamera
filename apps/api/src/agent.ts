import {
  Agent,
  type AgentEvent,
  type StreamFn,
  type TelemetryContext,
  type TelemetrySpan,
} from '@earendil-works/pi-agent-core';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import {
  createPlanningTools,
  validateStoryboardProposal,
  type AttemptToolView,
  type PlanningToolContext,
  type PlanningToolName,
  type PlanningToolServices,
  type ProjectIncidentToolView,
  type ProjectToolView,
  type StoryboardProposalOutput,
  type StoryboardToolView,
} from '@h3/agent-tools';
import {
  subtractMicrousd,
  type Clock,
  type GenerationAttempt,
  type IdGenerator,
  type Uuid,
  type VideoProject,
} from '@h3/domain';
import type {
  AgentRunFailureCode,
  AgentRunRecord,
  AgentRunStatus,
  TransactionalStore,
} from '@h3/db';
import type { ProjectApplicationService } from './application.js';
import type { GenerationApplicationService } from './generation.js';
import {
  InMemoryTelemetry,
  type MetricsRegistry,
  type AgentTelemetry,
  type TraceId,
  type TelemetryAttributes,
  type TelemetrySpanHandle,
} from '@h3/telemetry';

export interface FauxPlanningScript {
  readonly output?: unknown;
  readonly duplicateToolCall?: boolean;
  readonly providerError?: string;
  readonly abort?: boolean;
  readonly abortDelayMs?: number;
}

export interface PiPlanningAgentOptions {
  readonly store: TransactionalStore;
  readonly tenantId: Uuid;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly provider?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly maxConcurrentRuns?: number;
  readonly timeoutMs?: number;
  readonly telemetry?: AgentTelemetry;
  readonly metrics?: MetricsRegistry;
  readonly script?: FauxPlanningScript;
  readonly enabledTools?: readonly PlanningToolName[];
  readonly projectService?: Pick<
    ProjectApplicationService,
    'approveStoryboard' | 'getProject' | 'listEvents' | 'listShots'
  >;
  readonly generationService?: Pick<
    GenerationApplicationService,
    'createAttempt' | 'getAttempt' | 'regenerateAttempt' | 'listProjectAttempts'
  >;
}

export class PlanningAgentError extends Error {
  readonly code: AgentRunFailureCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: AgentRunFailureCode,
    message: string,
    status: number,
    retryable: boolean,
  ) {
    super(message);
    this.name = 'PlanningAgentError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const DEFAULT_OBJECTIVE = 'Create a concise three-shot preview storyboard.';

function defaultFauxOutput(project: VideoProject): StoryboardProposalOutput {
  const first = Math.round((project.targetDurationSeconds / 3) * 1_000) / 1_000;
  const second = first;
  const third =
    Math.round((project.targetDurationSeconds - first - second) * 1_000) /
    1_000;
  const brief = project.brief.replace(/\s+/g, ' ').trim();
  return {
    projectId: project.id,
    objective: DEFAULT_OBJECTIVE,
    assumptions: ['Preview generation is text-to-video only.'],
    shots: [
      {
        ordinal: 1,
        purpose: 'Establish the visual hook and setting.',
        generationMode: 't2v',
        durationSeconds: first,
        visualDescription: `Opening view of ${project.title}: ${brief}.`,
        cameraDirection: 'Use a steady wide shot with a gentle push-in.',
        audioDirection: 'Use a clean, restrained opening sound bed.',
        requiredAssetIds: [],
        acceptanceCriteria: [
          'The setting and subject are immediately legible.',
        ],
      },
      {
        ordinal: 2,
        purpose: 'Show the central product or story action.',
        generationMode: 't2v',
        durationSeconds: second,
        visualDescription: `Middle action focused on ${project.title}: ${brief}.`,
        cameraDirection: 'Track the subject with a smooth medium shot.',
        audioDirection: 'Build the sound bed with a clear action accent.',
        requiredAssetIds: [],
        acceptanceCriteria: ['The central action reads without extra context.'],
      },
      {
        ordinal: 3,
        purpose: 'Close with a memorable outcome and call to action.',
        generationMode: 't2v',
        durationSeconds: third,
        visualDescription: `Closing hero view for ${project.title}: ${brief}.`,
        cameraDirection:
          'End on a composed hero frame with a subtle pull-back.',
        audioDirection: 'Resolve with a memorable closing cue.',
        requiredAssetIds: [],
        acceptanceCriteria: ['The outcome is clear and visually memorable.'],
      },
    ],
    totalDurationSeconds: project.targetDurationSeconds,
    risks: [],
  };
}

function projectView(project: VideoProject): ProjectToolView {
  return {
    id: project.id,
    title: project.title,
    brief: project.brief,
    status: project.status,
    targetDurationSeconds: project.targetDurationSeconds,
    budgetMicrousd: project.budgetMicrousd,
    spentMicrousd: project.spentMicrousd,
    remainingMicrousd: subtractMicrousd(
      project.budgetMicrousd,
      project.spentMicrousd,
    ),
  };
}

function attemptView(attempt: GenerationAttempt): AttemptToolView {
  return {
    id: attempt.id,
    projectId: attempt.projectId,
    shotId: attempt.shotId,
    status: attempt.status,
    ...(attempt.failureCode ? { failureCode: attempt.failureCode } : {}),
  };
}

function incidentViews(
  events: readonly {
    readonly type: string;
    readonly occurredAt: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }[],
): readonly ProjectIncidentToolView[] {
  return events
    .filter((event) =>
      /failed|denied|rejected|timeout|uncertain|error/i.test(event.type),
    )
    .slice(-20)
    .map((event) => ({
      code: event.type,
      status:
        typeof event.payload.status === 'string'
          ? event.payload.status
          : 'incident',
      occurredAt: event.occurredAt,
    }));
}

function makeToolServices(
  options: PiPlanningAgentOptions,
): PlanningToolServices {
  return {
    getVideoProject: async (tenantId, projectId) =>
      options.projectService
        ? options.projectService
            .getProject(projectId)
            .then((project) =>
              project.tenantId === tenantId ? projectView(project) : null,
            )
        : null,
    submitStoryboardForApproval: async (input) => {
      if (!options.projectService) throw new Error('approval unavailable');
      const result = await options.projectService.approveStoryboard(
        input.projectId,
        input.proposalId,
      );
      return {
        id: input.proposalId ?? input.projectId,
        projectId: input.projectId,
        revision: 0,
        status: 'approved',
        shotCount: result.shots.length,
        totalDurationSeconds: result.shots.reduce(
          (sum, shot) => sum + shot.durationSeconds,
          0,
        ),
      } satisfies StoryboardToolView;
    },
    requestShotGeneration: async (input) => {
      if (!options.generationService) throw new Error('generation unavailable');
      if (!options.projectService) throw new Error('project unavailable');
      const shots = await options.projectService.listShots(input.projectId);
      if (!shots.some((shot) => shot.id === input.shotId)) {
        throw Object.assign(new Error('shot scope denied'), {
          code: 'SHOT_SCOPE_DENIED',
        });
      }
      const attempt = await options.generationService.createAttempt(
        input.shotId,
        { idempotencyKey: input.idempotencyKey },
      );
      return attemptView(attempt);
    },
    getGenerationAttempt: async (tenantId, attemptId) => {
      if (!options.generationService) return null;
      try {
        const attempt = await options.generationService.getAttempt(attemptId);
        return attempt.tenantId === tenantId ? attemptView(attempt) : null;
      } catch {
        return null;
      }
    },
    requestRegeneration: async (input) => {
      if (
        !options.generationService ||
        !options.projectService ||
        !input.sourceAttemptId
      ) {
        throw new Error('regeneration policy denied');
      }
      const source = await options.generationService.getAttempt(
        input.sourceAttemptId,
      );
      if (
        source.projectId !== input.projectId ||
        source.shotId !== input.shotId
      ) {
        throw Object.assign(new Error('attempt scope denied'), {
          code: 'ATTEMPT_SCOPE_DENIED',
        });
      }
      const attempt = await options.generationService.regenerateAttempt(
        input.sourceAttemptId,
        { idempotencyKey: input.idempotencyKey },
      );
      return attemptView(attempt);
    },
    getProjectIncidents: async (tenantId, projectId) => {
      if (!options.projectService) return [];
      const events = await options.projectService.listEvents(projectId);
      return incidentViews(
        events.filter((event) => event.tenantId === tenantId),
      );
    },
  };
}

function toPiAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
): TelemetryAttributes {
  if (!attributes) return {};
  const allowed = new Set(['string', 'number', 'boolean']);
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (
      (typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean') &&
      allowed.has(typeof value)
    ) {
      result[key] = value;
    }
  }
  return result;
}

function piTelemetryContext(
  telemetry: AgentTelemetry,
  parent: TelemetrySpanHandle,
): TelemetryContext {
  type AdaptedPiSpan = TelemetrySpan & { close: () => void };
  const createSpan = (
    options: { name: string; attributes?: Readonly<Record<string, unknown>> },
    parentSpan: TelemetrySpanHandle,
  ): AdaptedPiSpan => {
    const span = telemetry.startSpan(
      options.name,
      toPiAttributes(options.attributes),
      parentSpan,
    );
    return {
      addEvent: (name, attributes) =>
        span.addEvent(name, toPiAttributes(attributes)),
      setAttributes: (attributes) =>
        span.setAttributes(toPiAttributes(attributes)),
      setStatus: (status) =>
        span.setStatus(status.status === 'ok' ? 'ok' : 'error'),
      close: () => span.end(),
      startSpan: async (childOptions, callback) => {
        const child = createSpan(childOptions, span);
        try {
          return await callback(child);
        } finally {
          child.close();
        }
      },
    };
  };
  return {
    startSpan: async (options, callback) => {
      const span = createSpan(options, parent);
      try {
        return await callback(span);
      } finally {
        span.close();
      }
    },
  };
}

function assistantMessages(messages: readonly unknown[]): AssistantMessage[] {
  return messages.filter(
    (message): message is AssistantMessage =>
      typeof message === 'object' &&
      message !== null &&
      'role' in message &&
      message.role === 'assistant',
  );
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function usageTotals(messages: readonly AssistantMessage[]) {
  return messages.reduce(
    (totals, message) => ({
      inputTokens: totals.inputTokens + message.usage.input,
      outputTokens: totals.outputTokens + message.usage.output,
      totalTokens: totals.totalTokens + message.usage.totalTokens,
      cacheReadTokens: totals.cacheReadTokens + message.usage.cacheRead,
      cacheWriteTokens: totals.cacheWriteTokens + message.usage.cacheWrite,
      providerCostMicrousd:
        totals.providerCostMicrousd +
        Math.round(message.usage.cost.total * 1_000_000),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      providerCostMicrousd: 0,
    },
  );
}

class RunGate {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = { resolve, reject, signal } as {
        resolve: (release: () => void) => void;
        reject: (error: unknown) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(
          new PlanningAgentError(
            'ABORTED',
            'Planning was aborted.',
            499,
            false,
          ),
        );
      };
      waiter.onAbort = onAbort;
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (!next) {
      this.active -= 1;
      return;
    }
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener('abort', next.onAbort);
    }
    next.resolve(() => this.release());
  }
}

export class PiPlanningAgent {
  private readonly provider: string;
  private readonly modelName: string;
  private readonly timeoutMs: number;
  private readonly telemetry: AgentTelemetry;
  private readonly metrics: MetricsRegistry | undefined;
  private readonly script: FauxPlanningScript | undefined;
  private readonly enabledTools: readonly PlanningToolName[];
  private readonly services: PlanningToolServices;
  private readonly gate: RunGate;

  constructor(private readonly options: PiPlanningAgentOptions) {
    this.provider = options.provider ?? 'faux';
    this.modelName = options.model ?? 'h3-videoops-storyboard-v1';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.telemetry = options.telemetry ?? new InMemoryTelemetry();
    this.metrics = options.metrics;
    this.script = options.script;
    this.enabledTools = options.enabledTools ?? ['get_video_project'];
    this.services = makeToolServices(options);
    this.gate = new RunGate(Math.max(1, options.maxConcurrentRuns ?? 1));
  }

  async planProject(
    input: {
      readonly projectId: Uuid;
      readonly tenantId: Uuid;
      readonly project: VideoProject;
      readonly traceId?: string;
    },
    signal?: AbortSignal,
  ) {
    const release = await this.gate.acquire(signal);
    const runId = this.options.idGenerator.next();
    const sessionId = `pi-${runId}`;
    const startedAt = input.project.updatedAt;
    const objective = DEFAULT_OBJECTIVE;
    let run: AgentRunRecord = {
      id: runId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      runId,
      sessionId,
      objective,
      provider: this.provider,
      model: this.modelName,
      status: 'running',
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      providerCostMicrousd: 0,
      startedAt,
      version: 1,
      updatedAt: startedAt,
    };
    await this.options.store.withTransaction((repositories) =>
      repositories.agentRuns.create(run),
    );

    const rootSpan = this.telemetry.startRootSpan
      ? this.telemetry.startRootSpan(
          'agent.run',
          {
            provider: this.provider,
            model: this.modelName,
            status: 'running',
          },
          input.traceId as TraceId | undefined,
        )
      : this.telemetry.startSpan('agent.run', {
          provider: this.provider,
          model: this.modelName,
          status: 'running',
        });
    const runStartedAt = Date.now();
    let terminalStatus: AgentRunStatus = 'failed';
    let failureCode: AgentRunFailureCode | undefined;
    let result: StoryboardProposalOutput | undefined;
    let agent: Agent | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const toolSpans = new Map<string, TelemetrySpanHandle>();
    const policyDenial = (code: string, operation: string) => {
      rootSpan.addEvent('policy.denial', { code, operation });
    };
    const toolContext: PlanningToolContext = {
      tenantId: input.tenantId,
      projectId: input.projectId,
      agentRunId: runId,
      services: this.services,
      effectCache: new Map(),
      onPolicyDenial: policyDenial,
    };

    try {
      if (this.provider !== 'faux') {
        failureCode = 'PROVIDER_ERROR';
        terminalStatus = 'failed';
        throw new PlanningAgentError(
          'PROVIDER_ERROR',
          'The selected planning provider is not enabled in this phase.',
          503,
          true,
        );
      }
      const faux = fauxProvider({
        provider: this.provider,
        models: [{ id: this.modelName, name: this.modelName }],
      });
      const models = createModels();
      models.setProvider(faux.provider);
      const output = this.script?.output ?? defaultFauxOutput(input.project);
      const toolCall = fauxToolCall(
        'get_video_project',
        {
          projectId: input.projectId,
        },
        { id: `${runId}-project` },
      );
      const toolCalls = this.script?.duplicateToolCall
        ? [
            toolCall,
            fauxToolCall(
              'get_video_project',
              {
                projectId: input.projectId,
              },
              { id: `${runId}-project` },
            ),
          ]
        : [toolCall];
      faux.setResponses([
        ...(this.script?.providerError
          ? [
              fauxAssistantMessage('', {
                stopReason: 'error',
                errorMessage: this.script.providerError,
              }),
            ]
          : [fauxAssistantMessage(toolCalls)]),
        ...(this.script?.providerError
          ? []
          : [fauxAssistantMessage(JSON.stringify(output))]),
      ]);
      const model = faux.getModel() as Model<Api>;
      const tools = createPlanningTools(toolContext, this.enabledTools);
      const piContext = piTelemetryContext(this.telemetry, rootSpan);
      const streamFn: StreamFn = (streamModel, context, streamOptions) =>
        models.streamSimple(streamModel, context, {
          ...streamOptions,
          telemetryContext: piContext,
          ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
          ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
        });
      agent = new Agent({
        sessionId,
        streamFn,
        toolExecution: 'sequential',
        initialState: {
          model,
          systemPrompt:
            'Return only a strict JSON storyboard proposal after reading the project with the provided tool.',
          tools,
        },
      });
      agent.subscribe(async (event: AgentEvent) => {
        try {
          if (event.type === 'turn_start') {
            rootSpan.addEvent('model.turn.start', { model: this.modelName });
          } else if (event.type === 'turn_end') {
            rootSpan.addEvent('model.turn.end', { model: this.modelName });
          } else if (event.type === 'tool_execution_start') {
            run = { ...run, toolCalls: run.toolCalls + 1 };
            const span = this.telemetry.startSpan(
              'agent.tool',
              { tool: event.toolName, outcome: 'started' },
              rootSpan,
            );
            toolSpans.set(event.toolCallId, span);
          } else if (event.type === 'tool_execution_end') {
            const span = toolSpans.get(event.toolCallId);
            if (span) {
              span.setStatus(event.isError ? 'error' : 'ok');
              span.end();
              toolSpans.delete(event.toolCallId);
            }
          }
        } catch {
          // Telemetry and lifecycle bookkeeping cannot fail a planning run.
        }
      });
      if (signal?.aborted) agent.abort();
      const abortListener = () => agent?.abort();
      signal?.addEventListener('abort', abortListener, { once: true });
      if (this.script?.abort) {
        const delay = this.script.abortDelayMs ?? 0;
        timeoutHandle = setTimeout(() => agent?.abort(), delay);
      }
      const promptPromise = agent.prompt(
        `Plan project ${input.projectId} as a three-shot preview storyboard.`,
      );
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          agent?.abort();
          resolve('timeout');
        }, this.timeoutMs);
      });
      await Promise.race([promptPromise, timeoutPromise]);
      await agent.waitForIdle();
      signal?.removeEventListener('abort', abortListener);
      const messages = assistantMessages(agent.state.messages);
      const totals = usageTotals(messages);
      run = { ...run, ...totals };
      const final = messages.at(-1);
      if (timedOut) {
        failureCode = 'TIMEOUT';
        terminalStatus = 'timed_out';
        throw new PlanningAgentError(
          'TIMEOUT',
          'Storyboard planning timed out.',
          504,
          true,
        );
      }
      if (
        signal?.aborted ||
        this.script?.abort ||
        final?.stopReason === 'aborted'
      ) {
        failureCode = 'ABORTED';
        terminalStatus = 'aborted';
        throw new PlanningAgentError(
          'ABORTED',
          'Storyboard planning was aborted.',
          499,
          false,
        );
      }
      if (!final || final.stopReason === 'error') {
        failureCode = 'PROVIDER_ERROR';
        terminalStatus = 'failed';
        throw new PlanningAgentError(
          'PROVIDER_ERROR',
          'The planning provider could not complete the request.',
          503,
          true,
        );
      }
      const validationSpan = this.telemetry.startSpan(
        'agent.structured_validation',
        { schema: 'storyboard.v1' },
        rootSpan,
      );
      try {
        result = validateStoryboardProposal(
          JSON.parse(assistantText(final)),
          input.project,
        );
        validationSpan.setStatus('ok');
      } catch (error) {
        validationSpan.setStatus('error', error);
        failureCode = 'INVALID_STRUCTURED_OUTPUT';
        terminalStatus = 'failed';
        throw new PlanningAgentError(
          'INVALID_STRUCTURED_OUTPUT',
          'The planning agent returned invalid structured output.',
          422,
          false,
        );
      } finally {
        validationSpan.end();
      }
      terminalStatus = 'succeeded';
      rootSpan.setStatus('ok');
      return {
        storyboard: {
          projectId: result.projectId as Uuid,
          objective: result.objective,
          assumptions: result.assumptions,
          shots: result.shots.map((shot) => ({
            ordinal: shot.ordinal as 1 | 2 | 3,
            purpose: shot.purpose,
            generationMode: shot.generationMode,
            durationSeconds: shot.durationSeconds,
            visualDescription: shot.visualDescription,
            cameraDirection: shot.cameraDirection,
            audioDirection: shot.audioDirection,
            ...(shot.dialogue ? { dialogue: shot.dialogue } : {}),
            requiredAssetIds: shot.requiredAssetIds,
            acceptanceCriteria: shot.acceptanceCriteria,
          })),
          totalDurationSeconds: result.totalDurationSeconds,
          risks: result.risks,
        },
        agentRun: {
          runId,
          sessionId,
          provider: this.provider,
          model: this.modelName,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          totalTokens: run.totalTokens,
          providerCostMicrousd: run.providerCostMicrousd,
        },
      };
    } catch (error) {
      if (!failureCode) {
        if (signal?.aborted || this.script?.abort) {
          failureCode = 'ABORTED';
          terminalStatus = 'aborted';
        } else {
          failureCode = 'APPLICATION_ERROR';
          terminalStatus = 'failed';
        }
      }
      if (error instanceof PlanningAgentError) throw error;
      throw new PlanningAgentError(
        failureCode,
        'The planning agent could not complete the request.',
        failureCode === 'APPLICATION_ERROR' ? 500 : 503,
        failureCode === 'PROVIDER_ERROR' || failureCode === 'APPLICATION_ERROR',
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      for (const span of toolSpans.values()) span.end();
      rootSpan.setAttributes({
        status: terminalStatus,
        ...(failureCode ? { failureCode } : {}),
      });
      if (terminalStatus !== 'succeeded') rootSpan.setStatus('error');
      rootSpan.end();
      const finishedAt = this.options.clock.now().toISOString();
      run = {
        ...run,
        status: terminalStatus,
        updatedAt: finishedAt,
        finishedAt,
        ...(failureCode ? { failureCode } : {}),
        version: 2,
      };
      try {
        await this.options.store.withTransaction((repositories) =>
          repositories.agentRuns.update(run, 1),
        );
      } catch {
        // Preserve the original planning result/error if persistence of the
        // terminal bookkeeping is unavailable.
      }
      try {
        await this.telemetry.flush();
      } catch {
        // Exporter failure must never fail the agent run.
      }
      if (this.metrics) {
        const metricStatus =
          terminalStatus === 'succeeded'
            ? 'succeeded'
            : terminalStatus === 'aborted'
              ? 'aborted'
              : terminalStatus === 'timed_out'
                ? 'timed_out'
                : 'failed';
        try {
          this.metrics.increment('pi_agent_runs_total', {
            run_type: 'planning',
            status: metricStatus,
            provider: this.provider === 'faux' ? 'faux' : 'hosted',
          });
          this.metrics.observe(
            'pi_agent_duration_seconds',
            { run_type: 'planning', status: metricStatus },
            Math.max(0, (Date.now() - runStartedAt) / 1_000),
          );
        } catch {
          // Metrics are diagnostic and cannot change the planning result.
        }
      }
      release();
    }
  }
}
