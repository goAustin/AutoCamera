export const BRIDGE_SOURCE: 'videoops-comfy-bridge';
export const BRIDGE_SCHEMA_VERSION: 1;
export const BRIDGE_MAX_PAYLOAD_BYTES: number;
export const BRIDGE_MESSAGE_TYPES: readonly string[];

export type BridgeGraph = Record<string, unknown>;
export type BridgeEvaluation = string | Record<string, unknown>;

export type BridgeChildMessage =
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly version: typeof BRIDGE_SCHEMA_VERSION;
      readonly type: 'panel.ready';
      readonly requestId: string;
      readonly nonce: string;
    }
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly version: typeof BRIDGE_SCHEMA_VERSION;
      readonly type: 'workflow.load';
      readonly requestId: string;
      readonly nonce: string;
      readonly editorGraph: BridgeGraph;
      readonly revisionId?: string;
    }
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly version: typeof BRIDGE_SCHEMA_VERSION;
      readonly type: 'run.status';
      readonly requestId: string;
      readonly nonce: string;
      readonly runId: string;
      readonly status: string;
      readonly evaluation?: BridgeEvaluation;
    };

export type BridgeParentMessage =
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly version: typeof BRIDGE_SCHEMA_VERSION;
      readonly type: 'comfy.context';
      readonly requestId: string;
      readonly nonce: string;
      readonly frontendVersion: string;
    }
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly version: typeof BRIDGE_SCHEMA_VERSION;
      readonly type: 'workflow.exported';
      readonly requestId: string;
      readonly nonce: string;
      readonly editorGraph: BridgeGraph;
      readonly apiGraph: BridgeGraph;
    }
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly version: typeof BRIDGE_SCHEMA_VERSION;
      readonly type: 'bridge.error';
      readonly requestId: string;
      readonly nonce: string;
      readonly code: string;
    };

export class BridgeProtocolError extends Error {
  readonly code: string;
  constructor(code: string);
}

export function isJsonObject(value: unknown): value is BridgeGraph;
export function bridgePayloadByteLength(value: unknown): number;
export function validateBridgeMessage(
  value: unknown,
  options?: {
    readonly direction?: 'child' | 'parent' | 'any';
    readonly expectedNonce?: string;
    readonly maxPayloadBytes?: number;
  },
): BridgeChildMessage | BridgeParentMessage;
export function validateBridgeEvent(
  event: {
    readonly origin: string;
    readonly source: unknown;
    readonly data: unknown;
  },
  options: {
    readonly allowedOrigin: string | readonly string[];
    readonly expectedSource: unknown;
    readonly expectedNonce?: string;
    readonly direction?: 'child' | 'parent' | 'any';
    readonly maxPayloadBytes?: number;
  },
): BridgeChildMessage | BridgeParentMessage;

export class BridgeMessageGuard {
  constructor(options: {
    readonly allowedOrigin: string | readonly string[];
    readonly expectedSource: unknown;
    readonly expectedNonce?: string;
    readonly direction?: 'child' | 'parent' | 'any';
    readonly maxPayloadBytes?: number;
  });
  accept(event: {
    readonly origin: string;
    readonly source: unknown;
    readonly data: unknown;
  }): BridgeChildMessage | BridgeParentMessage;
  reset(): void;
}

export function createBridgeMessage(
  type: string,
  fields: Record<string, unknown>,
  options: {
    readonly nonce: string;
    readonly requestId?: string;
    readonly direction?: 'child' | 'parent' | 'any';
    readonly maxPayloadBytes?: number;
  },
): BridgeChildMessage | BridgeParentMessage;
export function makeRequestId(prefix?: string): string;
export function readManagedBridgeContext(
  locationLike: string | { readonly href: string },
  referrer?: string,
): {
  readonly nonce: string;
  readonly parentOrigin: string;
  readonly frontendVersion?: string;
} | null;
