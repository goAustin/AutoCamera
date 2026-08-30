import { createHash } from 'node:crypto';

export interface WorkflowExecutionEnvelope {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly apiGraph: Readonly<Record<string, unknown>>;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export class WorkflowCanonicalizationError extends Error {
  readonly code = 'NON_CANONICAL_JSON' as const;

  constructor(message: string) {
    super(message);
    this.name = 'WorkflowCanonicalizationError';
  }
}

/**
 * Serialize JSON without depending on insertion order. Arrays retain their
 * order because array order is part of a ComfyUI execution graph's meaning.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new WorkflowCanonicalizationError(
        'Canonical JSON cannot contain a non-finite number.',
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new WorkflowCanonicalizationError(
      'Canonical JSON contains a non-JSON value.',
    );
  }
  if (Array.isArray(value)) {
    return `[${Array.from({ length: value.length }, (_, index) => {
      if (!(index in value)) {
        throw new WorkflowCanonicalizationError(
          'Canonical JSON cannot contain sparse arrays.',
        );
      }
      return canonicalizeJson(value[index]);
    }).join(',')}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkflowCanonicalizationError(
      'Canonical JSON only accepts plain objects and arrays.',
    );
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => {
      const candidate = record[key];
      if (candidate === undefined) {
        throw new WorkflowCanonicalizationError(
          'Canonical JSON cannot contain undefined object values.',
        );
      }
      return `${JSON.stringify(key)}:${canonicalizeJson(candidate)}`;
    })
    .join(',')}}`;
}

export function canonicalizeWorkflowExecutionEnvelope(
  envelope: WorkflowExecutionEnvelope,
): string {
  return canonicalizeJson({
    profileId: envelope.profileId,
    profileVersion: envelope.profileVersion,
    apiGraph: envelope.apiGraph,
    parameters: envelope.parameters,
  });
}

export function hashWorkflowExecutionEnvelope(
  envelope: WorkflowExecutionEnvelope,
): string {
  return createHash('sha256')
    .update(canonicalizeWorkflowExecutionEnvelope(envelope), 'utf8')
    .digest('hex');
}

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalizeJson(value), 'utf8');
}
