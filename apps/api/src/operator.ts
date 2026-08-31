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
  createOperationalReadTools,
  validateOperationalRecommendation,
  type OperationalAttemptToolView,
  type OperationalExecutorToolView,
  type OperationalIncidentToolView,
  type OperationalProjectToolView,
  type OperationalRecommendationOutput,
  type OperationalShotToolView,
  type OperationalToolContext,
  type OperationalToolServices,
  type OperationalWorkflowRevisionToolView,
} from '@h3/agent-tools';
import {
  isUuidV7,
  subtractMicrousd,
  toIsoUtc,
  type Clock,
  type DomainEvent,
  type IdGenerator,
  type Uuid,
} from '@h3/domain';
import {
  type OutboxDispatcher,
  RepositoryError,
  type AgentRunFailureCode,
  type AgentRunRecord,
  type AgentRunStatus,
  type OperationalRecommendationRecord,
  type RecommendationActionType,
  type RecommendationSeverity,
  type Repositories,
  type TransactionalStore,
  type OutboxConsumer,
  type OutboxMessage,
} from '@h3/db';
import {
  type AgentTelemetry,
  InMemoryTelemetry,
  type MetricsRegistry,
  type TraceId,
  type TelemetryAttributes,
  type TelemetrySpanHandle,
} from '@h3/telemetry';

export const OPERATIONAL_TRIGGER_EVENT_TYPES = [
  'workflow.revision.invalid',
  'executor.unavailable',
  'attempt.failed',
  'attempt.timed_out',
  'attempt.rejected',
  'attempt.submission_uncertain',
] as const satisfies readonly DomainEvent['type'][];

export type OperationalTriggerEventType =
  (typeof OPERATIONAL_TRIGGER_EVENT_TYPES)[number];

const operationalTriggerSet = new Set<string>(OPERATIONAL_TRIGGER_EVENT_TYPES);

const RECOVERABLE_ATTEMPT_CODES = new Set([
  'COMFY_UNAVAILABLE',
  'COMFY_EXECUTION_FAILED',
  'CAPABILITY_DRIFT',
  'GENERATION_TIMEOUT',
  'ARTIFACT_DOWNLOAD_FAILED',
  'ARTIFACT_STORAGE_FAILED',
]);

export interface FauxOperationalScript {
  readonly output?: unknown;
  readonly duplicateToolCall?: boolean;
  readonly providerError?: string;
  readonly abort?: boolean;
  readonly timeoutMs?: number;
}

export type OperationalToolServiceFactory = (
  repositories: Repositories,
) => OperationalToolServices;

export interface OperationalPiAdapterOptions {
  readonly store: TransactionalStore;
  readonly tenantId: Uuid;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly provider?: string;
  readonly model?: string;
  readonly telemetry?: AgentTelemetry;
  readonly metrics?: MetricsRegistry;
  readonly services: OperationalToolServiceFactory;
  readonly script?: FauxOperationalScript;
}

export interface OperationalPiProcessResult {
  readonly handled: boolean;
  readonly duplicate: boolean;
  readonly reason?: 'not_trigger' | 'out_of_scope' | 'resource_not_found';
  readonly recommendation?: OperationalRecommendationRecord;
  readonly agentRun?: AgentRunRecord;
}

export interface OperationalRuntimeOptions {
  readonly mode: string;
  readonly getExecutorReadiness: () => Promise<OperationalExecutorToolView>;
}

function eventPayloadUuid(event: DomainEvent, key: string): Uuid | undefined {
  const value = event.payload[key];
  return isUuidV7(value) ? value : undefined;
}

function safeEventCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9_.-]{0,63}$/.test(candidate) ? candidate : undefined;
}

function eventPayloadCode(event: DomainEvent): string | undefined {
  return safeEventCode(event.payload.code);
}

function isOperationalTrigger(
  event: DomainEvent,
): event is DomainEvent & { readonly type: OperationalTriggerEventType } {
  return operationalTriggerSet.has(event.type);
}

