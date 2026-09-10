import {
  Agent,
  type AgentEvent,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type Model,
} from '@earendil-works/pi-ai';
import {
  createOperationalDigestTool,
  createOperationalReadTools,
  type OperationalDigestOutput,
  type OperationalIncidentToolView,
  type OperationalToolContext,
  type OperationalToolServices,
} from '@h3/agent-tools';
import type { AgentRunRecord, Repositories, TransactionalStore } from '@h3/db';
import { toIsoUtc, type Clock, type IdGenerator, type Uuid } from '@h3/domain';
import {
  type AgentTelemetry,
  InMemoryTelemetry,
  type MetricsRegistry,
} from '@h3/telemetry';
import {
  asAgentRunStatus,
  assistantMessages,
  failureCodeFor,
  piTelemetryContext,
  resolveHostedModel,
  usageTotals,
  type PiUsageTotals,
} from './pi-run.js';
import { safeRecommendationText } from './redact.js';

/**
 * Step 4 of `docs/75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md`: one agent run
 * over a time window rather than over one event.
 *
 * The window is applied to the **services the six read tools read through**,
 * not to the tools themselves -- `createOperationalReadTools` is called
 * exactly as the per-incident operator calls it, and still returns six reads
 * and no write. The one output path, `submit_digest`, reads nothing.
 *
 * Scheduling is not here and is not wanted: an operator invokes this from
 * cron, launchd, or by hand at the end of a rented session.
 */

const DIGEST_TITLE_MAX = 240;
const DIGEST_DETAIL_MAX = 2_000;
const DIGEST_MAX_REFERENCED_RUNS = 20;
const DIGEST_MAX_TYPES_NARRATED = 8;

export interface DigestWindow {
  readonly sinceIso: string;
  readonly untilIso: string;
}

export interface SessionDigest {
  readonly severity: OperationalDigestOutput['severity'];
  readonly title: string;
  readonly detail: string;
  readonly referencedRunIds: readonly Uuid[];
  readonly sinceIso: string;
  readonly untilIso: string;
  readonly agentRunId: Uuid;
}

export type DigestOutcome =
  | { readonly ok: false; readonly reason: 'project_not_found' }
  | {
      readonly ok: true;
      readonly digest: SessionDigest;
      readonly agentRun: AgentRunRecord;
    };

export type DigestToolServiceFactory = (
  repositories: Repositories,
) => OperationalToolServices;

export interface OperationalDigestServiceOptions {
  readonly store: TransactionalStore;
  readonly tenantId: Uuid;
  readonly services: DigestToolServiceFactory;
  readonly clock?: Clock;
  readonly idGenerator: IdGenerator;
  readonly provider?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly telemetry?: AgentTelemetry;
  readonly metrics?: MetricsRegistry;
  readonly timeoutMs?: number;
  readonly maxRunCostMicrousd?: number;
  readonly maxRunTokens?: number;
  /** Test-only, exactly as on the per-incident adapter. */
  readonly streamFnOverride?: StreamFn;
}

/** Incidents whose `occurredAt` falls inside the closed window. */
function windowIncidents(
  incidents: readonly OperationalIncidentToolView[],
  window: DigestWindow,
): readonly OperationalIncidentToolView[] {
  const since = Date.parse(window.sinceIso);
  const until = Date.parse(window.untilIso);
  return incidents.filter((incident) => {
    const at = Date.parse(incident.occurredAt);
    return Number.isFinite(at) && at >= since && at <= until;
  });
}

/** The attempt ids the window actually contains -- the only ids a digest may cite. */
function inScopeRunIds(
  incidents: readonly OperationalIncidentToolView[],
): ReadonlySet<Uuid> {
  return new Set(
    incidents.flatMap((incident) =>
      incident.attemptId ? [incident.attemptId] : [],
    ),
  );
}

/**
 * The lookup-table digest, used when there is no model or the model failed.
 * It narrates only what the incident rows already say -- counts and event
 * types -- because a fallback that guessed would be worse than one that
 * summarises.
 */
function defaultDigest(
  incidents: readonly OperationalIncidentToolView[],
  window: DigestWindow,
): OperationalDigestOutput {
  const runIds = [...inScopeRunIds(incidents)].slice(
    0,
    DIGEST_MAX_REFERENCED_RUNS,
  );
  if (incidents.length === 0) {
    return {
      severity: 'info',
      title: 'No incidents in the session window.',
      detail:
        `No failure, denial or timeout event was recorded between ${window.sinceIso} ` +
        `and ${window.untilIso}. The durable timeline remains the full record.`,
      referencedRunIds: [],
    };
  }
  const types = [...new Set(incidents.map((incident) => incident.type))]
    .slice(0, DIGEST_MAX_TYPES_NARRATED)
    .join(', ');
  return {
    severity: 'warning',
    title: `${incidents.length} incident${incidents.length === 1 ? '' : 's'} in the session window.`,
    detail:
      `Between ${window.sinceIso} and ${window.untilIso} the timeline recorded ` +
      `${incidents.length} incident event${incidents.length === 1 ? '' : 's'} ` +
      `across: ${types}. This summary is an index into the timeline, not a ` +
      'substitute for it; read the events themselves before acting.',
    referencedRunIds: runIds,
  };
}

