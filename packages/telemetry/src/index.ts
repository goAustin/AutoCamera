import { randomBytes } from 'node:crypto';
import {
  context as otelContext,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

export type TraceId = string & { readonly __traceId: unique symbol };
export type SpanId = string & { readonly __spanId: unique symbol };

export interface BootstrapLogContext {
  readonly service: string;
  readonly traceId?: TraceId;
}

export function createTraceId(): TraceId {
  return randomBytes(16).toString('hex') as TraceId;
}

export function createSpanId(): SpanId {
  return randomBytes(8).toString('hex') as SpanId;
}

export function redact(value: string): '[REDACTED]' {
  void value;
  return '[REDACTED]';
}

export type TelemetryAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export type TelemetryAttributes = Readonly<
  Record<string, TelemetryAttributeValue | undefined>
>;

export interface TelemetrySpanHandle {
  readonly name: string;
  readonly parentName?: string;
  readonly traceId?: TraceId;
  readonly spanId?: SpanId;
  setAttributes(attributes: TelemetryAttributes): void;
  addEvent(name: string, attributes?: TelemetryAttributes): void;
  setStatus(status: 'ok' | 'error', error?: unknown): void;
  end(): void;
}

export interface AgentTelemetry {
  startSpan(
    name: string,
    attributes?: TelemetryAttributes,
    parent?: TelemetrySpanHandle,
  ): TelemetrySpanHandle;
  /** Starts a root span, optionally continuing a supplied W3C trace ID. */
  startRootSpan?(
    name: string,
    attributes?: TelemetryAttributes,
    traceId?: TraceId,
  ): TelemetrySpanHandle;
  flush(): Promise<void>;
}

export interface RecordedTelemetryEvent {
  readonly name: string;
  readonly attributes: TelemetryAttributes;
}

export interface RecordedTelemetrySpan {
  readonly name: string;
  readonly parentName?: string;
  readonly traceId?: TraceId;
  readonly spanId?: SpanId;
  readonly parentSpanId?: SpanId;
  readonly attributes: Readonly<Record<string, TelemetryAttributeValue>>;
  readonly events: readonly RecordedTelemetryEvent[];
  readonly status: 'unset' | 'ok' | 'error';
  readonly ended: boolean;
}

const TELEMETRY_ATTRIBUTE_KEY_ALLOWLIST = new Set([
  'apiVersion',
  'action',
  'code',
  'eventType',
  'executorMode',
  'failureCode',
  'operation',
  'outcome',
  'profileId',
  'profileVersion',
  'provider',
  'qualityTier',
  'recommendationCode',
  'result',
  'runType',
  'severity',
  'source',
  'status',
  'tool',
  'validationResult',
  'validationStatus',
  'workerState',
  'durationMs',
  'queueWaitSeconds',
  'computeSeconds',
  'value',
  'max',
  'count',
]);

const SENSITIVE_ATTRIBUTE_KEY =
  /(prompt|graph|token|secret|password|cookie|authorization|url|path|filename|object.?key|raw|response|payload|note|brief|query|signed|api.?key|model.?path)/i;
const SENSITIVE_ATTRIBUTE_VALUE =
  /(bearer\s+|(?:^|\b)(?:sk|pk)[-_][a-z0-9]|safetensors|\.mp4\b|(?:https?|wss?):\/\/|(?:^|[\\/])(?:private|srv|home|users?)\b)/i;

/**
 * Keep exported telemetry intentionally low-cardinality and payload-free.
 * Applying this at the recorder/exporter boundary protects future callers as
 * well as the current application code.
 */
export function sanitizeTelemetryAttributes(
  attributes: TelemetryAttributes | undefined,
): TelemetryAttributes {
  if (!attributes) return {};
  const result: Record<string, TelemetryAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (
      !TELEMETRY_ATTRIBUTE_KEY_ALLOWLIST.has(key) ||
      SENSITIVE_ATTRIBUTE_KEY.test(key) ||
      value === undefined
    ) {
      continue;
    }
    if (typeof value === 'string') {
      if (
        value.length > 160 ||
        SENSITIVE_ATTRIBUTE_VALUE.test(value) ||
        value.includes('\n')
      ) {
        continue;
      }
      result[key] = value;
      continue;
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value)) result[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      result[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const safe = value.filter(
        (item): item is string | number | boolean =>
          (typeof item === 'string' &&
            item.length <= 80 &&
            !SENSITIVE_ATTRIBUTE_VALUE.test(item)) ||
          (typeof item === 'number' && Number.isFinite(item)) ||
          typeof item === 'boolean',
      );
      if (safe.length === value.length && safe.length <= 16) {
        if (safe.every((item) => typeof item === 'string')) {
          result[key] = safe as readonly string[];
        } else if (safe.every((item) => typeof item === 'number')) {
          result[key] = safe as readonly number[];
        } else if (safe.every((item) => typeof item === 'boolean')) {
          result[key] = safe as readonly boolean[];
        }
      }
    }
  }
  return result;
}

