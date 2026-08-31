export const BRIDGE_SOURCE = 'videoops-comfy-bridge';
export const BRIDGE_SCHEMA_VERSION = 1;
export const BRIDGE_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

export const BRIDGE_MESSAGE_TYPES = Object.freeze([
  'bridge.ready',
  'bridge.error',
  'workflow.exported',
  'studio.context',
  'workflow.load',
  'workflow.result',
]);

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

const BASE_FIELDS = new Set([
  'source',
  'version',
  'type',
  'requestId',
  'nonce',
]);

const MESSAGE_FIELDS = Object.freeze({
  'bridge.ready': new Set([...BASE_FIELDS, 'frontendVersion']),
  'bridge.error': new Set([...BASE_FIELDS, 'code']),
  'workflow.exported': new Set([
    ...BASE_FIELDS,
    'editorGraph',
    'apiGraph',
    'frontendVersion',
  ]),
  'studio.context': new Set([...BASE_FIELDS, 'projectId', 'shotId']),
  'workflow.load': new Set([...BASE_FIELDS, 'editorGraph', 'revisionId']),
  'workflow.result': new Set([
    ...BASE_FIELDS,
    'status',
    'code',
    'message',
    'revisionId',
    'attemptId',
  ]),
});

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const MAX_TEXT_LENGTH = 256;

export class BridgeProtocolError extends Error {
  constructor(code) {
    super(`Bridge message rejected: ${code}.`);
    this.name = 'BridgeProtocolError';
    this.code = code;
  }
}

function reject(code) {
  throw new BridgeProtocolError(code);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonObject(value) {
  return isRecord(value) && isJsonValue(value);
}

function isJsonValue(value, ancestors = new Set()) {
  if (value === null) return true;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }

  if (ancestors.has(value)) return false;
  ancestors.add(value);

  let valid = true;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isJsonValue(item, ancestors)) {
        valid = false;
        break;
      }
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      valid = false;
    } else {
      for (const [key, item] of Object.entries(value)) {
        if (typeof key !== 'string' || !isJsonValue(item, ancestors)) {
          valid = false;
          break;
        }
      }
    }
  }

  ancestors.delete(value);
  return valid;
}

function utf8ByteLength(value) {
  if (typeof TextEncoder === 'function') {
    return new TextEncoder().encode(value).byteLength;
  }
  return value.length;
}

export function bridgePayloadByteLength(value) {
  if (!isJsonValue(value)) return Number.POSITIVE_INFINITY;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : utf8ByteLength(serialized);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function safeText(value, code) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TEXT_LENGTH
  ) {
    reject(code);
  }
  return value;
}

function safeId(value, code = 'MESSAGE_INVALID') {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
    reject(code);
  }
  return value;
}

function safeOrigin(value) {
  if (typeof value !== 'string' || value === '*') {
    reject('ORIGIN_INVALID');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    reject('ORIGIN_INVALID');
  }

  if (
    !parsed ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== '/' ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    reject('ORIGIN_INVALID');
  }

  return parsed.origin;
}

function parseData(data, maxPayloadBytes) {
  if (typeof data === 'string') {
    if (utf8ByteLength(data) > maxPayloadBytes) {
      reject('PAYLOAD_TOO_LARGE');
    }
    try {
      data = JSON.parse(data);
    } catch {
      reject('MALFORMED_JSON');
    }
  }

  if (!isRecord(data)) {
    reject('MESSAGE_INVALID');
  }

  if (bridgePayloadByteLength(data) > maxPayloadBytes) {
    reject('PAYLOAD_TOO_LARGE');
  }

  return data;
}

function validateFields(message, type) {
  const allowedFields = MESSAGE_FIELDS[type];
  for (const key of Object.keys(message)) {
    if (!allowedFields.has(key)) reject('UNKNOWN_FIELD');
  }
}

function validateGraph(value) {
  if (!isJsonObject(value)) reject('GRAPH_INVALID');
  return value;
}

