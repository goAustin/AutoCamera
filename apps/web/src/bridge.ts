import {
  BRIDGE_MAX_PAYLOAD_BYTES,
  BRIDGE_MESSAGE_TYPES,
  BRIDGE_SCHEMA_VERSION,
  BRIDGE_SOURCE,
  BridgeMessageGuard,
  BridgeProtocolError,
  bridgePayloadByteLength,
  createBridgeMessage,
  isJsonObject,
  makeRequestId,
  readManagedBridgeContext,
  validateBridgeEvent,
  validateBridgeMessage,
  type BridgeChildMessage,
  type BridgeParentMessage,
} from '../../../integrations/comfyui-videoops/web/bridge-contract.js';

export {
  BRIDGE_MAX_PAYLOAD_BYTES,
  BRIDGE_MESSAGE_TYPES,
  BRIDGE_SCHEMA_VERSION,
  BRIDGE_SOURCE,
  BridgeMessageGuard,
  BridgeProtocolError,
  bridgePayloadByteLength,
  isJsonObject,
  makeRequestId,
  readManagedBridgeContext,
  validateBridgeEvent,
  validateBridgeMessage,
};
export type { BridgeChildMessage, BridgeParentMessage };

export function createBridgeNonce(): string {
  return makeRequestId('nonce');
}

export function createPanelBridgeMessage(
  type: BridgeChildMessage['type'],
  nonce: string,
  fields: Record<string, unknown> = {},
): BridgeChildMessage {
  return createBridgeMessage(type, fields, {
    nonce,
    direction: 'child',
  }) as BridgeChildMessage;
}

export function validateComfyBridgeEvent(
  event: {
    readonly origin: string;
    readonly source: unknown;
    readonly data: unknown;
  },
  expectedOrigin: string,
  expectedSource: unknown,
  expectedNonce: string,
  seenMessages: Set<string>,
): BridgeParentMessage {
  const message = validateBridgeEvent(event, {
    allowedOrigin: expectedOrigin,
    expectedSource,
    expectedNonce,
    direction: 'parent',
  });
  const key = `${message.type}:${message.requestId}`;
  if (seenMessages.has(key)) {
    throw new BridgeProtocolError('DUPLICATE_MESSAGE');
  }
  seenMessages.add(key);
  return message as BridgeParentMessage;
}