class InMemorySpan implements TelemetrySpanHandle {
  readonly name: string;
  readonly parentName?: string;
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  private readonly record: {
    readonly traceId: TraceId;
    readonly spanId: SpanId;
    readonly parentSpanId?: SpanId;
    attributes: Record<string, TelemetryAttributeValue>;
    events: RecordedTelemetryEvent[];
    status: 'unset' | 'ok' | 'error';
    ended: boolean;
  };

  constructor(
    name: string,
    parent: TelemetrySpanHandle | undefined,
    record: InMemorySpan['record'],
  ) {
    this.name = name;
    if (parent) this.parentName = parent.name;
    this.traceId = record.traceId;
    this.spanId = record.spanId;
    if (record.parentSpanId) this.parentSpanId = record.parentSpanId;
    this.record = record;
  }

  setAttributes(attributes: TelemetryAttributes): void {
    for (const [key, value] of Object.entries(
      sanitizeTelemetryAttributes(attributes),
    )) {
      if (value !== undefined) this.record.attributes[key] = value;
    }
  }

  addEvent(name: string, attributes: TelemetryAttributes = {}): void {
    this.record.events.push({
      name: name.slice(0, 80),
      attributes: sanitizeTelemetryAttributes(attributes),
    });
  }

  setStatus(status: 'ok' | 'error'): void {
    this.record.status = status;
  }

  end(): void {
    this.record.ended = true;
  }
}

export class InMemoryTelemetry implements AgentTelemetry {
  private readonly records: Array<{
    name: string;
    readonly traceId: TraceId;
    readonly spanId: SpanId;
    readonly parentSpanId?: SpanId;
    parentName?: string;
    attributes: Record<string, TelemetryAttributeValue>;
    events: RecordedTelemetryEvent[];
    status: 'unset' | 'ok' | 'error';
    ended: boolean;
  }> = [];

  startSpan(
    name: string,
    attributes: TelemetryAttributes = {},
    parent?: TelemetrySpanHandle,
  ): TelemetrySpanHandle {
    const traceId = parent?.traceId ?? createTraceId();
    const spanId = createSpanId();
    const record = {
      name,
      traceId,
      spanId,
      ...(parent?.spanId ? { parentSpanId: parent.spanId } : {}),
      ...(parent ? { parentName: parent.name } : {}),
      attributes: {} as Record<string, TelemetryAttributeValue>,
      events: [] as RecordedTelemetryEvent[],
      status: 'unset' as const,
      ended: false,
    };
    this.records.push(record);
    const span = new InMemorySpan(name, parent, record);
    span.setAttributes(attributes);
    return span;
  }

  startRootSpan(
    name: string,
    attributes: TelemetryAttributes = {},
    traceId = createTraceId(),
  ): TelemetrySpanHandle {
    const record = {
      name,
      traceId,
      spanId: createSpanId(),
      attributes: {} as Record<string, TelemetryAttributeValue>,
      events: [] as RecordedTelemetryEvent[],
      status: 'unset' as const,
      ended: false,
    };
    this.records.push(record);
    const span = new InMemorySpan(name, undefined, record);
    span.setAttributes(attributes);
    return span;
  }