export function validateBridgeMessage(data, options = {}) {
  const maxPayloadBytes = options.maxPayloadBytes ?? BRIDGE_MAX_PAYLOAD_BYTES;
  if (
    !Number.isSafeInteger(maxPayloadBytes) ||
    maxPayloadBytes < 1 ||
    maxPayloadBytes > BRIDGE_MAX_PAYLOAD_BYTES
  ) {
    reject('PAYLOAD_LIMIT_INVALID');
  }

  const message = parseData(data, maxPayloadBytes);
  if (message.source !== BRIDGE_SOURCE) reject('SOURCE_INVALID');
  if (message.version !== BRIDGE_SCHEMA_VERSION) {
    reject('SCHEMA_VERSION_UNSUPPORTED');
  }
  if (!BRIDGE_MESSAGE_TYPES.includes(message.type)) {
    reject('MESSAGE_TYPE_INVALID');
  }
  safeId(message.requestId, 'REQUEST_ID_INVALID');
  safeId(message.nonce, 'NONCE_INVALID');
  if (
    options.expectedNonce !== undefined &&
    message.nonce !== options.expectedNonce
  ) {
    reject('NONCE_MISMATCH');
  }

  const direction = options.direction ?? 'any';
  if (
    (direction === 'child' && !CHILD_MESSAGE_TYPES.has(message.type)) ||
    (direction === 'parent' && !PARENT_MESSAGE_TYPES.has(message.type))
  ) {
    reject('MESSAGE_DIRECTION_INVALID');
  }

  validateFields(message, message.type);

  switch (message.type) {
    case 'bridge.ready':
      if (message.frontendVersion !== undefined) {
        safeText(message.frontendVersion, 'FRONTEND_VERSION_INVALID');
      }
      break;
    case 'bridge.error':
      if (
        typeof message.code !== 'string' ||
        !SAFE_CODE_PATTERN.test(message.code)
      ) {
        reject('ERROR_CODE_INVALID');
      }
      break;
    case 'workflow.exported':
      validateGraph(message.editorGraph);
      validateGraph(message.apiGraph);
      safeText(message.frontendVersion, 'FRONTEND_VERSION_INVALID');
      break;
    case 'studio.context':
      safeId(message.projectId, 'CONTEXT_INVALID');
      safeId(message.shotId, 'CONTEXT_INVALID');
      break;
    case 'workflow.load':
      validateGraph(message.editorGraph);
      if (message.revisionId !== undefined) {
        safeId(message.revisionId, 'REVISION_ID_INVALID');
      }
      break;
    case 'workflow.result':
      safeText(message.status, 'RESULT_STATUS_INVALID');
      for (const key of ['code', 'message', 'revisionId', 'attemptId']) {
        if (message[key] !== undefined)
          safeText(message[key], 'RESULT_INVALID');
      }
      break;
    default:
      reject('MESSAGE_TYPE_INVALID');
  }

  return message;
}

export function validateBridgeEvent(event, options = {}) {
  if (!event || typeof event !== 'object') reject('EVENT_INVALID');

  const allowedOrigins = Array.isArray(options.allowedOrigin)
    ? options.allowedOrigin
    : [options.allowedOrigin];
  if (
    !allowedOrigins.some(
      (origin) => typeof origin === 'string' && origin === event.origin,
    )
  ) {
    reject('ORIGIN_MISMATCH');
  }
  if (
    options.expectedSource === undefined ||
    event.source !== options.expectedSource
  ) {
    reject('SOURCE_MISMATCH');
  }

  return validateBridgeMessage(event.data, options);
}

export class BridgeMessageGuard {
  constructor(options) {
    this.options = {
      ...options,
      maxPayloadBytes: options.maxPayloadBytes ?? BRIDGE_MAX_PAYLOAD_BYTES,
    };
    this.seen = new Set();
  }

  accept(event) {
    const message = validateBridgeEvent(event, this.options);
    const key = `${message.type}:${message.requestId}`;
    if (this.seen.has(key)) reject('DUPLICATE_MESSAGE');
    this.seen.add(key);
    if (this.seen.size > 512) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return message;
  }
}

export function createBridgeMessage(type, fields, options) {
  const message = {
    source: BRIDGE_SOURCE,
    version: BRIDGE_SCHEMA_VERSION,
    type,
    requestId: options.requestId ?? options.nonce,
    nonce: options.nonce,
    ...fields,
  };
  return validateBridgeMessage(message, {
    direction: options.direction ?? 'any',
    expectedNonce: options.nonce,
    maxPayloadBytes: options.maxPayloadBytes,
  });
}

export function readManagedBridgeContext(locationLike, referrer = '') {
  let url;
  try {
    url = new URL(
      typeof locationLike === 'string' ? locationLike : locationLike.href,
    );
  } catch {
    return null;
  }

  if (url.searchParams.get('videoopsManaged') !== '1') return null;

  const nonce = url.searchParams.get('nonce');
  if (typeof nonce !== 'string' || !SAFE_ID_PATTERN.test(nonce)) return null;

  let parentOrigin = url.searchParams.get('parentOrigin');
  if (!parentOrigin && referrer) {
    try {
      parentOrigin = new URL(referrer).origin;
    } catch {
      parentOrigin = null;
    }
  }
  if (!parentOrigin) return null;

  try {
    parentOrigin = safeOrigin(parentOrigin);
  } catch {
    return null;
  }

  const projectId = url.searchParams.get('projectId') ?? undefined;
  const shotId = url.searchParams.get('shotId') ?? undefined;
  if (
    (projectId !== undefined && !SAFE_ID_PATTERN.test(projectId)) ||
    (shotId !== undefined && !SAFE_ID_PATTERN.test(shotId))
  ) {
    return null;
  }

  const frontendVersion = url.searchParams.get('frontendVersion') ?? 'unknown';
  if (
    frontendVersion.length === 0 ||
    frontendVersion.length > MAX_TEXT_LENGTH
  ) {
    return null;
  }

  return {
    nonce,
    parentOrigin,
    ...(projectId ? { projectId } : {}),
    ...(shotId ? { shotId } : {}),
    frontendVersion,
  };
}

export function makeRequestId(prefix = 'message') {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return `${prefix}-${cryptoObject.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}