function recommendationCodeFor(
  event: DomainEvent & { readonly type: OperationalTriggerEventType },
): string {
  switch (event.type) {
    case 'workflow.revision.invalid':
      return 'WORKFLOW_REVISION_INVALID';
    case 'executor.unavailable':
      return 'EXECUTOR_UNAVAILABLE';
    case 'attempt.failed':
      return 'ATTEMPT_FAILED';
    case 'attempt.timed_out':
      return 'ATTEMPT_TIMED_OUT';
    case 'attempt.rejected':
      return 'ATTEMPT_REJECTED';
    case 'attempt.submission_uncertain':
      return 'ATTEMPT_SUBMISSION_UNCERTAIN';
  }
}

function defaultActionFor(
  event: DomainEvent & { readonly type: OperationalTriggerEventType },
  hasAttempt: boolean,
  hasRevision: boolean,
): RecommendationActionType {
  switch (event.type) {
    case 'executor.unavailable':
      return 'wait_for_executor';
    case 'workflow.revision.invalid':
      return hasRevision ? 'open_workflow_revision' : 'request_human_review';
    case 'attempt.submission_uncertain':
      return 'request_human_review';
    case 'attempt.rejected':
      return hasAttempt ? 'retry_attempt' : 'request_human_review';
    case 'attempt.timed_out':
      return hasAttempt ? 'retry_attempt' : 'request_human_review';
    case 'attempt.failed': {
      const code = eventPayloadCode(event);
      return hasAttempt &&
        code !== 'COMFY_SUBMISSION_UNCERTAIN' &&
        (code === undefined || RECOVERABLE_ATTEMPT_CODES.has(code))
        ? 'retry_attempt'
        : 'request_human_review';
    }
  }
}

function allowedActionsFor(
  event: DomainEvent & { readonly type: OperationalTriggerEventType },
  hasAttempt: boolean,
  hasRevision: boolean,
): readonly RecommendationActionType[] {
  const fallback = defaultActionFor(event, hasAttempt, hasRevision);
  if (event.type === 'executor.unavailable') {
    return ['wait_for_executor', 'no_action'];
  }
  if (event.type === 'workflow.revision.invalid') {
    return hasRevision
      ? ['open_workflow_revision', 'request_human_review', 'no_action']
      : ['request_human_review', 'no_action'];
  }
  if (event.type === 'attempt.submission_uncertain') {
    return ['request_human_review', 'no_action'];
  }
  if (fallback === 'retry_attempt') {
    return ['retry_attempt', 'request_human_review', 'no_action'];
  }
  return ['request_human_review', 'no_action'];
}

function defaultOutput(
  event: DomainEvent & { readonly type: OperationalTriggerEventType },
  hasAttempt: boolean,
  hasRevision: boolean,
): OperationalRecommendationOutput {
  const action = defaultActionFor(event, hasAttempt, hasRevision);
  const code = recommendationCodeFor(event);
  const titles: Record<OperationalTriggerEventType, string> = {
    'workflow.revision.invalid': 'Review the invalid workflow revision',
    'executor.unavailable': 'Wait for the executor to recover',
    'attempt.failed': 'Review the failed generation attempt',
    'attempt.timed_out': 'Review the timed-out generation attempt',
    'attempt.rejected': 'Consider retrying the rejected attempt',
    'attempt.submission_uncertain': 'Resolve the uncertain submission first',
  };
  const details: Record<OperationalTriggerEventType, string> = {
    'workflow.revision.invalid':
      'The persisted workflow revision did not pass validation and requires human review.',
    'executor.unavailable':
      'The execution service is unavailable; no generation action was started.',
    'attempt.failed':
      'The attempt reached a failed state. Any retry remains a human-approved action.',
    'attempt.timed_out':
      'The attempt exceeded its runtime limit. Any retry remains a human-approved action.',
    'attempt.rejected':
      'The attempt was rejected during review. Any retry remains a human-approved action.',
    'attempt.submission_uncertain':
      'The submission outcome must be reconciled or explicitly resolved before a retry.',
  };
  return {
    severity: event.type === 'executor.unavailable' ? 'critical' : 'warning',
    recommendationCode: code,
    title: titles[event.type],
    detail: details[event.type],
    proposedActionType: action,
  };
}