  getSpans(): readonly RecordedTelemetrySpan[] {
    return this.records.map((record) => ({
      ...record,
      attributes: { ...record.attributes },
      events: record.events.map((event) => ({
        ...event,
        attributes: { ...event.attributes },
      })),
    }));
  }

  async flush(): Promise<void> {
    return undefined;
  }
}

class OpenTelemetrySpan implements TelemetrySpanHandle {
  readonly name: string;
  readonly parentName?: string;
  readonly traceId?: TraceId;
  readonly spanId?: SpanId;
  readonly span: Span;

  constructor(name: string, span: Span, parent?: TelemetrySpanHandle) {
    this.name = name;
    this.span = span;
    if (parent) this.parentName = parent.name;
    const spanContext = span.spanContext();
    if (spanContext.traceId) this.traceId = spanContext.traceId as TraceId;
    if (spanContext.spanId) this.spanId = spanContext.spanId as SpanId;
  }

  setAttributes(attributes: TelemetryAttributes): void {
    try {
      this.span.setAttributes(
        sanitizeTelemetryAttributes(attributes) as Attributes,
      );
    } catch {
      // Telemetry must never affect the agent run.
    }
  }

  addEvent(name: string, attributes: TelemetryAttributes = {}): void {
    try {
      this.span.addEvent(
        name.slice(0, 80),
        sanitizeTelemetryAttributes(attributes) as Attributes,
      );
    } catch {
      // Telemetry must never affect the agent run.
    }
  }

  setStatus(status: 'ok' | 'error', error?: unknown): void {
    try {
      this.span.setStatus({
        code: status === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
        ...(error instanceof Error ? { message: error.message } : {}),
      });
    } catch {
      // Telemetry must never affect the agent run.
    }
  }

  end(): void {
    try {
      this.span.end();
    } catch {
      // Telemetry must never affect the agent run.
    }
  }
}

export interface OpenTelemetryTelemetryOptions {
  readonly tracer?: Tracer;
  readonly flush?: () => Promise<void>;
}

export class OpenTelemetryTelemetry implements AgentTelemetry {
  private readonly tracer: Tracer;
  private readonly flushHandler: (() => Promise<void>) | undefined;

  constructor(options: OpenTelemetryTelemetryOptions = {}) {
    this.tracer = options.tracer ?? trace.getTracer('h3-videoops');
    this.flushHandler = options.flush;
  }

  startSpan(
    name: string,
    attributes: TelemetryAttributes = {},
    parent?: TelemetrySpanHandle,
  ): TelemetrySpanHandle {
    try {
      const parentContext =
        parent instanceof OpenTelemetrySpan
          ? trace.setSpan(otelContext.active(), parent.span)
          : otelContext.active();
      const span = this.tracer.startSpan(
        name,
        { attributes: attributes as Attributes },
        parentContext as Context,
      );
      return new OpenTelemetrySpan(name, span, parent);
    } catch {
      return new OpenTelemetrySpan(
        name,
        trace.getTracer('h3-videoops').startSpan(name),
        parent,
      );
    }
  }

  startRootSpan(
    name: string,
    attributes: TelemetryAttributes = {},
  ): TelemetrySpanHandle {
    return this.startSpan(name, attributes);
  }

  async flush(): Promise<void> {
    if (!this.flushHandler) return;
    try {
      await this.flushHandler();
    } catch {
      // Exporter failure is intentionally isolated from the agent run.
    }
  }
}

export function createInMemoryTelemetry(): InMemoryTelemetry {
  return new InMemoryTelemetry();
}

export interface TraceContext {
  readonly traceId: TraceId;
  readonly root: TelemetrySpanHandle;
}

/**
 * Bridges a persisted trace ID to a parent span when work remains in this
 * process, and provides a continued root span after a worker restart.
 */
export class TraceContextRegistry {
  private readonly contexts = new Map<string, TraceContext>();

  constructor(
    private readonly telemetry: AgentTelemetry,
    private readonly maxContexts = 256,
  ) {}

