export const BRIDGE_SOURCE = 'videoops-comfy-bridge';
export const BRIDGE_SCHEMA_VERSION = 1;
export const BRIDGE_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

const CHILD_MESSAGE_TYPES = new Set([
  'bridge.ready',
  'bridge.error',
  'workflow.exported',
]);

const PARENT_MESSAGE_TYPES = new Set([
  'studio.context',
  'workflow.load',
  'workflow.result',
]);

const FIELD_SETS: Readonly<Record<string, ReadonlySet<string>>> = {
  'bridge.ready': new Set([
    'source',
    'version',
    'type',
    'requestId',
    'nonce',
    'frontendVersion',
  ]),
  'bridge.error': new Set([
    'source',
    'version',
    'type',
    'requestId',
    'nonce',
    'code',
  ]),
  'workflow.exported': new Set([
    'source',
    'version',
    'type',
    'requestId',
    'nonce',
    'editorGraph',
    'apiGraph',
    'frontendVersion',
  ]),
  'studio.context': new Set([
    'source',
    'version',
    'type',
    'requestId',
    'nonce',
    'projectId',
    'shotId',
  ]),
  'workflow.load': new Set([
    'source',
    'version',
    'type',
    'requestId',
    'nonce',
    'editorGraph',
    'revisionId',
  ]),
  'workflow.result': new Set([
    'source',
    'version',
    'type',
    'requestId',
    'nonce',
    'status',
    'code',
    'message',
    'revisionId',
    'attemptId',
  ]),
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;

export type BridgeChildMessage =
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly version: typeof BRIDGE_SCHEMA_VERSION;
      readonly type: 'bridge.ready';
      readonly requestId: string;
      readonly nonce: string;
      readonly frontendVersion: string;
    }
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly version: typeof BRIDGE_SCHEMA_VERSION;
      readonly type: 'bridge.error';
      readonly requestId: string;
      readonly nonce: string;
      readonly code: string;
    }
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly version: typeof BRIDGE_SCHEMA_VERSION;
      readonly type: 'workflow.exported';
      readonly requestId: string;
      readonly nonce: string;
      readonly editorGraph: Record<string, unknown>;
      readonly apiGraph: Record<string, unknown>;
      readonly frontendVersion: string;
    };

export type BridgeParentMessage =
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly version: typeof BRIDGE_SCHEMA_VERSION;
      readonly type: 'studio.context';
      readonly requestId: string;
      readonly nonce: string;
      readonly projectId: string;
      readonly shotId: string;
    }
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly version: typeof BRIDGE_SCHEMA_VERSION;
      readonly type: 'workflow.load';
      readonly requestId: string;
      readonly nonce: string;
      readonly editorGraph: Record<string, unknown>;
      readonly revisionId?: string;
    }
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly version: typeof BRIDGE_SCHEMA_VERSION;
      readonly type: 'workflow.result';
      readonly requestId: string;
      readonly nonce: string;
      readonly status: string;
      readonly code?: string;
      readonly message?: string;
      readonly revisionId?: string;
      readonly attemptId?: string;
    };