function safeRecommendationText(value: string, fallback: string): string {
  const sanitized = value
    .replace(/(?:raw\s+)?prompt(?:\s*[:=]|\s+)[^.;\n]*/gi, '[prompt redacted]')
    .replace(
      /\b(?:api[_ -]?key|secret|password|token)\s*[:=]\s*[^\s,;.]+/gi,
      '[credential redacted]',
    )
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/(?:\/|[A-Za-z]:\\)[^\s'"`]+/g, '[path redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return (sanitized || fallback).slice(0, 2_000);
}

function safeSeverity(value: RecommendationSeverity): RecommendationSeverity {
  return value === 'critical' || value === 'info' ? value : 'warning';
}

function safeAction(
  event: DomainEvent & { readonly type: OperationalTriggerEventType },
  requested: RecommendationActionType,
  hasAttempt: boolean,
  hasRevision: boolean,
): RecommendationActionType {
  const allowed = allowedActionsFor(event, hasAttempt, hasRevision);
  return allowed.includes(requested)
    ? requested
    : defaultActionFor(event, hasAttempt, hasRevision);
}

function recommendationResources(
  action: RecommendationActionType,
  event: DomainEvent,
  revisionId: Uuid | undefined,
): readonly string[] {
  switch (action) {
    case 'retry_attempt':
      return event.attemptId ? [event.attemptId] : [];
    case 'open_workflow_revision':
      return revisionId ? [revisionId] : [];
    case 'wait_for_executor':
      return event.projectId ? [event.projectId] : [];
    case 'request_human_review':
      return event.attemptId
        ? [event.attemptId]
        : event.projectId
          ? [event.projectId]
          : [];
    case 'no_action':
      return [];
  }
}

function recommendationEvidence(
  event: DomainEvent,
  revisionId: Uuid | undefined,
): readonly { readonly type: string; readonly resourceId: string }[] {
  const evidence: { type: string; resourceId: string }[] = [
    { type: 'domain_event', resourceId: event.id },
  ];
  if (event.shotId) evidence.push({ type: 'shot', resourceId: event.shotId });
  if (event.attemptId) {
    evidence.push({ type: 'attempt', resourceId: event.attemptId });
  }
  if (revisionId) {
    evidence.push({ type: 'workflow_revision', resourceId: revisionId });
  }
  return evidence;
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

function telemetryAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
): TelemetryAttributes {
  if (!attributes) return {};
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
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
      telemetryAttributes(options.attributes),
      parentSpan,
    );
    return {
      addEvent: (name, attributes) =>
        span.addEvent(name, telemetryAttributes(attributes)),
      setAttributes: (attributes) =>
        span.setAttributes(telemetryAttributes(attributes)),
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

function failureCodeFor(error: unknown): AgentRunFailureCode {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'PROVIDER_ERROR' ||
      error.code === 'ABORTED' ||
      error.code === 'TIMEOUT' ||
      error.code === 'INVALID_STRUCTURED_OUTPUT' ||
      error.code === 'POLICY_DENIED' ||
      error.code === 'APPLICATION_ERROR')
  ) {
    return error.code;
  }
  return 'APPLICATION_ERROR';
}

function asAgentRunStatus(success: boolean, error: unknown): AgentRunStatus {
  if (success) return 'succeeded';
  return failureCodeFor(error) === 'ABORTED' ? 'aborted' : 'failed';
}

function toolCallsFor(
  event: DomainEvent,
  revisionId: Uuid | undefined,
): readonly {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}[] {
  if (!event.projectId) return [];
  const calls: {
    name: string;
    arguments: Readonly<Record<string, unknown>>;
  }[] = [
    {
      name: 'get_project_status',
      arguments: { projectId: event.projectId },
    },
  ];
  if (event.shotId) {
    calls.push({
      name: 'get_shot_status',
      arguments: { projectId: event.projectId, shotId: event.shotId },
    });
  }
  if (event.attemptId) {
    calls.push({
      name: 'get_attempt_status',
      arguments: { projectId: event.projectId, attemptId: event.attemptId },
    });
  }
  if (revisionId && event.shotId) {
    calls.push({
      name: 'get_workflow_revision_validation',
      arguments: {
        projectId: event.projectId,
        shotId: event.shotId,
        revisionId,
      },
    });
  }
  calls.push({
    name: 'get_recent_incidents',
    arguments: { projectId: event.projectId },
  });
  if (
    event.type === 'executor.unavailable' ||
    eventPayloadCode(event) === 'COMFY_UNAVAILABLE'
  ) {
    calls.push({ name: 'get_executor_readiness', arguments: {} });
  }
  return calls;
}

interface OperatorRunResult {
  readonly output: OperationalRecommendationOutput;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly providerCostMicrousd: number;
}

export class OperationalPiAdapter {
  readonly store: TransactionalStore;
  readonly tenantId: Uuid;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly provider: string;
  readonly modelName: string;
  readonly telemetry: AgentTelemetry;
  readonly metrics: MetricsRegistry | undefined;
  readonly services: OperationalToolServiceFactory;
  readonly script: FauxOperationalScript | undefined;

  constructor(options: OperationalPiAdapterOptions) {
    this.store = options.store;
    this.tenantId = options.tenantId;
    this.clock = options.clock ?? { now: () => new Date() };
    this.idGenerator = options.idGenerator ?? {
      next: () => {
        throw new Error('An operational Pi ID generator is required.');
      },
    };
    this.provider = options.provider ?? 'faux';
    this.modelName = options.model ?? 'h3-videoops-operator-v1';
    this.telemetry = options.telemetry ?? new InMemoryTelemetry();
    this.metrics = options.metrics;
    this.services = options.services;
    this.script = options.script;
  }

  async processEvent(event: DomainEvent): Promise<OperationalPiProcessResult> {
    return this.store.withTransaction((repositories) =>
      this.processEventInTransaction(repositories, event),
    );
  }

  async processEventInTransaction(
    repositories: Repositories,
    event: DomainEvent,
  ): Promise<OperationalPiProcessResult> {
    if (!isOperationalTrigger(event)) {
      return { handled: false, duplicate: false, reason: 'not_trigger' };
    }
    if (event.tenantId !== this.tenantId || !event.projectId) {
      return { handled: false, duplicate: false, reason: 'out_of_scope' };
    }

    const recommendationCode = recommendationCodeFor(event);
    const existing =
      await repositories.operationalRecommendations.findByTriggerEventAndCode(
        this.tenantId,
        event.id,
        recommendationCode,
      );
    if (existing) {
      const existingRun = existing.piAgentRunId
        ? await repositories.agentRuns.findById(
            this.tenantId,
            existing.piAgentRunId,
          )
        : undefined;
      return {
        handled: true,
        duplicate: true,
        recommendation: existing,
        ...(existingRun ? { agentRun: existingRun } : {}),
      };
    }

    const services = this.services(repositories);
    const project = await services.getProjectStatus(
      this.tenantId,
      event.projectId,
    );
    if (!project || project.id !== event.projectId) {
      return {
        handled: false,
        duplicate: false,
        reason: 'resource_not_found',
      };
    }

    const revisionId = eventPayloadUuid(event, 'workflowRevisionId');
    const hasShot = event.shotId
      ? await services.getShotStatus(
          this.tenantId,
          event.projectId,
          event.shotId,
        )
      : undefined;
    if (event.shotId && (!hasShot || hasShot.projectId !== event.projectId)) {
      return {
        handled: false,
        duplicate: false,
        reason: 'resource_not_found',
      };
    }

    const hasAttempt = event.attemptId
      ? await services.getAttemptStatus(
          this.tenantId,
          event.projectId,
          event.attemptId,
        )
      : undefined;
    if (
      event.attemptId &&
      (!hasAttempt ||
        hasAttempt.projectId !== event.projectId ||
        (event.shotId !== undefined && hasAttempt.shotId !== event.shotId))
    ) {
      return {
        handled: false,
        duplicate: false,
        reason: 'resource_not_found',
      };
    }

    const hasRevision =
      revisionId && event.shotId
        ? await services.getWorkflowRevisionValidation(
            this.tenantId,
            event.projectId,
            event.shotId,
            revisionId,
          )
        : undefined;
    if (
      revisionId &&
      event.shotId &&
      (!hasRevision ||
        hasRevision.projectId !== event.projectId ||
        hasRevision.shotId !== event.shotId)
    ) {
      return {
        handled: false,
        duplicate: false,
        reason: 'resource_not_found',
      };
    }

    const runId = event.id;
    let run = await repositories.agentRuns.findById(this.tenantId, runId);
    if (!run) {
      const startedAt = toIsoUtc(this.clock.now());
      run = {
        id: runId,
        tenantId: this.tenantId,
        projectId: event.projectId,
        runId,
        sessionId: `pi-operator-${runId}`,
        objective:
          'Recommend a bounded operational action from durable evidence.',
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
      await repositories.agentRuns.create(run);
    }

    const recommendationSpan = this.telemetry.startRootSpan
      ? this.telemetry.startRootSpan(
          'operator.recommend',
          { eventType: event.type, status: 'running' },
          event.traceId as TraceId | undefined,
        )
      : this.telemetry.startSpan('operator.recommend', {
          eventType: event.type,
          status: 'running',
        });
    const runStartedAt = Date.now();
    let runResult: OperatorRunResult | undefined;
    let runError: unknown;
    try {
      runResult = await this.runPi(event, {
        project,
        ...(hasShot ? { shot: hasShot } : {}),
        ...(hasAttempt ? { attempt: hasAttempt } : {}),
        ...(hasRevision ? { revision: hasRevision } : {}),
        services,
      });
      recommendationSpan.setStatus('ok');
    } catch (error) {
      runError = error;
      recommendationSpan.setStatus('error', error);
    } finally {
      recommendationSpan.setAttributes({
        result: runError ? 'failure' : 'success',
        durationMs: Math.max(0, Date.now() - runStartedAt),
      });
      recommendationSpan.end();
    }

    const fallback = defaultOutput(
      event,
      hasAttempt !== undefined,
      hasRevision !== undefined,
    );
    const output = runResult?.output ?? fallback;
    const terminalStatus = asAgentRunStatus(!runError, runError);
    const finishedAt = toIsoUtc(this.clock.now());
    const terminalRun: AgentRunRecord = {
      ...run,
      status: terminalStatus,
      toolCalls: runResult?.toolCalls ?? run.toolCalls,
      inputTokens: runResult?.inputTokens ?? run.inputTokens,
      outputTokens: runResult?.outputTokens ?? run.outputTokens,
      totalTokens: runResult?.totalTokens ?? run.totalTokens,
      cacheReadTokens: runResult?.cacheReadTokens ?? run.cacheReadTokens,
      cacheWriteTokens: runResult?.cacheWriteTokens ?? run.cacheWriteTokens,
      providerCostMicrousd:
        runResult?.providerCostMicrousd ?? run.providerCostMicrousd,
      finishedAt,
      ...(runError ? { failureCode: failureCodeFor(runError) } : {}),
      version: run.version + 1,
      updatedAt: finishedAt,
    };
    await repositories.agentRuns.update(terminalRun, run.version);

    const action = safeAction(
      event,
      output.proposedActionType,
      hasAttempt !== undefined,
      hasRevision !== undefined,
    );
    const recommendation: OperationalRecommendationRecord = {
      id: this.idGenerator.next(),
      tenantId: this.tenantId,
      projectId: event.projectId,
      ...(event.shotId ? { shotId: event.shotId } : {}),
      ...(event.attemptId ? { attemptId: event.attemptId } : {}),
      triggerEventId: event.id,
      piAgentRunId: terminalRun.id,
      severity: safeSeverity(output.severity),
      recommendationCode,
      title: safeRecommendationText(
        output.title,
        'Review the operational event.',
      ).slice(0, 240),
      detail: safeRecommendationText(
        output.detail,
        'The event requires human review before an operational action.',
      ),
      evidenceReferencesJson: recommendationEvidence(event, hasRevision?.id),
      proposedActionType: action,
      proposedResourceIdsJson: recommendationResources(
        action,
        event,
        hasRevision?.id,
      ),
      status: 'pending',
      version: 1,
      createdAt: finishedAt,
      updatedAt: finishedAt,
    };
    try {
      await repositories.operationalRecommendations.create(recommendation);
    } catch (error) {
      if (
        error instanceof RepositoryError &&
        error.code === 'UNIQUE_VIOLATION'
      ) {
        const duplicate =
          await repositories.operationalRecommendations.findByTriggerEventAndCode(
            this.tenantId,
            event.id,
            recommendationCode,
          );
        if (duplicate) {
          return {
            handled: true,
            duplicate: true,
            recommendation: duplicate,
            agentRun: terminalRun,
          };
        }
      }
      throw error;
    }
    if (this.metrics) {
      try {
        this.metrics.increment('pi_agent_runs_total', {
          run_type: 'operator',
          status: runError ? 'failure' : 'success',
          provider: this.provider === 'faux' ? 'faux' : 'hosted',
        });
        this.metrics.observe(
          'pi_agent_duration_seconds',
          { run_type: 'operator', status: runError ? 'failure' : 'success' },
          Math.max(0, (Date.now() - runStartedAt) / 1_000),
        );
        this.metrics.increment('video_operator_recommendations_total', {
          code: recommendationCode,
          status: recommendation.status,
          severity: recommendation.severity,
        });
      } catch {
        // Metrics are diagnostic and cannot change the recommendation result.
      }
    }
    return {
      handled: true,
      duplicate: false,
      recommendation,
      agentRun: terminalRun,
    };
  }

  private async runPi(
    event: DomainEvent & { readonly type: OperationalTriggerEventType },
    evidence: {
      readonly project: OperationalProjectToolView;
      readonly shot?: OperationalShotToolView;
      readonly attempt?: OperationalAttemptToolView;
      readonly revision?: OperationalWorkflowRevisionToolView;
      readonly services: OperationalToolServices;
    },
  ): Promise<OperatorRunResult> {
    const rootSpan = this.telemetry.startRootSpan
      ? this.telemetry.startRootSpan(
          'agent.operator.run',
          {
            provider: this.provider,
            model: this.modelName,
            eventType: event.type,
            status: 'running',
          },
          event.traceId as TraceId | undefined,
        )
      : this.telemetry.startSpan('agent.operator.run', {
          provider: this.provider,
          model: this.modelName,
          eventType: event.type,
          status: 'running',
        });
    let toolsUsed = 0;
    let terminalStatus: 'ok' | 'error' = 'error';
    try {
      if (this.provider !== 'faux') {
        const error = Object.assign(
          new Error('The operational faux provider is not enabled.'),
          { code: 'PROVIDER_ERROR' },
        );
        throw error;
      }
      const revisionId = evidence.revision?.id;
      const output =
        this.script?.output ??
        defaultOutput(
          event,
          evidence.attempt !== undefined,
          evidence.revision !== undefined,
        );
      const calls = toolCallsFor(event, revisionId).map((call, index) =>
        fauxToolCall(call.name, call.arguments, {
          id: `${event.id}-operator-tool-${index}`,
        }),
      );
      const toolCalls = this.script?.duplicateToolCall
        ? [
            ...(calls[0] ? [calls[0]] : []),
            ...(calls[0]
              ? [
                  fauxToolCall(calls[0].name, calls[0].arguments, {
                    id: calls[0].id,
                  }),
                ]
              : []),
            ...calls.slice(1),
          ]
        : calls;
      const faux = fauxProvider({
        provider: this.provider,
        models: [{ id: this.modelName, name: this.modelName }],
      });
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
      const models = createModels();
      models.setProvider(faux.provider);
      const model = faux.getModel() as Model<Api>;
      const toolContext: OperationalToolContext = {
        tenantId: this.tenantId,
        projectId: event.projectId as Uuid,
        ...(event.shotId ? { shotId: event.shotId } : {}),
        ...(event.attemptId ? { attemptId: event.attemptId } : {}),
        ...(revisionId ? { workflowRevisionId: revisionId } : {}),
        services: evidence.services,
        onPolicyDenial: (code, operation) =>
          rootSpan.addEvent('policy.denial', { code, operation }),
      };
      const tools = createOperationalReadTools(toolContext);
      const piContext = piTelemetryContext(this.telemetry, rootSpan);
      const streamFn: StreamFn = (streamModel, context, streamOptions) =>
        models.streamSimple(streamModel, context, {
          ...streamOptions,
          telemetryContext: piContext,
        });
      const agent = new Agent({
        sessionId: `pi-operator-${event.id}`,
        streamFn,
        toolExecution: 'sequential',
        initialState: {
          model,
          systemPrompt:
            'Use only the provided read-only evidence tools. Return one strict JSON operational recommendation. Never request or describe infrastructure access.',
          tools,
        },
      });
      agent.subscribe((agentEvent: AgentEvent) => {
        try {
          if (agentEvent.type === 'tool_execution_start') {
            toolsUsed += 1;
            const span = this.telemetry.startSpan(
              'agent.operator.tool',
              { tool: agentEvent.toolName, outcome: 'started' },
              rootSpan,
            );
            span.end();
          }
        } catch {
          // Telemetry cannot affect recommendation generation.
        }
      });
      if (this.script?.abort) agent.abort();
      const timeoutMs = Math.max(100, this.script?.timeoutMs ?? 10_000);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        agent.abort();
      }, timeoutMs);
      try {
        await agent.prompt(`Review durable event ${event.id}.`);
        await agent.waitForIdle();
      } finally {
        clearTimeout(timeout);
      }
      if (timedOut) {
        throw Object.assign(new Error('Operational Pi run timed out.'), {
          code: 'TIMEOUT',
        });
      }
      if (this.script?.abort) {
        throw Object.assign(new Error('Operational Pi run was aborted.'), {
          code: 'ABORTED',
        });
      }
      const messages = assistantMessages(agent.state.messages);
      const final = messages.at(-1);
      if (!final || final.stopReason === 'error') {
        throw Object.assign(
          new Error('Operational Pi provider did not return a recommendation.'),
          { code: 'PROVIDER_ERROR' },
        );
      }
      const validated = validateOperationalRecommendation(
        JSON.parse(assistantText(final)),
      );
      const totals = usageTotals(messages);
      terminalStatus = 'ok';
      rootSpan.setAttributes({
        status: 'succeeded',
        recommendationCode: validated.recommendationCode,
        proposedActionType: validated.proposedActionType,
      });
      return { ...totals, output: validated, toolCalls: toolsUsed };
    } catch (error) {
      rootSpan.setAttributes({
        status: 'failed',
        failureCode: failureCodeFor(error),
      });
      throw error;
    } finally {
      rootSpan.setStatus(terminalStatus);
      rootSpan.end();
      try {
        await this.telemetry.flush();
      } catch {
        // Telemetry exporter failures cannot affect the operational run.
      }
    }
  }
}

