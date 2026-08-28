import { randomBytes } from 'node:crypto';

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