  startRoot(
    name: string,
    traceId = createTraceId(),
    attributes: TelemetryAttributes = {},
  ): TelemetrySpanHandle {
    const root = this.telemetry.startRootSpan
      ? this.telemetry.startRootSpan(name, attributes, traceId)
      : this.telemetry.startSpan(name, attributes);
    const context: TraceContext = {
      traceId: root.traceId ?? traceId,
      root,
    };
    this.contexts.set(context.traceId, context);
    while (this.contexts.size > this.maxContexts) {
      const oldest = this.contexts.keys().next().value;
      if (oldest === undefined) break;
      this.contexts.delete(oldest);
    }
    return root;
  }

  parent(traceId: string | undefined): TelemetrySpanHandle | undefined {
    return traceId ? this.contexts.get(traceId)?.root : undefined;
  }

  start(
    name: string,
    traceId: string | undefined,
    attributes: TelemetryAttributes = {},
  ): TelemetrySpanHandle {
    return this.telemetry.startSpan(name, attributes, this.parent(traceId));
  }

  forget(traceId: string): void {
    this.contexts.delete(traceId);
  }
}

export const CORE_METRIC_NAMES = [
  'video_projects_total',
  'video_workflow_revisions_total',
  'video_workflow_validation_duration_seconds',
  'video_generation_attempts_total',
  'video_generation_queue_wait_seconds',
  'video_generation_duration_seconds',
  'video_generation_compute_cost_usd',
  'video_generation_active_jobs',
  'video_executor_ready',
  'video_comfy_ws_connected',
  'video_comfy_reconciliations_total',
  'video_comfy_orphan_events_total',
  'video_budget_denials_total',
  'video_evaluation_failures_total',
  'video_sse_connections',
  'video_operator_recommendations_total',
  'pi_agent_runs_total',
  'pi_agent_duration_seconds',
] as const;

export type CoreMetricName = (typeof CORE_METRIC_NAMES)[number];
export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface MetricDefinition {
  readonly name: CoreMetricName;
  readonly kind: MetricKind;
  readonly labels: readonly string[];
  readonly allowedValues: Readonly<Record<string, readonly string[]>>;
  readonly buckets?: readonly number[];
}

const all = (...values: string[]): readonly string[] => values;
const projectAndAttemptStatuses = all(
  'draft',
  'planning',
  'awaiting_storyboard_approval',
  'ready_for_generation',
  'generating',
  'needs_attention',
  'awaiting_final_review',
  'failed',
  'cancelled',
  'completed',
  'queued',
  'claimed',
  'submitting',
  'submitted',
  'running',
  'generated',
  'evaluating',
  'awaiting_review',
  'accepted',
  'rejected',
  'timed_out',
);
const executorModes = all('fake', 'remote');
const resultValues = all(
  'success',
  'failure',
  'passed',
  'failed',
  'ok',
  'error',
  'succeeded',
  'aborted',
  'timed_out',
  'running',
);
const profileIds = all('minimax-h3-t2va-preview');
const validationStatuses = all('pending', 'validated', 'invalid');
const sources = all('comfy_editor', 'official_template', 'system');
const qualityTiers = all('preview');
const reconciliationOutcomes = all(
  'history_found',
  'history_missing',
  'duplicate',
  'orphan',
  'reconnected',
  'terminal_ignored',
);
const recommendationCodes = all(
  'EXECUTOR_UNAVAILABLE',
  'RETRY_FAILED_PREVIEW',
  'CAPABILITY_DRIFT',
  'WORKFLOW_INVALID',
  'BUDGET_EXCEEDED',
  'ATTEMPT_LIMIT_REACHED',
  'REVIEW_REQUIRED',
  'WORKFLOW_REVISION_INVALID',
  'ATTEMPT_FAILED',
  'ATTEMPT_TIMED_OUT',
  'ATTEMPT_REJECTED',
  'ATTEMPT_SUBMISSION_UNCERTAIN',
);
const recommendationStatuses = all(
  'pending',
  'applied',
  'dismissed',
  'expired',
);
const severities = all('info', 'warning', 'critical');
const runTypes = all('planning', 'operator');
const providers = all('faux', 'hosted');
const operations = all(
  'create',
  'plan',
  'approve',
  'generate',
  'retry',
  'accept',
  'reject',
  'validate',
  'apply',
);
const evaluationChecks = all(
  'file_readable',
  'checksum',
  'byte_size',
  'container',
  'video_stream',
  'dimensions',
  'duration',
  'frame_rate',
  'decoder',
  'motion',
  'audio',
);