/** Creates only typed, sanitized callbacks for the operational Pi tools. */
export function createOperationalToolServices(
  repositories: Repositories,
  tenantId: Uuid,
  runtime: OperationalRuntimeOptions,
): OperationalToolServices {
  return {
    getProjectStatus: async (
      requestedTenantId,
      projectId,
    ): Promise<OperationalProjectToolView | null> => {
      if (requestedTenantId !== tenantId) return null;
      const project = await repositories.projects.findById(tenantId, projectId);
      if (!project) return null;
      return {
        id: project.id,
        status: project.status,
        budgetMicrousd: project.budgetMicrousd,
        spentMicrousd: project.spentMicrousd,
        remainingMicrousd: subtractMicrousd(
          project.budgetMicrousd,
          project.spentMicrousd,
        ),
      };
    },
    getShotStatus: async (
      requestedTenantId,
      projectId,
      shotId,
    ): Promise<OperationalShotToolView | null> => {
      if (requestedTenantId !== tenantId) return null;
      const project = await repositories.projects.findById(tenantId, projectId);
      const shot = await repositories.shots.findById(projectId, shotId);
      if (!project || !shot || project.tenantId !== tenantId) return null;
      return {
        id: shot.id,
        projectId: shot.projectId,
        status: shot.status,
        acceptanceCriteria: (shot.acceptanceCriteria ?? [])
          .filter(
            (criterion): criterion is string =>
              typeof criterion === 'string' && criterion.trim().length > 0,
          )
          .slice(0, 8)
          .map((criterion) => criterion.trim().slice(0, 280)),
      };
    },
    getWorkflowRevisionValidation: async (
      requestedTenantId,
      projectId,
      shotId,
      revisionId,
    ): Promise<OperationalWorkflowRevisionToolView | null> => {
      if (requestedTenantId !== tenantId) return null;
      const revision = await repositories.workflowRevisions.findById(
        tenantId,
        projectId,
        shotId,
        revisionId,
      );
      if (!revision) return null;
      return {
        id: revision.id,
        projectId: revision.projectId,
        shotId: revision.shotId,
        profileId: revision.profileId,
        profileVersion: revision.profileVersion,
        validationStatus: revision.validationStatus,
        validationErrors: revision.validationErrorsJson
          .slice(0, 16)
          .map((issue) => ({
            code: issue.code.slice(0, 64),
            message: issue.message.slice(0, 500),
          })),
        ...(revision.executorFingerprint
          ? { executorFingerprint: revision.executorFingerprint.slice(0, 128) }
          : {}),
      };
    },
    getAttemptStatus: async (
      requestedTenantId,
      projectId,
      attemptId,
    ): Promise<OperationalAttemptToolView | null> => {
      if (requestedTenantId !== tenantId) return null;
      const attempt = await repositories.attempts.findById(tenantId, attemptId);
      if (!attempt || attempt.projectId !== projectId) return null;
      return {
        id: attempt.id,
        projectId: attempt.projectId,
        shotId: attempt.shotId,
        status: attempt.status,
        ...(attempt.failureCode ? { failureCode: attempt.failureCode } : {}),
      };
    },
    getRecentIncidents: async (
      requestedTenantId,
      projectId,
    ): Promise<readonly OperationalIncidentToolView[]> => {
      if (requestedTenantId !== tenantId) return [];
      const events = (
        await repositories.events.listByProject(projectId)
      ).filter((event) => event.tenantId === tenantId);
      return events
        .filter((event) =>
          /failed|denied|rejected|timeout|uncertain|unavailable|invalid/i.test(
            event.type,
          ),
        )
        .slice(-20)
        .map((event) => {
          const code = eventPayloadCode(event);
          const status = safeEventCode(event.payload.status) ?? 'INCIDENT';
          return {
            eventId: event.id,
            type: event.type,
            status,
            occurredAt: event.occurredAt,
            ...(code ? { code } : {}),
            ...(event.shotId ? { shotId: event.shotId } : {}),
            ...(event.attemptId ? { attemptId: event.attemptId } : {}),
          };
        });
    },
    getExecutorReadiness: async (): Promise<OperationalExecutorToolView> => {
      const readiness = await runtime.getExecutorReadiness();
      return {
        mode: runtime.mode,
        ready: readiness.ready === true,
        checkedAt: readiness.checkedAt,
        ...(readiness.capabilityFingerprint
          ? { capabilityFingerprint: readiness.capabilityFingerprint }
          : {}),
        ...(readiness.errorCode ? { errorCode: readiness.errorCode } : {}),
        ...(readiness.pendingCount !== undefined
          ? { pendingCount: readiness.pendingCount }
          : {}),
        ...(readiness.runningCount !== undefined
          ? { runningCount: readiness.runningCount }
          : {}),
      };
    },
  };
}

export class OperationalOutboxConsumer implements OutboxConsumer {
  constructor(private readonly adapter: OperationalPiAdapter) {}

  async consume(
    message: OutboxMessage,
    repositories?: Repositories,
  ): Promise<void> {
    if (repositories) {
      await this.adapter.processEventInTransaction(repositories, message.event);
      return;
    }
    await this.adapter.processEvent(message.event);
  }
}

export interface OperationalOutboxWorkerOptions {
  readonly dispatcher: OutboxDispatcher;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class OperationalOutboxWorker {
  readonly dispatcher: OutboxDispatcher;
  readonly sleep: (milliseconds: number) => Promise<void>;
  private stopping = false;
  private currentWork: Promise<boolean> | undefined;

  constructor(options: OperationalOutboxWorkerOptions) {
    this.dispatcher = options.dispatcher;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async processOnce(): Promise<boolean> {
    return this.dispatcher.pollOnce();
  }

  async run(intervalMilliseconds = 100): Promise<void> {
    this.stopping = false;
    while (!this.stopping) {
      this.currentWork = this.dispatcher.pollOnce();
      await this.currentWork;
      this.currentWork = undefined;
      if (!this.stopping) await this.sleep(intervalMilliseconds);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.currentWork;
  }
}
