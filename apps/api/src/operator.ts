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
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import {
  createOperationalReadTools,
  createOperationalSubmissionTool,
  describeOperationalEvidence,
  validateOperationalRecommendation,
  type OperationalAttemptToolView,
  type OperationalEvidenceViews,
  type OperationalExecutorToolView,
  type OperationalIncidentToolView,
  type OperationalProjectToolView,
  type OperationalRecommendationOutput,
  type OperationalShotToolView,
  type OperationalToolContext,
  type OperationalToolServices,
  type OperationalWorkflowRevisionToolView,
} from '@h3/agent-tools';
import { safeRecommendationText } from './redact.js';
import {
  createDomainEvent,
  isUuidV7,
  subtractMicrousd,
  toIsoUtc,
  type Clock,
  type DomainEvent,
  type IdGenerator,
  type Uuid,
} from '@h3/domain';
import type {
  OutboxDispatcher,
  AgentRunFailureCode,
  AgentRunRecord,
  AgentRunStatus,
  OperationalRecommendationRecord,
  RecommendationActionType,
  RecommendationSeverity,
  Repositories,
  TransactionalStore,
  OutboxConsumer,
  OutboxMessage,
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

/**
 * `submit_recommendation` calls bounced back to the model for repair before a
 * non-faux run gives up and falls to `defaultOutput()`. Counted across the
 * whole run, not consecutively -- the same way Claude Code counts its
 * structured-output retries, whose `MAX_STRUCTURED_OUTPUT_RETRIES` default
 * this shares (75-PHASE-7E step 3 follow-up, N4). An accepted submission
 * does not reset it, which is unreachable in practice: a lone accepted
 * submission terminates the batch.
 */
export const OPERATIONAL_SUBMISSION_MAX_REJECTIONS = 5;

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
  /** Required for any non-faux `provider`; resolved by `packages/config`. */
  readonly apiKey?: string;
  readonly producer?: string;
  readonly telemetry?: AgentTelemetry;
  readonly metrics?: MetricsRegistry;
  readonly services: OperationalToolServiceFactory;
  readonly script?: FauxOperationalScript;
  /** Non-faux run timeout. Ignored for `provider: 'faux'`, which uses `script.timeoutMs`. */
  readonly timeoutMs?: number;
  /**
   * Cumulative provider spend, in microusd, after which a non-faux run stops
   * at the next turn boundary. Pi's loop ends when the model stops calling
   * tools and has no iteration cap of its own, so without this the only bound
   * on a run that keeps calling tools is `timeoutMs`. Zero disables it.
   */
  readonly maxRunCostMicrousd?: number;
  /**
   * The same bound in tokens, for a provider that reports no cost. Zero
   * disables it. Either limit stops the run.
   */
  readonly maxRunTokens?: number;
  /**
   * Test-only. When set, bypasses real provider construction for a non-faux
   * `provider` -- the agent streams through this function instead of a real
   * DeepSeek connection. No test in this checkpoint may make a paid network
   * call (75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md step 3).
   */
  readonly streamFnOverride?: StreamFn;
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

/**
 * Which tier of the output path produced a run's finding (W5). `submitted`
 * is the intended path and everything after it is a degradation: `text`
 * recovered JSON from the model's prose, `rejected_cap` and `none` fell to
 * `defaultOutput()`, and `error` never got as far as looking. `faux` has no
 * tiers -- it parses a scripted response -- and is reported as itself so the
 * counter's total stays the operator's run count.
 */
export const OPERATOR_OUTPUT_TIERS = [
  'submitted',
  'text',
  'rejected_cap',
  'none',
  'error',
  'faux',
] as const;

export type OperatorOutputTier = (typeof OPERATOR_OUTPUT_TIERS)[number];

const operatorOutputTierSet = new Set<string>(OPERATOR_OUTPUT_TIERS);

/**
 * Carries the tier out of `runPi`'s throw, the way `code` already travels on
 * these errors -- `persistOutcome` needs it on the failure path too, and the
 * failure codes do not distinguish `rejected_cap` from `none`.
 */
function taggedWithTier(error: unknown, tier: OperatorOutputTier): unknown {
  if (typeof error === 'object' && error !== null && !('tier' in error)) {
    return Object.assign(error, { tier });
  }
  return error;
}

function outputTierFor(error: unknown): OperatorOutputTier {
  const tier = (error as { readonly tier?: unknown } | null | undefined)?.tier;
  return typeof tier === 'string' && operatorOutputTierSet.has(tier)
    ? (tier as OperatorOutputTier)
    : 'error';
}

interface OperatorRunResult {
  readonly output: OperationalRecommendationOutput;
  readonly tier: OperatorOutputTier;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly providerCostMicrousd: number;
}

/**
 * Durable evidence views. Plain data -- safe to hold across a commit. The one
 * declaration lives in `@h3/agent-tools` beside `describeOperationalEvidence`,
 * which renders exactly these views into the prompt (W6); this name is what
 * the adapter calls them.
 */
type ResolvedOperationalViews = OperationalEvidenceViews;

/**
 * Views plus the tool services that resolved them. `services` is bound to one
 * set of `Repositories`, and therefore to one transaction, so it must never
 * outlive it. The deferred path keeps only the views across its commit and
 * rebuilds services against the store (`storeBackedServices`).
 */
interface ResolvedOperationalEvidence extends ResolvedOperationalViews {
  readonly services: OperationalToolServices;
}

/** What `runModel` produces, before anything is written. */
interface OperatorModelOutcome {
  readonly runResult: OperatorRunResult | undefined;
  readonly runError: unknown;
  readonly startedAt: number;
}

export class OperationalPiAdapter {
  readonly store: TransactionalStore;
  readonly tenantId: Uuid;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly provider: string;
  readonly modelName: string;
  readonly apiKey: string | undefined;
  readonly producer: string;
  readonly telemetry: AgentTelemetry;
  readonly metrics: MetricsRegistry | undefined;
  readonly services: OperationalToolServiceFactory;
  readonly script: FauxOperationalScript | undefined;
  readonly timeoutMs: number;
  readonly maxRunCostMicrousd: number;
  readonly maxRunTokens: number;
  readonly streamFnOverride: StreamFn | undefined;

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
    this.apiKey = options.apiKey;
    this.producer = options.producer ?? 'h3-operator';
    this.telemetry = options.telemetry ?? new InMemoryTelemetry();
    this.metrics = options.metrics;
    this.services = options.services;
    this.script = options.script;
    this.timeoutMs = Math.max(100, options.timeoutMs ?? 30_000);
    // ~100x the $0.0005 the phase doc's spike recorded per finding.
    this.maxRunCostMicrousd = Math.max(0, options.maxRunCostMicrousd ?? 50_000);
    this.maxRunTokens = Math.max(0, options.maxRunTokens ?? 200_000);
    this.streamFnOverride = options.streamFnOverride;
  }

  /**
   * Processes one event in a transaction of its own.
   *
   * For a non-faux provider this is only the **first half**: it commits an
   * `agent_runs` row with status 'running' and returns `handled: true` with no
   * `recommendation`. `completeDeferredRun` -- which
   * `OperationalOutboxConsumer.afterCommit` calls once that transaction has
   * committed -- runs the model and persists the finding. A caller that needs
   * the finding must call both, in that order. `faux` still completes fully
   * here, which is why callers asserting on `result.recommendation` keep
   * working under the default provider.
   */
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

    const resolved = await this.resolveEvidence(repositories, event);
    if (!resolved.ok) {
      return { handled: false, duplicate: false, reason: 'resource_not_found' };
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

    if (this.provider !== 'faux') {
      // Defer the model call to `afterCommit`, once this claim transaction
      // has released the outbox row (75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md
      // step 3). The 'running' row above is already durable and visible;
      // `completeDeferredRun` finishes the job in a transaction of its own.
      // `faux` is exempt: it is a synchronous, free table lookup, and every
      // existing test depends on it completing inline, in this transaction.
      return { handled: true, duplicate: false, agentRun: run };
    }

    return this.completeRun(
      repositories,
      event,
      recommendationCode,
      run,
      resolved,
    );
  }

  /**
   * Finishes a non-faux run whose 'running' `agent_runs` row was committed
   * by `processEventInTransaction` above. Called from
   * `OperationalOutboxConsumer.afterCommit`, after the claim transaction has
   * committed (75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md step 3).
   *
   * The provider round trip runs with **no transaction open at all**, not
   * merely outside the outbox transaction: `runDeferred` commits its evidence
   * read before calling the model and opens a second short transaction to
   * persist the result. That is both halves of the `OutboxConsumer.afterCommit`
   * contract in `packages/db/src/index.ts` -- the claimed row's lock and the
   * pooled connection -- rather than only the first.
   *
   * Must never throw: `afterCommit`'s contract requires it, and the trigger
   * message is already delivered, so there is nothing left to retry for it --
   * a failure here leaves the run visibly 'running' rather than losing it
   * silently, which is a deliberate trade against ever re-running a paid
   * model call for the same event. `pi_agent_runs_total{status="failure"}` is
   * incremented so that "visibly" means something outside the row itself.
   */
  async completeDeferredRun(event: DomainEvent): Promise<void> {
    if (this.provider === 'faux' || !isOperationalTrigger(event)) return;
    if (event.tenantId !== this.tenantId || !event.projectId) return;

    const startedAt = Date.now();
    const span = this.startDeferredSpan(event);
    // `persistOutcome` counts a run itself. It can still have run and then
    // lost its transaction at COMMIT, so the flag says whether the counters
    // below would be a second count of the same run rather than the only one.
    const progress = { counted: false };
    let deferredError: unknown;
    try {
      await this.runDeferred(event, progress);
    } catch (error) {
      deferredError = error;
    }
    this.recordDeferredOutcome(
      span,
      deferredError,
      Date.now() - startedAt,
      progress.counted,
    );
  }

  /** Never throws -- the `afterCommit` contract holds even if telemetry fails. */
  private startDeferredSpan(
    event: DomainEvent,
  ): TelemetrySpanHandle | undefined {
    try {
      const attributes = { eventType: event.type };
      return this.telemetry.startRootSpan
        ? this.telemetry.startRootSpan(
            'operator.deferred_run',
            attributes,
            event.traceId as TraceId | undefined,
          )
        : this.telemetry.startSpan('operator.deferred_run', attributes);
    } catch {
      return undefined;
    }
  }

  /** Never throws. See `completeDeferredRun`. */
  private recordDeferredOutcome(
    span: TelemetrySpanHandle | undefined,
    deferredError: unknown,
    durationMs: number,
    alreadyCounted: boolean,
  ): void {
    try {
      span?.setStatus(deferredError ? 'error' : 'ok', deferredError);
      span?.setAttributes({
        result: deferredError ? 'failure' : 'success',
        durationMs: Math.max(0, durationMs),
        // The error object itself is dropped by `BufferedSpan.setStatus`, and
        // with no OTLP endpoint no span is exported at all -- so the code has
        // to be an attribute, and the counter below has to exist.
        ...(deferredError
          ? { failureCode: failureCodeFor(deferredError) }
          : {}),
      });
      span?.end();
    } catch {
      // Telemetry cannot break the `afterCommit` contract.
    }
    if (!deferredError || alreadyCounted) return;
    try {
      this.metrics?.increment('pi_agent_runs_total', {
        run_type: 'operator',
        status: 'failure',
        provider: 'hosted',
      });
      // Counted beside the run, so the tier family's total stays the
      // operator's run count. `error` is the honest tier here: whatever the
      // model reached, no finding arrived.
      this.metrics?.increment('video_operator_output_tier_total', {
        tier: 'error',
      });
    } catch {
      // Metrics are diagnostic and cannot change the outcome.
    }
  }

  /**
   * Three phases, so the model call holds nothing:
   * 1. a short transaction re-checks the guards and reads the evidence;
   * 2. the model call, with no transaction and no pooled connection;
   * 3. a short transaction persists the run, the finding, and its event.
   *
   * Phase 3 needs no repeat of phase 1's guards: `agentRuns.update` is an
   * optimistic-concurrency write against the version phase 1 read, and the
   * recommendation's unique trigger-and-code index covers the other race, so
   * a concurrent winner aborts this transaction instead of double-writing.
   */
  private async runDeferred(
    event: DomainEvent & { readonly type: OperationalTriggerEventType },
    progress: { counted: boolean },
  ): Promise<void> {
    const recommendationCode = recommendationCodeFor(event);

    const prepared = await this.store.withTransaction(async (repositories) => {
      const existing =
        await repositories.operationalRecommendations.findByTriggerEventAndCode(
          this.tenantId,
          event.id,
          recommendationCode,
        );
      // Already finished (or this event was never a fresh trigger to begin
      // with) -- nothing left to do.
      if (existing) return undefined;

      const run = await repositories.agentRuns.findById(
        this.tenantId,
        event.id,
      );
      if (run?.status !== 'running') return undefined;

      const resolved = await this.resolveEvidence(repositories, event);
      if (!resolved.ok) return undefined;

      // Keep the views, drop `resolved.services`: it is bound to this
      // transaction, which commits as soon as this callback returns.
      const views: ResolvedOperationalViews = {
        project: resolved.project,
        ...(resolved.shot ? { shot: resolved.shot } : {}),
        ...(resolved.attempt ? { attempt: resolved.attempt } : {}),
        ...(resolved.revision ? { revision: resolved.revision } : {}),
      };
      return { run, views };
    });
    if (!prepared) return;

    const outcome = await this.runModel(event, {
      ...prepared.views,
      services: this.storeBackedServices(),
    });

    await this.store.withTransaction(async (repositories) => {
      const persisted = await this.persistOutcome(
        repositories,
        event,
        recommendationCode,
        prepared.run,
        prepared.views,
        outcome,
      );
      progress.counted = true;
      return persisted;
    });
  }

  /**
   * The same read tools, each in a short transaction of its own, so the agent
   * loop holds no pooled connection between tool calls. Used only by the
   * deferred path; the `faux` path keeps its single-transaction services.
   *
   * `getExecutorReadiness` is the one case still holding a connection across a
   * network call -- it reaches ComfyUI, not PostgreSQL, and the factory
   * signature requires `Repositories` to build it. It is bounded by
   * `COMFY_REQUEST_TIMEOUT_MS`, and is reached only for executor triggers.
   */
  private storeBackedServices(): OperationalToolServices {
    const inTransaction = <Result>(
      work: (services: OperationalToolServices) => Promise<Result>,
    ): Promise<Result> =>
      this.store.withTransaction((repositories) =>
        work(this.services(repositories)),
      );
    return {
      getProjectStatus: (tenantId, projectId) =>
        inTransaction((services) =>
          services.getProjectStatus(tenantId, projectId),
        ),
      getShotStatus: (tenantId, projectId, shotId) =>
        inTransaction((services) =>
          services.getShotStatus(tenantId, projectId, shotId),
        ),
      getWorkflowRevisionValidation: (
        tenantId,
        projectId,
        shotId,
        revisionId,
      ) =>
        inTransaction((services) =>
          services.getWorkflowRevisionValidation(
            tenantId,
            projectId,
            shotId,
            revisionId,
          ),
        ),
      getAttemptStatus: (tenantId, projectId, attemptId) =>
        inTransaction((services) =>
          services.getAttemptStatus(tenantId, projectId, attemptId),
        ),
      getRecentIncidents: (tenantId, projectId) =>
        inTransaction((services) =>
          services.getRecentIncidents(tenantId, projectId),
        ),
      getExecutorReadiness: () =>
        inTransaction((services) => services.getExecutorReadiness()),
    };
  }

  /** Shared evidence resolution for the claim-transaction path and the deferred re-check. */
  private async resolveEvidence(
    repositories: Repositories,
    event: DomainEvent & { readonly type: OperationalTriggerEventType },
  ): Promise<
    | { readonly ok: false }
    | ({ readonly ok: true } & ResolvedOperationalEvidence)
  > {
    const projectId = event.projectId as Uuid;
    const services = this.services(repositories);
    const project = await services.getProjectStatus(this.tenantId, projectId);
    if (!project || project.id !== projectId) {
      return { ok: false };
    }

    const revisionId = eventPayloadUuid(event, 'workflowRevisionId');
    const shot = event.shotId
      ? await services.getShotStatus(this.tenantId, projectId, event.shotId)
      : undefined;
    if (event.shotId && (!shot || shot.projectId !== projectId)) {
      return { ok: false };
    }

    const attempt = event.attemptId
      ? await services.getAttemptStatus(
          this.tenantId,
          projectId,
          event.attemptId,
        )
      : undefined;
    if (
      event.attemptId &&
      (!attempt ||
        attempt.projectId !== projectId ||
        (event.shotId !== undefined && attempt.shotId !== event.shotId))
    ) {
      return { ok: false };
    }

    const revision =
      revisionId && event.shotId
        ? await services.getWorkflowRevisionValidation(
            this.tenantId,
            projectId,
            event.shotId,
            revisionId,
          )
        : undefined;
    if (
      revisionId &&
      event.shotId &&
      (!revision ||
        revision.projectId !== projectId ||
        revision.shotId !== event.shotId)
    ) {
      return { ok: false };
    }

    return {
      ok: true,
      services,
      project,
      ...(shot ? { shot } : {}),
      ...(attempt ? { attempt } : {}),
      ...(revision ? { revision } : {}),
    };
  }

  /**
   * Runs the model (or `defaultOutput()` fallback) and persists the finding,
   * both inside the caller's transaction. The `faux` path uses this; the
   * deferred path calls `runModel` and `persistOutcome` separately, with a
   * commit between them.
   */
  private async completeRun(
    repositories: Repositories,
    event: DomainEvent & { readonly type: OperationalTriggerEventType },
    recommendationCode: string,
    run: AgentRunRecord,
    evidence: ResolvedOperationalEvidence,
  ): Promise<OperationalPiProcessResult> {
    const outcome = await this.runModel(event, evidence);
    return this.persistOutcome(
      repositories,
      event,
      recommendationCode,
      run,
      evidence,
      outcome,
    );
  }

  /**
   * Runs the model and returns its outcome. Touches no repositories, so the
   * deferred path can call it with no transaction open and no pooled
   * connection held across the provider round trip.
   */
  private async runModel(
    event: DomainEvent & { readonly type: OperationalTriggerEventType },
    evidence: ResolvedOperationalEvidence,
  ): Promise<OperatorModelOutcome> {
    const {
      project,
      services,
      shot: hasShot,
      attempt: hasAttempt,
      revision: hasRevision,
    } = evidence;
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
    return { runResult, runError, startedAt: runStartedAt };
  }

  /** Persists the run, the finding, and its event, inside one transaction. */
  private async persistOutcome(
    repositories: Repositories,
    event: DomainEvent & { readonly type: OperationalTriggerEventType },
    recommendationCode: string,
    run: AgentRunRecord,
    views: ResolvedOperationalViews,
    outcome: OperatorModelOutcome,
  ): Promise<OperationalPiProcessResult> {
    const { attempt: hasAttempt, revision: hasRevision } = views;
    const { runResult, runError, startedAt: runStartedAt } = outcome;

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
      // `event.projectId` was already checked truthy in
      // `processEventInTransaction`, before this method (or the deferred
      // path) was ever reached.
      projectId: event.projectId as Uuid,
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
    // No UNIQUE_VIOLATION recovery here, by design (7E step 2 prerequisite
    // finding). PostgresOperationalRecommendationRepository.create() does
    // not translate 23505, and withDatabaseTransaction has no SAVEPOINT, so
    // a genuine collision aborts this whole transaction regardless of any
    // catch here -- there is nothing to recover into. `claimNext`'s
    // `SKIP LOCKED` plus the outbox row's event-id primary key mean two
    // workers never claim the same trigger message, so the collision this
    // guarded against cannot reach `create()` in the first place. If it
    // ever did, the raw error rolls the transaction back, the outbox
    // message retries, and the `existing` check above finds the committed
    // winner and returns a duplicate without re-running the model -- no
    // recovery branch required.
    await repositories.operationalRecommendations.create(recommendation);
    // Exactly one durable `recommendation.created` event per persisted
    // finding: this line is reached only when `create` above succeeded, so
    // the early `existing` return above is the only other path out of this
    // method, and it emits nothing.
    const recommendationCreatedEvent = createDomainEvent({
      id: this.idGenerator.next(),
      type: 'recommendation.created',
      producer: this.producer,
      tenantId: this.tenantId,
      ...(event.projectId ? { projectId: event.projectId } : {}),
      ...(event.shotId ? { shotId: event.shotId } : {}),
      ...(event.attemptId ? { attemptId: event.attemptId } : {}),
      ...(event.traceId ? { traceId: event.traceId } : {}),
      payload: {
        recommendationId: recommendation.id,
        severity: recommendation.severity,
        recommendationCode: recommendation.recommendationCode,
        proposedActionType: recommendation.proposedActionType,
        triggeringEventType: event.type,
      },
      clock: this.clock,
    });
    await repositories.events.append(recommendationCreatedEvent);
    await repositories.outbox.enqueue(recommendationCreatedEvent);
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
        // W5: how the finding arrived, so degradation is measured rather
        // than assumed. Beside the run counter, and mirrored by
        // `recordDeferredOutcome` when a deferred run never reaches here, so
        // this family's total is the operator's run count.
        this.metrics.increment('video_operator_output_tier_total', {
          tier: runResult ? runResult.tier : outputTierFor(runError),
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
    evidence: ResolvedOperationalEvidence,
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
    // Stays `error` until the run gets far enough to know better, so a throw
    // from anywhere above the extraction reports itself honestly. Declared
    // out here because the catch below has to read it.
    let outputTier: OperatorOutputTier = 'error';
    try {
      const revisionId = evidence.revision?.id;
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
      const piContext = piTelemetryContext(this.telemetry, rootSpan);
      const onToolStart = (toolName: string): void => {
        try {
          toolsUsed += 1;
          const span = this.telemetry.startSpan(
            'agent.operator.tool',
            { tool: toolName, outcome: 'started' },
            rootSpan,
          );
          span.end();
        } catch {
          // Telemetry cannot affect recommendation generation.
        }
      };

      let validated: OperationalRecommendationOutput;
      let totals: ReturnType<typeof usageTotals>;

      if (this.provider === 'faux') {
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
        const tools = createOperationalReadTools(toolContext);
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
          if (agentEvent.type === 'tool_execution_start') {
            onToolStart(agentEvent.toolName);
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
            new Error(
              'Operational Pi provider did not return a recommendation.',
            ),
            { code: 'PROVIDER_ERROR' },
          );
        }
        validated = validateOperationalRecommendation(
          JSON.parse(assistantText(final)),
        );
        outputTier = 'faux';
        totals = usageTotals(messages);
      } else {
        // Non-faux: a real (or test-overridden) provider via a terminal
        // `submit_recommendation` tool, three-tier degradation, and scoped
        // identifiers in the prompt
        // (75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md step 3, "Output
        // handling").
        const { model, streamFn: baseStreamFn } = this.resolveHostedModel();
        const readTools = createOperationalReadTools(toolContext);
        // W1/N1: the conclusion comes off this handle, which `execute`
        // fills. Nothing below reads the transcript for it.
        const submission = createOperationalSubmissionTool();
        const streamFn: StreamFn = (streamModel, context, streamOptions) =>
          baseStreamFn(streamModel, context, {
            ...streamOptions,
            ...(this.apiKey ? { apiKey: this.apiKey } : {}),
            telemetryContext: piContext,
          });
        // Pi's loop already ends when the model stops calling tools
        // (`dist/agent-loop.js:132`), the same condition Claude Code uses.
        // What it has no bound for is a model that keeps calling them, so
        // bound the spend rather than the turns.
        let budgetExhausted = false;
        const agent = new Agent({
          sessionId: `pi-operator-${event.id}`,
          streamFn,
          toolExecution: 'sequential',
          shouldStopAfterTurn: (turn) => {
            // N4: a model that keeps re-sending a submission we keep
            // bouncing is a runaway loop like any other, so it gets a bound
            // of its own. Same hook as the budget bound -- `AgentOptions`
            // takes one.
            if (
              submission.rejections() >= OPERATIONAL_SUBMISSION_MAX_REJECTIONS
            ) {
              rootSpan.addEvent('run.submission_rejected', {
                count: submission.rejections(),
                max: OPERATIONAL_SUBMISSION_MAX_REJECTIONS,
              });
              return true;
            }
            const spent = usageTotals(assistantMessages(turn.context.messages));
            const overCost =
              this.maxRunCostMicrousd > 0 &&
              spent.providerCostMicrousd >= this.maxRunCostMicrousd;
            // Not redundant with the cost ceiling: a provider that reports no
            // cost -- an unpriced or custom model -- would otherwise disable
            // that ceiling silently, leaving the wall clock as the only bound.
            const overTokens =
              this.maxRunTokens > 0 && spent.totalTokens >= this.maxRunTokens;
            if (!overCost && !overTokens) return false;
            budgetExhausted = true;
            // `outcome`/`value`/`max` rather than named keys: the telemetry
            // attribute allowlist is deliberately generic, and any key
            // containing "token" is rejected as credential-shaped by
            // `SENSITIVE_ATTRIBUTE_KEY`.
            rootSpan.addEvent('run.budget_exhausted', {
              outcome: overCost ? 'cost_microusd' : 'tokens',
              value: overCost ? spent.providerCostMicrousd : spent.totalTokens,
              max: overCost ? this.maxRunCostMicrousd : this.maxRunTokens,
            });
            return true;
          },
          initialState: {
            model,
            systemPrompt: OPERATIONAL_SYSTEM_PROMPT,
            tools: [...readTools, submission.tool],
          },
        });
        agent.subscribe((agentEvent: AgentEvent) => {
          if (agentEvent.type === 'tool_execution_start') {
            onToolStart(agentEvent.toolName);
          }
        });
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          agent.abort();
        }, this.timeoutMs);
        try {
          await agent.prompt(operationalPrompt(event, toolContext, evidence));
          await agent.waitForIdle();
        } finally {
          clearTimeout(timeout);
        }
        const messages = assistantMessages(agent.state.messages);
        const final = messages.at(-1);
        // W4: a conclusion the model actually reached is never thrown away
        // for a bound or a fault that arrived after it. Timeout, abort and
        // budget exhaustion become an attribute on a run that still delivers
        // the model's own finding, rather than a failure that persists the
        // lookup table in its place.
        const captured = submission.accepted();
        const interrupted = timedOut
          ? 'timed_out'
          : budgetExhausted
            ? 'budget_exhausted'
            : !final || final.stopReason === 'error'
              ? 'provider_error'
              : undefined;
        if (!captured) {
          if (timedOut) {
            throw Object.assign(new Error('Operational Pi run timed out.'), {
              code: 'TIMEOUT',
            });
          }
          if (!final || final.stopReason === 'error') {
            throw Object.assign(
              new Error(
                'Operational Pi provider did not return a recommendation.',
              ),
              { code: 'PROVIDER_ERROR' },
            );
          }
        }
        if (interrupted) rootSpan.setAttributes({ outcome: interrupted });
        // Which tier produced the finding, on the generic allowlisted
        // `result` key -- `outcome` already carries how the run *ended*.
        try {
          validated = extractOperationalOutput(
            captured,
            final ? assistantText(final) : '',
          );
        } catch (error) {
          outputTier =
            submission.rejections() >= OPERATIONAL_SUBMISSION_MAX_REJECTIONS
              ? 'rejected_cap'
              : 'none';
          rootSpan.setAttributes({ result: outputTier });
          throw error;
        }
        outputTier = captured ? 'submitted' : 'text';
        rootSpan.setAttributes({ result: outputTier });
        totals = usageTotals(messages);
      }

      terminalStatus = 'ok';
      rootSpan.setAttributes({
        status: 'succeeded',
        recommendationCode: validated.recommendationCode,
        proposedActionType: validated.proposedActionType,
      });
      return {
        ...totals,
        output: validated,
        tier: outputTier,
        toolCalls: toolsUsed,
      };
    } catch (error) {
      rootSpan.setAttributes({
        status: 'failed',
        failureCode: failureCodeFor(error),
      });
      throw taggedWithTier(error, outputTier);
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

  /**
   * Resolves the model and stream function for a non-faux run.
   * `streamFnOverride` (test-only) always wins over real provider
   * construction, regardless of `this.provider`'s value -- see
   * `OperationalPiAdapterOptions.streamFnOverride`.
   */
  private resolveHostedModel(): {
    readonly model: Model<Api>;
    readonly streamFn: StreamFn;
  } {
    if (this.streamFnOverride) {
      const shape = fauxProvider({
        provider: this.provider,
        models: [{ id: this.modelName, name: this.modelName }],
      }).getModel() as Model<Api>;
      return { model: shape, streamFn: this.streamFnOverride };
    }
    if (this.provider === 'deepseek') {
      const models = createModels();
      models.setProvider(deepseekProvider());
      const model = models.getModel('deepseek', this.modelName);
      if (!model) {
        throw Object.assign(
          new Error(`Unknown DeepSeek model "${this.modelName}".`),
          { code: 'PROVIDER_ERROR' },
        );
      }
      return {
        model,
        streamFn: (streamModel, context, options) =>
          models.streamSimple(streamModel, context, options),
      };
    }
    throw Object.assign(
      new Error(
        `The operational provider "${this.provider}" is not supported.`,
      ),
      { code: 'PROVIDER_ERROR' },
    );
  }
}

const OPERATIONAL_SYSTEM_PROMPT =
  'You are an operational monitor for a video-generation pipeline. Use ' +
  'only the provided read-only evidence tools to investigate the incident ' +
  'in your scope, then call submit_recommendation with your conclusion: ' +
  'severity ("info" | "warning" | "critical"), ' +
  'recommendationCode (a short SCREAMING_SNAKE_CASE code), title (at most ' +
  '240 characters), detail (at most 2000 characters), and ' +
  'proposedActionType (one of "retry_attempt", "open_workflow_revision", ' +
  '"wait_for_executor", "request_human_review", "no_action"). If that call ' +
  'comes back listing what to fix, correct exactly those points and call ' +
  'it again -- the run has no conclusion until one is accepted. Never ' +
  'request or describe infrastructure access, and never propose an action ' +
  'the evidence tools did not support.';

/**
 * Seeds what the adapter already knows: the scoped identifiers, so the model
 * stops guessing them, and (W6) the evidence `resolveEvidence` has already
 * read, so the model stops spending 2-4 round trips re-fetching rows this
 * process is holding. The tools stay available and authoritative -- the
 * seeded rows are rendered by `describeOperationalEvidence` through the same
 * sanitizers, so re-reading one returns the same JSON.
 */
function operationalPrompt(
  event: DomainEvent & { readonly type: OperationalTriggerEventType },
  context: OperationalToolContext,
  evidence: ResolvedOperationalViews,
): string {
  // Every entry is named as the tool's own parameter, so a model can copy one
  // straight into a call. The revision is the one place those differ: the
  // event payload calls it `workflowRevisionId`, the tool takes `revisionId`.
  const scope = [`projectId=${context.projectId}`];
  if (context.shotId) scope.push(`shotId=${context.shotId}`);
  if (context.attemptId) scope.push(`attemptId=${context.attemptId}`);
  if (context.workflowRevisionId) {
    scope.push(`revisionId=${context.workflowRevisionId}`);
  }
  return (
    `Review durable event ${event.id} (${event.type}) for this incident. ` +
    `Scoped identifiers available to the evidence tools: ${scope.join(', ')}.` +
    `\n\n${describeOperationalEvidence(evidence)}`
  );
}

function stripFencedCodeBlocks(text: string): string {
  const fenced = /```(?:[a-zA-Z0-9_-]*)?\s*([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null = fenced.exec(text);
  while (match) {
    if (match[1] !== undefined) blocks.push(match[1]);
    match = fenced.exec(text);
  }
  return blocks.length > 0 ? blocks.join('\n') : text;
}

/** Scans for the last top-level `{...}` span, ignoring braces inside string literals. */
function lastBalancedJsonObject(text: string): string | undefined {
  let depth = 0;
  let start = -1;
  let last: string | undefined;
  let inString = false;
  let escapeNext = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (char === '\\') {
        escapeNext = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        last = text.slice(start, index + 1);
      }
    }
  }
  return last;
}

/**
 * Three-tier degradation, because Pi's `openai-completions` transport never
 * sends `response_format` and `ToolChoice` has no `"required"` value, so
 * neither API-level structured output nor a forced tool call is reachable
 * (75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md step 3, "Output handling"):
 * 1. whatever `submit_recommendation`'s `execute` captured;
 * 2. else tolerant text extraction (strip fenced code blocks, take the last
 *    balanced JSON object);
 * 3. else throw, so the caller falls back to `defaultOutput()`.
 * `operationalRecommendationSchema` is the sole authority at every tier;
 * tier 1 has already been through it, inside the tool's `prepareArguments`,
 * so it is taken as-is here rather than parsed a second time.
 */
function extractOperationalOutput(
  submitted: OperationalRecommendationOutput | undefined,
  text: string,
): OperationalRecommendationOutput {
  if (submitted) return submitted;
  const invalidStructuredOutput = (cause: unknown): Error =>
    Object.assign(
      new Error('The operational Pi run returned invalid structured output.'),
      { code: 'INVALID_STRUCTURED_OUTPUT', cause },
    );
  const jsonText =
    lastBalancedJsonObject(stripFencedCodeBlocks(text)) ??
    lastBalancedJsonObject(text);
  if (!jsonText) throw invalidStructuredOutput(undefined);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw invalidStructuredOutput(error);
  }
  try {
    return validateOperationalRecommendation(parsed);
  } catch (error) {
    throw invalidStructuredOutput(error);
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

  /** Finishes a deferred non-faux run; a no-op for `faux` and non-trigger messages. */
  async afterCommit(message: OutboxMessage): Promise<void> {
    await this.adapter.completeDeferredRun(message.event);
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