const metric = (
  name: CoreMetricName,
  kind: MetricKind,
  labels: readonly string[],
  allowedValues: Readonly<Record<string, readonly string[]>>,
  buckets?: readonly number[],
): MetricDefinition => ({
  name,
  kind,
  labels,
  allowedValues,
  ...(buckets ? { buckets } : {}),
});

export const CORE_METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  metric('video_projects_total', 'counter', ['status'], {
    status: projectAndAttemptStatuses,
  }),
  metric(
    'video_workflow_revisions_total',
    'counter',
    ['profile_id', 'validation_status', 'source'],
    {
      profile_id: profileIds,
      validation_status: validationStatuses,
      source: sources,
    },
  ),
  metric(
    'video_workflow_validation_duration_seconds',
    'histogram',
    ['profile_id', 'result'],
    { profile_id: profileIds, result: resultValues },
    [0.01, 0.05, 0.1, 0.5, 1, 5, 10],
  ),
  metric(
    'video_generation_attempts_total',
    'counter',
    ['status', 'quality_tier', 'executor_mode'],
    {
      status: projectAndAttemptStatuses,
      quality_tier: qualityTiers,
      executor_mode: executorModes,
    },
  ),
  metric(
    'video_generation_queue_wait_seconds',
    'histogram',
    ['executor_mode'],
    { executor_mode: executorModes },
    [0.01, 0.1, 1, 5, 30, 60, 300],
  ),
  metric(
    'video_generation_duration_seconds',
    'histogram',
    ['executor_mode', 'result'],
    { executor_mode: executorModes, result: resultValues },
    [0.1, 1, 5, 30, 60, 300, 900],
  ),
  metric('video_generation_compute_cost_usd', 'counter', ['executor_mode'], {
    executor_mode: executorModes,
  }),
  metric('video_generation_active_jobs', 'gauge', ['executor_mode'], {
    executor_mode: executorModes,
  }),
  metric('video_executor_ready', 'gauge', ['executor_mode'], {
    executor_mode: executorModes,
  }),
  metric('video_comfy_ws_connected', 'gauge', ['executor_mode'], {
    executor_mode: executorModes,
  }),
  metric('video_comfy_reconciliations_total', 'counter', ['outcome'], {
    outcome: reconciliationOutcomes,
  }),
  metric('video_comfy_orphan_events_total', 'counter', ['executor_mode'], {
    executor_mode: executorModes,
  }),
  metric('video_budget_denials_total', 'counter', ['operation'], {
    operation: operations,
  }),
  metric('video_evaluation_failures_total', 'counter', ['check'], {
    check: evaluationChecks,
  }),
  metric('video_sse_connections', 'gauge', [], {}),
  metric(
    'video_operator_recommendations_total',
    'counter',
    ['code', 'status', 'severity'],
    {
      code: recommendationCodes,
      status: recommendationStatuses,
      severity: severities,
    },
  ),
  metric('pi_agent_runs_total', 'counter', ['run_type', 'status', 'provider'], {
    run_type: runTypes,
    status: resultValues,
    provider: providers,
  }),
  metric(
    'pi_agent_duration_seconds',
    'histogram',
    ['run_type', 'status'],
    {
      run_type: runTypes,
      status: resultValues,
    },
    [0.01, 0.1, 1, 5, 30, 60, 300],
  ),
];

export class MetricLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricLabelError';
  }
}

interface MetricValue {
  value: number;
  buckets?: number[];
  sum?: number;
  count?: number;
}

function labelsKey(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\u0000');
}

function escapePrometheusLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
}

function formatLabels(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) return '';
  return `{${entries
    .map(([key, value]) => `${key}="${escapePrometheusLabel(value)}"`)
    .join(',')}}`;
}

export class MetricsRegistry {
  private readonly values = new Map<string, MetricValue>();