export class BridgeProtocolError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Bridge message rejected: ${code}.`);
    this.name = 'BridgeProtocolError';
    this.code = code;
  }
}

function reject(code: string): never {
  throw new BridgeProtocolError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    valid = value.every((item) => isJsonValue(item, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value);
    valid =
      (prototype === Object.prototype || prototype === null) &&
      Object.entries(value).every(
        ([key, item]) =>
          typeof key === 'string' && isJsonValue(item, ancestors),
      );
  }
  ancestors.delete(value);
  return valid;
}

function payloadByteLength(value: unknown): number {
  if (!isJsonValue(value)) return Number.POSITIVE_INFINITY;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function safeText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    return reject(code);
  }
  return value;
}

function safeId(value: unknown, code = 'MESSAGE_INVALID'): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) return reject(code);
  return value;
}

function validateGraph(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value) || !isJsonValue(value)) return reject(code);
  return value;
}

function validateFields(message: Record<string, unknown>, type: string): void {
  const fields = FIELD_SETS[type];
  if (!fields || Object.keys(message).some((key) => !fields.has(key))) {
    reject('MESSAGE_FIELDS_INVALID');
  }
}

export function validateBridgeMessage(
  value: unknown,
): BridgeChildMessage | BridgeParentMessage {
  let message = value;
  if (typeof message === 'string') {
    if (
      new TextEncoder().encode(message).byteLength > BRIDGE_MAX_PAYLOAD_BYTES
    ) {
      return reject('PAYLOAD_TOO_LARGE');
    }
    try {
      message = JSON.parse(message) as unknown;
    } catch {
      return reject('MALFORMED_JSON');
    }
  }
  if (
    !isRecord(message) ||
    payloadByteLength(message) > BRIDGE_MAX_PAYLOAD_BYTES
  ) {
    return reject('PAYLOAD_TOO_LARGE');
  }
  if (message.source !== BRIDGE_SOURCE) return reject('SOURCE_INVALID');
  if (message.version !== BRIDGE_SCHEMA_VERSION)
    return reject('SCHEMA_VERSION_UNSUPPORTED');
  if (typeof message.type !== 'string') return reject('MESSAGE_TYPE_INVALID');
  if (!FIELD_SETS[message.type]) return reject('MESSAGE_TYPE_INVALID');
  validateFields(message, message.type);
  const requestId = safeId(message.requestId);
  const nonce = safeId(message.nonce, 'NONCE_INVALID');
  if (message.type === 'bridge.ready') {
    return {
      source: BRIDGE_SOURCE,
      version: BRIDGE_SCHEMA_VERSION,
      type: 'bridge.ready',
      requestId,
      nonce,
      frontendVersion: safeText(
        message.frontendVersion,
        'FRONTEND_VERSION_INVALID',
      ),
    };
  }
  if (message.type === 'bridge.error') {
    const code = safeText(message.code, 'ERROR_CODE_INVALID');
    if (!SAFE_CODE.test(code)) return reject('ERROR_CODE_INVALID');
    return {
      source: BRIDGE_SOURCE,
      version: BRIDGE_SCHEMA_VERSION,
      type: 'bridge.error',
      requestId,
      nonce,
      code,
    };
  }
  if (message.type === 'workflow.exported') {
    return {
      source: BRIDGE_SOURCE,
      version: BRIDGE_SCHEMA_VERSION,
      type: 'workflow.exported',
      requestId,
      nonce,
      editorGraph: validateGraph(message.editorGraph, 'EDITOR_GRAPH_INVALID'),
      apiGraph: validateGraph(message.apiGraph, 'API_GRAPH_INVALID'),
      frontendVersion: safeText(
        message.frontendVersion,
        'FRONTEND_VERSION_INVALID',
      ),
    };
  }
  if (message.type === 'studio.context') {
    return {
      source: BRIDGE_SOURCE,
      version: BRIDGE_SCHEMA_VERSION,
      type: 'studio.context',
      requestId,
      nonce,
      projectId: safeId(message.projectId, 'PROJECT_ID_INVALID'),
      shotId: safeId(message.shotId, 'SHOT_ID_INVALID'),
    };
  }
  if (message.type === 'workflow.load') {
    return {
      source: BRIDGE_SOURCE,
      version: BRIDGE_SCHEMA_VERSION,
      type: 'workflow.load',
      requestId,
      nonce,
      editorGraph: validateGraph(message.editorGraph, 'EDITOR_GRAPH_INVALID'),
      ...(message.revisionId === undefined
        ? {}
        : { revisionId: safeId(message.revisionId, 'REVISION_ID_INVALID') }),
    };
  }
  if (message.type === 'workflow.result') {
    const code =
      message.code === undefined
        ? undefined
        : safeText(message.code, 'RESULT_CODE_INVALID');
    if (code !== undefined && !SAFE_CODE.test(code))
      return reject('RESULT_CODE_INVALID');
    const resultMessage =
      message.message === undefined
        ? undefined
        : safeText(message.message, 'RESULT_MESSAGE_INVALID');
    return {
      source: BRIDGE_SOURCE,
      version: BRIDGE_SCHEMA_VERSION,
      type: 'workflow.result',
      requestId,
      nonce,
      status: safeText(message.status, 'RESULT_STATUS_INVALID'),
      ...(code === undefined ? {} : { code }),
      ...(resultMessage === undefined ? {} : { message: resultMessage }),
      ...(message.revisionId === undefined
        ? {}
        : { revisionId: safeId(message.revisionId, 'REVISION_ID_INVALID') }),
      ...(message.attemptId === undefined
        ? {}
        : { attemptId: safeId(message.attemptId, 'ATTEMPT_ID_INVALID') }),
    };
  }
  return reject('DIRECTION_INVALID');
}

export function validateParentBridgeEvent(
  event: {
    readonly origin: string;
    readonly source: unknown;
    readonly data: unknown;
  },
  expectedOrigin: string,
  expectedSource: unknown,
  expectedNonce: string,
  seenMessages: Set<string>,
): BridgeChildMessage {
  if (event.origin !== expectedOrigin) return reject('ORIGIN_MISMATCH');
  if (event.source !== expectedSource) return reject('SOURCE_MISMATCH');
  const message = validateBridgeMessage(event.data);
  if (!CHILD_MESSAGE_TYPES.has(message.type))
    return reject('DIRECTION_INVALID');
  if (message.nonce !== expectedNonce) return reject('NONCE_MISMATCH');
  const key = `${message.type}:${message.requestId}`;
  if (seenMessages.has(key)) return reject('DUPLICATE_MESSAGE');
  seenMessages.add(key);
  return message as BridgeChildMessage;
}

function messageId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

export function createBridgeNonce(): string {
  return messageId();
}

export function createParentBridgeMessage(
  type: BridgeParentMessage['type'],
  nonce: string,
  fields: Record<string, unknown>,
): BridgeParentMessage {
  const message = {
    source: BRIDGE_SOURCE,
    version: BRIDGE_SCHEMA_VERSION,
    type,
    requestId: messageId(),
    nonce,
    ...fields,
  };
  const validated = validateBridgeMessage(message);
  if (!PARENT_MESSAGE_TYPES.has(validated.type))
    return reject('DIRECTION_INVALID');
  return validated as BridgeParentMessage;
}