interface DigestModelOutcome {
  readonly output: OperationalDigestOutput | undefined;
  readonly totals: PiUsageTotals | undefined;
  readonly toolCalls: number;
  readonly error: unknown;
  readonly startedAt: number;
}

const DIGEST_SYSTEM_PROMPT =
  'You are an operational monitor summarising one rented-GPU session for a ' +
  'video-generation pipeline. Use only the provided read-only evidence ' +
  'tools, which are already restricted to the session window, then call ' +
  'submit_digest with your summary: severity ("info" | "warning" | ' +
  `"critical"), title (at most ${DIGEST_TITLE_MAX} characters), detail (at ` +
  `most ${DIGEST_DETAIL_MAX} characters), and referencedRunIds (the run ` +
  'UUIDs you actually read, at most ' +
  `${DIGEST_MAX_REFERENCED_RUNS}, and an empty list if you read none). If ` +
  'that call comes back listing what to fix, correct exactly those points ' +
  'and call it again -- the run has no summary until one is accepted. ' +
  'Propose no action and request no infrastructure access: a digest ' +
  'narrates what happened, it never acts.';

export class OperationalDigestService {
  readonly store: TransactionalStore;
  readonly tenantId: Uuid;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly provider: string;
  readonly modelName: string;
  readonly apiKey: string | undefined;
  readonly telemetry: AgentTelemetry;
  readonly metrics: MetricsRegistry | undefined;
  readonly services: DigestToolServiceFactory;
  readonly timeoutMs: number;
  readonly maxRunCostMicrousd: number;
  readonly maxRunTokens: number;
  readonly streamFnOverride: StreamFn | undefined;

  constructor(options: OperationalDigestServiceOptions) {
    this.store = options.store;
    this.tenantId = options.tenantId;
    this.clock = options.clock ?? { now: () => new Date() };
    this.idGenerator = options.idGenerator;
    this.provider = options.provider ?? 'faux';
    this.modelName = options.model ?? 'h3-videoops-operator-v1';
    this.apiKey = options.apiKey;
    this.telemetry = options.telemetry ?? new InMemoryTelemetry();
    this.metrics = options.metrics;
    this.services = options.services;
    this.timeoutMs = Math.max(100, options.timeoutMs ?? 30_000);
    this.maxRunCostMicrousd = Math.max(0, options.maxRunCostMicrousd ?? 50_000);
    this.maxRunTokens = Math.max(0, options.maxRunTokens ?? 200_000);
    this.streamFnOverride = options.streamFnOverride;
  }

  /**
   * Three phases on purpose: claim, reason, persist. The provider round trip
   * in phase two runs with no transaction open and no pooled connection
   * held, which is the same discipline step 3 imposed on the per-incident
   * operator and the reason the digest is not one `withTransaction` call.
   */
  async createDigest(
    projectId: Uuid,
    window: DigestWindow,
  ): Promise<DigestOutcome> {
    const prepared = await this.store.withTransaction(async (repositories) => {
      const services = this.services(repositories);
      const project = await services.getProjectStatus(this.tenantId, projectId);
      if (!project || project.id !== projectId) return undefined;
      const incidents = windowIncidents(
        await services.getRecentIncidents(this.tenantId, projectId),
        window,
      );
      const startedAt = toIsoUtc(this.clock.now());
      const runId = this.idGenerator.next();
      const run: AgentRunRecord = {
        id: runId,
        tenantId: this.tenantId,
        projectId,
        runId,
        sessionId: `pi-digest-${runId}`,
        objective:
          'Summarize one rented-GPU session window from durable evidence.',
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
      return { run, incidents };
    });
    if (!prepared) return { ok: false, reason: 'project_not_found' };

    const outcome = await this.runModel(
      projectId,
      window,
      prepared.incidents,
      prepared.run,
    );

    return this.persist(window, prepared, outcome);
  }

  /** The six read tools, reading through services the window already bounds. */
  private windowedServices(window: DigestWindow): OperationalToolServices {
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
      getRecentIncidents: async (tenantId, projectId) =>
        windowIncidents(
          await inTransaction((services) =>
            services.getRecentIncidents(tenantId, projectId),
          ),
          window,
        ),
      getExecutorReadiness: () =>
        inTransaction((services) => services.getExecutorReadiness()),
    };
  }