  constructor(
    private readonly definitions: readonly MetricDefinition[] = CORE_METRIC_DEFINITIONS,
  ) {}

  private definition(name: string): MetricDefinition {
    const definition = this.definitions.find((item) => item.name === name);
    if (!definition) throw new MetricLabelError(`Unknown metric: ${name}`);
    return definition;
  }

  private normalizedLabels(
    definition: MetricDefinition,
    labels: Readonly<Record<string, string>>,
  ): Readonly<Record<string, string>> {
    const given = Object.keys(labels).sort();
    const expected = [...definition.labels].sort();
    if (given.join('\u0000') !== expected.join('\u0000')) {
      throw new MetricLabelError(
        `${definition.name} requires exactly these bounded labels: ${definition.labels.join(', ')}`,
      );
    }
    for (const label of definition.labels) {
      const value = labels[label];
      if (typeof value !== 'string') {
        throw new MetricLabelError(
          `${definition.name}.${label} must be a string.`,
        );
      }
      const allowed = definition.allowedValues[label];
      if (allowed && !allowed.includes(value)) {
        throw new MetricLabelError(
          `${definition.name}.${label} is outside the metric label allowlist.`,
        );
      }
    }
    return Object.fromEntries(
      definition.labels.map((label) => [label, labels[label] ?? '']),
    );
  }

  private get(
    name: CoreMetricName,
    labels: Readonly<Record<string, string>>,
  ): MetricValue {
    const key = `${name}\u0000${labelsKey(labels)}`;
    const existing = this.values.get(key);
    if (existing) return existing;
    const definition = this.definition(name);
    const value: MetricValue = {
      value: 0,
      ...(definition.kind === 'histogram'
        ? {
            buckets: new Array(definition.buckets?.length ?? 0).fill(0),
            sum: 0,
            count: 0,
          }
        : {}),
    };
    this.values.set(key, value);
    return value;
  }

  increment(
    name: CoreMetricName,
    labels: Readonly<Record<string, string>> = {},
    amount = 1,
  ): void {
    const definition = this.definition(name);
    if (definition.kind === 'histogram') {
      throw new MetricLabelError(`${name} is a histogram; use observe().`);
    }
    if (!Number.isFinite(amount) || amount < 0) {
      throw new MetricLabelError(
        `${name} increment must be finite and non-negative.`,
      );
    }
    const normalized = this.normalizedLabels(definition, labels);
    this.get(name, normalized).value += amount;
  }

  set(
    name: CoreMetricName,
    labels: Readonly<Record<string, string>>,
    value: number,
  ): void {
    const definition = this.definition(name);
    if (definition.kind !== 'gauge') {
      throw new MetricLabelError(`${name} is not a gauge.`);
    }
    if (!Number.isFinite(value)) {
      throw new MetricLabelError(`${name} must be finite.`);
    }
    const normalized = this.normalizedLabels(definition, labels);
    this.get(name, normalized).value = value;
  }

