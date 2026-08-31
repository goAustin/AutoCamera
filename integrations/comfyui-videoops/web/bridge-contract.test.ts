import { describe, expect, it } from 'vitest';
import {
  BRIDGE_MAX_PAYLOAD_BYTES,
  BRIDGE_SCHEMA_VERSION,
  BRIDGE_SOURCE,
  BridgeMessageGuard,
  BridgeProtocolError,
  createBridgeMessage,
  validateBridgeMessage,
} from './bridge-contract.js';
import { createVideoOpsBridge } from './bridge-runtime.js';

function protocolError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeProtocolError);
    expect((error as BridgeProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`Expected bridge protocol error ${code}.`);
}

function message(type: string, fields: Record<string, unknown> = {}) {
  return createBridgeMessage(type, fields, {
    nonce: 'session-nonce',
    requestId: `${type}-request`,
  });
}

function fakeWindow() {
  const listeners = new Set<(event: unknown) => void>();
  const posted: Array<{ message: unknown; targetOrigin: string }> = [];
  const parent = {
    postMessage(value: unknown, targetOrigin: string) {
      posted.push({ message: value, targetOrigin });
    },
  };
  const windowRef = {
    parent,
    location: {
      href: 'https://comfy.example.test/?videoopsManaged=1&projectId=project-1&shotId=shot-1&nonce=session-nonce&parentOrigin=https%3A%2F%2Fstudio.example.test&frontendVersion=frontend-pin',
    },
    addEventListener(_type: string, listener: (event: unknown) => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: (event: unknown) => void) {
      listeners.delete(listener);
    },
    dispatch(event: unknown) {
      for (const listener of listeners) listener(event);
    },
  };
  return { parent, posted, windowRef };
}