  private async runModel(
    projectId: Uuid,
    window: DigestWindow,
    incidents: readonly OperationalIncidentToolView[],
    run: AgentRunRecord,
  ): Promise<DigestModelOutcome> {
    const startedAt = Date.now();
    const rootSpan = this.telemetry.startSpan('agent.digest.run', {
      provider: this.provider,
      model: this.modelName,
      status: 'running',
    });
    let toolCalls = 0;
    let terminalStatus: 'ok' | 'error' = 'error';
    try {
      const context: OperationalToolContext = {
        tenantId: this.tenantId,
        projectId,
        services: this.windowedServices(window),
        onPolicyDenial: (code, operation) =>
          rootSpan.addEvent('policy.denial', { code, operation }),
      };
      const submission = createOperationalDigestTool();
      const tools = [...createOperationalReadTools(context), submission.tool];
      const piContext = piTelemetryContext(this.telemetry, rootSpan);
      const { model, streamFn: baseStreamFn } =
        this.provider === 'faux'
          ? this.fauxModel(incidents, window)
          : resolveHostedModel({
              provider: this.provider,
              model: this.modelName,
              streamFnOverride: this.streamFnOverride,
            });
      const streamFn: StreamFn = (streamModel, streamContext, streamOptions) =>
        baseStreamFn(streamModel, streamContext, {
          ...streamOptions,
          ...(this.apiKey && this.provider !== 'faux'
            ? { apiKey: this.apiKey }
            : {}),
          telemetryContext: piContext,
        });
      let budgetExhausted = false;
      const agent = new Agent({
        sessionId: run.sessionId,
        streamFn,
        toolExecution: 'sequential',
        shouldStopAfterTurn: (turn) => {
          const spent = usageTotals(assistantMessages(turn.context.messages));
          const overCost =
            this.maxRunCostMicrousd > 0 &&
            spent.providerCostMicrousd >= this.maxRunCostMicrousd;
          const overTokens =
            this.maxRunTokens > 0 && spent.totalTokens >= this.maxRunTokens;
          if (!overCost && !overTokens) return false;
          budgetExhausted = true;
          rootSpan.addEvent('run.budget_exhausted', {
            outcome: overCost ? 'cost_microusd' : 'tokens',
            value: overCost ? spent.providerCostMicrousd : spent.totalTokens,
            max: overCost ? this.maxRunCostMicrousd : this.maxRunTokens,
          });
          return true;
        },
        initialState: {
          model,
          systemPrompt: DIGEST_SYSTEM_PROMPT,
          tools,
        },
      });
      agent.subscribe((agentEvent: AgentEvent) => {
        if (agentEvent.type === 'tool_execution_start') toolCalls += 1;
      });
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        agent.abort();
      }, this.timeoutMs);
      try {
        await agent.prompt(
          `Summarize the session for projectId=${projectId} between ` +
            `${window.sinceIso} and ${window.untilIso}. The evidence tools ` +
            'are already restricted to that window.',
        );
        await agent.waitForIdle();
      } finally {
        clearTimeout(timeout);
      }
      const messages = assistantMessages(agent.state.messages);
      const captured = submission.accepted();
      // The same W4 trade the per-incident operator makes: a summary the
      // model actually reached is never discarded for a bound that arrived
      // after it.
      if (!captured) {
        if (timedOut) {
          throw Object.assign(new Error('The session digest run timed out.'), {
            code: 'TIMEOUT',
          });
        }
        const final = messages.at(-1);
        if (!final || final.stopReason === 'error') {
          throw Object.assign(
            new Error('The digest provider returned no summary.'),
            { code: 'PROVIDER_ERROR' },
          );
        }
        throw Object.assign(
          new Error('The digest run produced no accepted summary.'),
          { code: 'INVALID_STRUCTURED_OUTPUT' },
        );
      }
      if (timedOut || budgetExhausted) {
        rootSpan.setAttributes({
          outcome: timedOut ? 'timed_out' : 'budget_exhausted',
        });
      }
      terminalStatus = 'ok';
      rootSpan.setAttributes({ status: 'succeeded' });
      return {
        output: captured,
        totals: usageTotals(messages),
        toolCalls,
        error: undefined,
        startedAt,
      };
    } catch (error) {
      rootSpan.setAttributes({
        status: 'failed',
        failureCode: failureCodeFor(error),
      });
      return {
        output: undefined,
        totals: undefined,
        toolCalls,
        error,
        startedAt,
      };
    } finally {
      rootSpan.setStatus(terminalStatus);
      rootSpan.end();
      try {
        await this.telemetry.flush();
      } catch {
        // Telemetry exporter failures cannot affect the digest.
      }
    }
  }

  /**
   * The offline provider: one scripted evidence read, then one scripted
   * submission of the lookup-table digest. It goes through the same Agent,
   * the same six tools and the same `submit_digest` validation as a hosted
   * run, so the offline tests exercise the real path rather than a stub of
   * it.
   */
  private fauxModel(
    incidents: readonly OperationalIncidentToolView[],
    window: DigestWindow,
  ): { readonly model: Model<Api>; readonly streamFn: StreamFn } {
    const faux = fauxProvider({
      provider: this.provider,
      models: [{ id: this.modelName, name: this.modelName }],
    });
    const scripted = defaultDigest(incidents, window);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('get_recent_incidents', {}, { id: 'digest-tool-0' }),
      ]),
      fauxAssistantMessage([
        fauxToolCall('submit_digest', scripted, { id: 'digest-tool-1' }),
      ]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    return {
      model: faux.getModel() as Model<Api>,
      streamFn: (streamModel, streamContext, streamOptions) =>
        models.streamSimple(streamModel, streamContext, streamOptions),
    };
  }

  /** Finalizes the run row and returns the sanitized, scope-checked digest. */
  private async persist(
    window: DigestWindow,
    prepared: {
      readonly run: AgentRunRecord;
      readonly incidents: readonly OperationalIncidentToolView[];
    },
    outcome: DigestModelOutcome,
  ): Promise<DigestOutcome> {
    const { run, incidents } = prepared;
    const fallback = defaultDigest(incidents, window);
    const output = outcome.output ?? fallback;
    const finishedAt = toIsoUtc(this.clock.now());
    const terminalRun: AgentRunRecord = {
      ...run,
      status: asAgentRunStatus(!outcome.error, outcome.error),
      toolCalls: outcome.toolCalls,
      inputTokens: outcome.totals?.inputTokens ?? run.inputTokens,
      outputTokens: outcome.totals?.outputTokens ?? run.outputTokens,
      totalTokens: outcome.totals?.totalTokens ?? run.totalTokens,
      cacheReadTokens: outcome.totals?.cacheReadTokens ?? run.cacheReadTokens,
      cacheWriteTokens:
        outcome.totals?.cacheWriteTokens ?? run.cacheWriteTokens,
      providerCostMicrousd:
        outcome.totals?.providerCostMicrousd ?? run.providerCostMicrousd,
      finishedAt,
      ...(outcome.error ? { failureCode: failureCodeFor(outcome.error) } : {}),
      version: run.version + 1,
      updatedAt: finishedAt,
    };
    await this.store.withTransaction((repositories) =>
      repositories.agentRuns.update(terminalRun, run.version),
    );

    // A run id the window does not contain is denied rather than repeated,
    // on the same rule as an out-of-scope tool argument: the model may only
    // cite evidence it was actually shown.
    const allowed = inScopeRunIds(incidents);
    // The membership test is what makes the cast sound: every element of
    // `allowed` came off an incident row's `attemptId`, which is already a
    // `Uuid`.
    const referencedRunIds: readonly Uuid[] = output.referencedRunIds
      .filter((runId): runId is Uuid => allowed.has(runId as Uuid))
      .slice(0, DIGEST_MAX_REFERENCED_RUNS);

    if (this.metrics) {
      try {
        // `run_type: 'operator'`, not a new value: a digest is the operator
        // reasoning over a window instead of an event, and the metric label
        // allowlist is explicitly out of scope for this checkpoint.
        this.metrics.increment('pi_agent_runs_total', {
          run_type: 'operator',
          status: outcome.error ? 'failure' : 'success',
          provider: this.provider === 'faux' ? 'faux' : 'hosted',
        });
        this.metrics.observe(
          'pi_agent_duration_seconds',
          {
            run_type: 'operator',
            status: outcome.error ? 'failure' : 'success',
          },
          Math.max(0, (Date.now() - outcome.startedAt) / 1_000),
        );
      } catch {
        // Metrics are diagnostic and cannot change the digest.
      }
    }

    return {
      ok: true,
      digest: {
        severity: output.severity,
        title: safeRecommendationText(output.title, 'Session digest.').slice(
          0,
          DIGEST_TITLE_MAX,
        ),
        detail: safeRecommendationText(
          output.detail,
          'The session window requires human review.',
        ).slice(0, DIGEST_DETAIL_MAX),
        referencedRunIds,
        sinceIso: window.sinceIso,
        untilIso: window.untilIso,
        agentRunId: terminalRun.id,
      },
      agentRun: terminalRun,
    };
  }
}