  observe(
    name: CoreMetricName,
    labels: Readonly<Record<string, string>>,
    value: number,
  ): void {
    const definition = this.definition(name);
    if (definition.kind !== 'histogram') {
      throw new MetricLabelError(`${name} is not a histogram.`);
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new MetricLabelError(
        `${name} observation must be finite and non-negative.`,
      );
    }
    const normalized = this.normalizedLabels(definition, labels);
    const metricValue = this.get(name, normalized);
    const buckets = metricValue.buckets ?? [];
    for (const [index, boundary] of (definition.buckets ?? []).entries()) {
      if (value <= boundary) buckets[index] = (buckets[index] ?? 0) + 1;
    }
    metricValue.sum = (metricValue.sum ?? 0) + value;
    metricValue.count = (metricValue.count ?? 0) + 1;
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const definition of this.definitions) {
      lines.push(`# HELP ${definition.name} H3 VideoOps ${definition.name}.`);
      lines.push(`# TYPE ${definition.name} ${definition.kind}`);
    }
    const entries = [...this.values.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [key, value] of entries) {
      const separator = key.indexOf('\u0000');
      const name = key.slice(0, separator) as CoreMetricName;
      const encodedLabels = key.slice(separator + 1);
      const labels = Object.fromEntries(
        encodedLabels
          ? encodedLabels.split('\u0000').map((part) => {
              const index = part.indexOf('=');
              return [part.slice(0, index), part.slice(index + 1)];
            })
          : [],
      );
      const definition = this.definition(name);
      if (definition.kind === 'histogram') {
        let cumulative = 0;
        for (const [index, boundary] of (definition.buckets ?? []).entries()) {
          cumulative += value.buckets?.[index] ?? 0;
          lines.push(
            `${name}_bucket${formatLabels({
              ...labels,
              le: String(boundary),
            })} ${cumulative}`,
          );
        }
        lines.push(
          `${name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${value.count ?? 0}`,
        );
        lines.push(`${name}_sum${formatLabels(labels)} ${value.sum ?? 0}`);
        lines.push(`${name}_count${formatLabels(labels)} ${value.count ?? 0}`);
      } else {
        lines.push(`${name}${formatLabels(labels)} ${value.value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  snapshot(): readonly {
    readonly name: CoreMetricName;
    readonly labels: Readonly<Record<string, string>>;
    readonly value: number;
  }[] {
    return [...this.values.entries()].map(([key, value]) => {
      const separator = key.indexOf('\u0000');
      const name = key.slice(0, separator) as CoreMetricName;
      const encodedLabels = key.slice(separator + 1);
      const labels = Object.fromEntries(
        encodedLabels
          ? encodedLabels.split('\u0000').map((part) => {
              const index = part.indexOf('=');
              return [part.slice(0, index), part.slice(index + 1)];
            })
          : [],
      );
      return {
        name,
        labels,
        value: value.count ?? value.value,
      };
    });
  }
}

export function initializeCoreMetrics(metrics: MetricsRegistry): void {
  for (const mode of executorModes) {
    metrics.set('video_executor_ready', { executor_mode: mode }, 0);
    metrics.set('video_comfy_ws_connected', { executor_mode: mode }, 0);
    metrics.set('video_generation_active_jobs', { executor_mode: mode }, 0);
  }
  metrics.set('video_sse_connections', {}, 0);
}

interface BufferedSpanRecord {
  readonly name: string;
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  readonly parentName?: string;
  readonly attributes: Record<string, TelemetryAttributeValue>;
  readonly events: RecordedTelemetryEvent[];
  status: 'unset' | 'ok' | 'error';
  ended: boolean;
  readonly startedAt: number;
  endedAt?: number;
}

class BufferedSpan implements TelemetrySpanHandle {
  readonly name: string;
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentName?: string;
  readonly parentSpanId?: SpanId;

  constructor(private readonly record: BufferedSpanRecord) {
    this.name = record.name;
    this.traceId = record.traceId;
    this.spanId = record.spanId;
    if (record.parentName) this.parentName = record.parentName;
    if (record.parentSpanId) this.parentSpanId = record.parentSpanId;
  }

  setAttributes(attributes: TelemetryAttributes): void {
    Object.assign(
      this.record.attributes,
      sanitizeTelemetryAttributes(attributes),
    );
  }

  addEvent(name: string, attributes: TelemetryAttributes = {}): void {
    this.record.events.push({
      name: name.slice(0, 80),
      attributes: sanitizeTelemetryAttributes(attributes),
    });
  }

  setStatus(status: 'ok' | 'error'): void {
    this.record.status = status;
  }

  end(): void {
    if (this.record.ended) return;
    this.record.ended = true;
    this.record.endedAt = Date.now();
  }
}

export interface BufferedTelemetryOptions {
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly serviceName?: string;
  readonly flushTimeoutMs?: number;
}

/** Dependency-free OTLP/HTTP exporter with a local evidence recorder. */
export class BufferedTelemetry implements AgentTelemetry {
  private readonly records: BufferedSpanRecord[] = [];
  private readonly endpoint: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly serviceName: string;
  private readonly flushTimeoutMs: number;

  constructor(options: BufferedTelemetryOptions = {}) {
    this.endpoint = options.endpoint
      ? options.endpoint.endsWith('/v1/traces')
        ? options.endpoint
        : `${options.endpoint.replace(/\/$/, '')}/v1/traces`
      : undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.serviceName = options.serviceName ?? 'h3-videoops-api';
    this.flushTimeoutMs = options.flushTimeoutMs ?? 1_000;
  }

  startSpan(
    name: string,
    attributes: TelemetryAttributes = {},
    parent?: TelemetrySpanHandle,
  ): TelemetrySpanHandle {
    const record: BufferedSpanRecord = {
      name: name.slice(0, 80),
      traceId: parent?.traceId ?? createTraceId(),
      spanId: createSpanId(),
      ...(parent?.spanId ? { parentSpanId: parent.spanId } : {}),
      ...(parent?.name ? { parentName: parent.name } : {}),
      attributes: {},
      events: [],
      status: 'unset',
      ended: false,
      startedAt: Date.now(),
    };
    this.records.push(record);
    const span = new BufferedSpan(record);
    span.setAttributes(attributes);
    return span;
  }

  startRootSpan(
    name: string,
    attributes: TelemetryAttributes = {},
    traceId = createTraceId(),
  ): TelemetrySpanHandle {
    const record: BufferedSpanRecord = {
      name: name.slice(0, 80),
      traceId,
      spanId: createSpanId(),
      attributes: {},
      events: [],
      status: 'unset',
      ended: false,
      startedAt: Date.now(),
    };
    this.records.push(record);
    const span = new BufferedSpan(record);
    span.setAttributes(attributes);
    return span;
  }

  getSpans(): readonly RecordedTelemetrySpan[] {
    return this.records.map((record) => ({
      name: record.name,
      traceId: record.traceId,
      spanId: record.spanId,
      ...(record.parentName ? { parentName: record.parentName } : {}),
      ...(record.parentSpanId ? { parentSpanId: record.parentSpanId } : {}),
      attributes: { ...record.attributes },
      events: record.events.map((event) => ({
        ...event,
        attributes: { ...event.attributes },
      })),
      status: record.status,
      ended: record.ended,
    }));
  }

  async flush(): Promise<void> {
    if (!this.endpoint) return;
    const spans = this.records.filter(
      (record) => record.ended && record.endedAt,
    );
    if (spans.length === 0) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.flushTimeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [
                  {
                    key: 'service.name',
                    value: { stringValue: this.serviceName },
                  },
                ],
              },
              scopeSpans: [
                {
                  scope: { name: 'h3-videoops' },
                  spans: spans.map((span) => ({
                    traceId: span.traceId,
                    spanId: span.spanId,
                    ...(span.parentSpanId
                      ? { parentSpanId: span.parentSpanId }
                      : {}),
                    name: span.name,
                    startTimeUnixNano: String(span.startedAt * 1_000_000),
                    endTimeUnixNano: String(
                      (span.endedAt ?? span.startedAt) * 1_000_000,
                    ),
                    attributes: Object.entries(span.attributes).map(
                      ([key, value]) => ({
                        key,
                        value:
                          typeof value === 'string'
                            ? { stringValue: value }
                            : typeof value === 'boolean'
                              ? { boolValue: value }
                              : { doubleValue: value },
                      }),
                    ),
                    events: span.events.map((event) => ({
                      name: event.name,
                      timeUnixNano: String(
                        (span.endedAt ?? span.startedAt) * 1_000_000,
                      ),
                      attributes: Object.entries(event.attributes).map(
                        ([key, value]) => ({
                          key,
                          value:
                            typeof value === 'string'
                              ? { stringValue: value }
                              : typeof value === 'boolean'
                                ? { boolValue: value }
                                : { doubleValue: value },
                        }),
                      ),
                    })),
                    status: {
                      code:
                        span.status === 'error'
                          ? 2
                          : span.status === 'ok'
                            ? 1
                            : 0,
                    },
                  })),
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      void response;
    } catch {
      // Collector/exporter failure is deliberately isolated from business work.
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createBufferedTelemetry(endpoint?: string): BufferedTelemetry {
  return new BufferedTelemetry({ ...(endpoint ? { endpoint } : {}) });
}