describe('ComfyUI VideoOps bridge contract', () => {
  it('requires the exact origin, source window, schema, and session nonce', () => {
    const { parent } = fakeWindow();
    const guard = new BridgeMessageGuard({
      allowedOrigin: 'https://studio.example.test',
      expectedSource: parent,
      expectedNonce: 'session-nonce',
      direction: 'parent',
    });
    const valid = message('studio.context', {
      projectId: 'project-1',
      shotId: 'shot-1',
    });

    expect(
      guard.accept({
        origin: 'https://studio.example.test',
        source: parent,
        data: valid,
      }).type,
    ).toBe('studio.context');
    protocolError(
      () =>
        guard.accept({
          origin: 'https://evil.example.test',
          source: parent,
          data: message('workflow.result', { status: 'queued' }),
        }),
      'ORIGIN_MISMATCH',
    );
    protocolError(
      () =>
        guard.accept({
          origin: 'https://studio.example.test',
          source: {},
          data: message('workflow.result', { status: 'queued' }),
        }),
      'SOURCE_MISMATCH',
    );
    protocolError(
      () =>
        guard.accept({
          origin: 'https://studio.example.test',
          source: parent,
          data: message('workflow.result', {
            status: 'queued',
            nonce: 'stale-nonce',
          }),
        }),
      'NONCE_MISMATCH',
    );
    protocolError(
      () =>
        validateBridgeMessage({
          ...valid,
          version: BRIDGE_SCHEMA_VERSION + 1,
        }),
      'SCHEMA_VERSION_UNSUPPORTED',
    );
  });

  it('rejects malformed JSON, duplicates, unknown types, and oversize payloads', () => {
    const { parent } = fakeWindow();
    const guard = new BridgeMessageGuard({
      allowedOrigin: 'https://studio.example.test',
      expectedSource: parent,
      expectedNonce: 'session-nonce',
      direction: 'parent',
    });
    const event = {
      origin: 'https://studio.example.test',
      source: parent,
      data: message('workflow.result', { status: 'queued' }),
    };
    guard.accept(event);
    protocolError(() => guard.accept(event), 'DUPLICATE_MESSAGE');
    protocolError(
      () => validateBridgeMessage('{"source":"videoops-comfy-bridge"'),
      'MALFORMED_JSON',
    );
    protocolError(
      () =>
        validateBridgeMessage({
          ...message('workflow.result', { status: 'queued' }),
          type: 'unknown.message',
        }),
      'MESSAGE_TYPE_INVALID',
    );
    protocolError(
      () =>
        validateBridgeMessage(
          message('workflow.result', {
            status: 'queued',
            message: 'x'.repeat(BRIDGE_MAX_PAYLOAD_BYTES),
          }),
        ),
      'PAYLOAD_TOO_LARGE',
    );
  });

  it('exports both graphToPrompt properties through the exact parent origin', () => {
    const { parent, posted, windowRef } = fakeWindow();
    const errors: string[] = [];
    const app = {
      graphToPrompt: () => ({
        workflow: { nodes: [{ id: 1, type: 'SaveVideo' }] },
        output: { '1': { class_type: 'SaveVideo', inputs: {} } },
      }),
      loadGraphData: () => {},
    };
    const bridge = createVideoOpsBridge({
      app,
      windowRef,
      onProtocolError: (code: string) => errors.push(code),
    });

    expect(bridge.enabled).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.targetOrigin).toBe('https://studio.example.test');
    expect(posted[0]?.message).toMatchObject({
      source: BRIDGE_SOURCE,
      version: 1,
      type: 'bridge.ready',
      nonce: 'session-nonce',
    });

    windowRef.dispatch({
      origin: 'https://studio.example.test',
      source: parent,
      data: message('studio.context', {
        projectId: 'project-1',
        shotId: 'shot-1',
      }),
    });
    expect(bridge.exportCurrentWorkflow()).toBe(true);
    const exportMessage = posted[1]?.message as Record<string, unknown>;
    expect(exportMessage).toMatchObject({
      type: 'workflow.exported',
      nonce: 'session-nonce',
      editorGraph: { nodes: [{ id: 1, type: 'SaveVideo' }] },
      apiGraph: { '1': { class_type: 'SaveVideo', inputs: {} } },
    });
    expect(exportMessage).not.toHaveProperty('token');
    expect(exportMessage).not.toHaveProperty('privateExecutorUrl');
    expect(errors).toEqual([]);

    bridge.destroy();
    expect(bridge.exportCurrentWorkflow()).toBe(false);
    expect(posted).toHaveLength(2);
  });

  it('loads only validated parent graphs and ignores an iframe from another origin', () => {
    const { parent, windowRef } = fakeWindow();
    const loaded: unknown[] = [];
    const errors: string[] = [];
    const bridge = createVideoOpsBridge({
      app: {
        graphToPrompt: () => ({ workflow: {}, output: {} }),
        loadGraphData: (graph: unknown) => loaded.push(graph),
      },
      windowRef,
      onProtocolError: (code: string) => errors.push(code),
    });
    windowRef.dispatch({
      origin: 'https://studio.example.test',
      source: parent,
      data: message('studio.context', {
        projectId: 'project-1',
        shotId: 'shot-1',
      }),
    });
    windowRef.dispatch({
      origin: 'https://studio.example.test',
      source: parent,
      data: message('workflow.load', { editorGraph: { nodes: [] } }),
    });
    windowRef.dispatch({
      origin: 'https://evil.example.test',
      source: parent,
      data: message('workflow.load', { editorGraph: { token: 'nope' } }),
    });

    expect(loaded).toEqual([{ nodes: [] }]);
    expect(errors).toContain('ORIGIN_MISMATCH');
    bridge.destroy();
  });

  it('starts a fresh duplicate ledger after an iframe reload', () => {
    const first = fakeWindow();
    const firstBridge = createVideoOpsBridge({
      app: { loadGraphData: () => {} },
      windowRef: first.windowRef,
    });
    const context = {
      origin: 'https://studio.example.test',
      source: first.parent,
      data: message('studio.context', {
        projectId: 'project-1',
        shotId: 'shot-1',
      }),
    };
    first.windowRef.dispatch(context);
    firstBridge.destroy();

    const second = fakeWindow();
    const secondBridge = createVideoOpsBridge({
      app: { loadGraphData: () => {} },
      windowRef: second.windowRef,
    });
    second.windowRef.dispatch({
      ...context,
      source: second.parent,
    });

    expect(secondBridge.getCurrentContext()).toEqual({
      projectId: 'project-1',
      shotId: 'shot-1',
    });
    secondBridge.destroy();
  });
});
