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

export interface BootstrapLogContext {
  readonly service: string;
  readonly traceId?: TraceId;
}

export function createTraceId(): TraceId {
  return randomBytes(16).toString('hex') as TraceId;
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
  flush(): Promise<void>;
}

export interface RecordedTelemetryEvent {
  readonly name: string;
  readonly attributes: TelemetryAttributes;
}

export interface RecordedTelemetrySpan {
  readonly name: string;
  readonly parentName?: string;
  readonly attributes: Readonly<Record<string, TelemetryAttributeValue>>;
  readonly events: readonly RecordedTelemetryEvent[];
  readonly status: 'unset' | 'ok' | 'error';
  readonly ended: boolean;
}

class InMemorySpan implements TelemetrySpanHandle {
  readonly name: string;
  readonly parentName?: string;
  private readonly record: {
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
    this.record = record;
  }

  setAttributes(attributes: TelemetryAttributes): void {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) this.record.attributes[key] = value;
    }
  }

  addEvent(name: string, attributes: TelemetryAttributes = {}): void {
    this.record.events.push({ name, attributes });
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
    const record = {
      name,
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
  readonly span: Span;

  constructor(name: string, span: Span, parent?: TelemetrySpanHandle) {
    this.name = name;
    this.span = span;
    if (parent) this.parentName = parent.name;
  }

  setAttributes(attributes: TelemetryAttributes): void {
    try {
      this.span.setAttributes(attributes as Attributes);
    } catch {
      // Telemetry must never affect the agent run.
    }
  }

  addEvent(name: string, attributes: TelemetryAttributes = {}): void {
    try {
      this.span.addEvent(name, attributes as Attributes);
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
