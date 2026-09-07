import { describe, expect, it } from 'vitest';
import {
  BRIDGE_MAX_PAYLOAD_BYTES,
  BRIDGE_SCHEMA_VERSION,
  BRIDGE_SOURCE,
  BridgeMessageGuard,
  BridgeProtocolError,
  createBridgeMessage,
  readManagedBridgeContext,
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

function message(
  type: string,
  fields: Record<string, unknown> = {},
  direction: 'child' | 'parent' | 'any' = 'any',
) {
  return createBridgeMessage(type, fields, {
    nonce: 'session-nonce',
    requestId: `${type.replaceAll('.', '-')}-request`,
    direction,
  });
}

function fakeParentWindow() {
  const listeners = new Set<(event: unknown) => void>();
  const posted: Array<{ message: unknown; targetOrigin: string }> = [];
  const parentWindow = {
    postMessage(value: unknown, targetOrigin: string) {
      posted.push({ message: value, targetOrigin });
    },
  };
  const frameWindow = {
    postMessage(value: unknown, targetOrigin: string) {
      posted.push({ message: value, targetOrigin });
    },
  };
  const body = {
    appendChild(element: unknown) {
      (element as { parentElement?: unknown }).parentElement = body;
    },
  };
  const documentRef = {
    body,
    querySelector: () => null,
    createElement: () => ({
      contentWindow: frameWindow,
      addEventListener: () => {},
      removeEventListener: () => {},
      setAttribute: () => {},
      remove: () => {},
      style: {},
      className: '',
      title: '',
      src: '',
      hidden: false,
    }),
  };
  const windowRef = {
    location: { href: 'http://comfy.example.test/' },
    __VIDEOOPS_STUDIO_ORIGIN__: 'https://studio.example.test',
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
  return { frameWindow, parentWindow, posted, windowRef, documentRef };
}

describe('ComfyUI VideoOps bridge contract', () => {
  it('requires the exact origin, source window, schema, direction, and nonce', () => {
    const source = {};
    const guard = new BridgeMessageGuard({
      allowedOrigin: 'https://studio.example.test',
      expectedSource: source,
      expectedNonce: 'session-nonce',
      direction: 'child',
    });
    const valid = message('panel.ready', {}, 'child');

    expect(
      guard.accept({
        origin: 'https://studio.example.test',
        source,
        data: valid,
      }).type,
    ).toBe('panel.ready');
    protocolError(
      () =>
        guard.accept({
          origin: 'https://evil.example.test',
          source,
          data: message('panel.ready', {}, 'child'),
        }),
      'ORIGIN_MISMATCH',
    );
    protocolError(
      () =>
        guard.accept({
          origin: 'https://studio.example.test',
          source: {},
          data: message('panel.ready', {}, 'child'),
        }),
      'SOURCE_MISMATCH',
    );
    protocolError(
      () =>
        validateBridgeMessage(
          message('comfy.context', { frontendVersion: 'pinned' }, 'parent'),
          { direction: 'child' },
        ),
      'MESSAGE_DIRECTION_INVALID',
    );
    protocolError(
      () =>
        validateBridgeMessage({
          ...valid,
          version: BRIDGE_SCHEMA_VERSION + 1,
        }),
      'SCHEMA_VERSION_UNSUPPORTED',
    );
    protocolError(
      () =>
        validateBridgeMessage(
          {
            ...valid,
            nonce: 'stale-nonce',
          },
          { expectedNonce: 'session-nonce' },
        ),
      'NONCE_MISMATCH',
    );
  });

  it('rejects malformed JSON, duplicates, unknown fields, credentials, and oversize payloads', () => {
    const source = {};
    const guard = new BridgeMessageGuard({
      allowedOrigin: 'https://studio.example.test',
      expectedSource: source,
      expectedNonce: 'session-nonce',
      direction: 'child',
    });
    const event = {
      origin: 'https://studio.example.test',
      source,
      data: message('panel.ready', {}, 'child'),
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
          ...message('panel.ready'),
          type: 'unknown.message',
        }),
      'MESSAGE_TYPE_INVALID',
    );
    protocolError(
      () =>
        validateBridgeMessage({
          ...message('panel.ready'),
          extra: true,
        }),
      'UNKNOWN_FIELD',
    );
    protocolError(
      () =>
        validateBridgeMessage(
          message('workflow.load', {
            editorGraph: { nested: { authorization: 'Bearer secret-value' } },
          }),
        ),
      'CREDENTIAL_FIELD_FORBIDDEN',
    );
    protocolError(
      () =>
        validateBridgeMessage(
          message('workflow.load', {
            editorGraph: { nested: { access_token: 'secret-value' } },
          }),
        ),
      'CREDENTIAL_FIELD_FORBIDDEN',
    );
    protocolError(
      () =>
        validateBridgeMessage(
          message('run.status', {
            runId: 'run-1',
            status: 'running',
            evaluation: { detail: 'x'.repeat(BRIDGE_MAX_PAYLOAD_BYTES) },
          }),
        ),
      'PAYLOAD_TOO_LARGE',
    );
  });

  it('keeps the parent runtime on the Comfy side and awaits the public graph export API', async () => {
    const { frameWindow, posted, windowRef, documentRef } = fakeParentWindow();
    const loaded: unknown[] = [];
    const errors: string[] = [];
    let resolveGraph: ((value: unknown) => void) | undefined;
    const graphReady = new Promise((resolve) => {
      resolveGraph = resolve;
    });
    const bridge = createVideoOpsBridge({
      app: {
        graphToPrompt: async () => graphReady,
        loadGraphData: (graph: unknown) => loaded.push(graph),
      },
      windowRef,
      documentRef,
      onProtocolError: (code: string) => errors.push(code),
    });

    expect(bridge.enabled).toBe(true);
    expect(posted).toHaveLength(0);
    windowRef.dispatch({
      origin: 'https://studio.example.test',
      source: frameWindow,
      data: { ...message('panel.ready', {}, 'child'), nonce: bridge.nonce },
    });
    expect(posted[0]?.targetOrigin).toBe('https://studio.example.test');
    expect(posted[0]?.message).toMatchObject({
      source: BRIDGE_SOURCE,
      version: 1,
      type: 'comfy.context',
      nonce: bridge.nonce,
      frontendVersion: expect.any(String),
    });

    const exportPromise = bridge.exportCurrentWorkflow();
    resolveGraph?.({
      workflow: { nodes: [{ id: 1, type: 'SaveVideo' }] },
      output: { '1': { class_type: 'SaveVideo', inputs: {} } },
    });
    await expect(exportPromise).resolves.toBe(true);
    const exportMessage = posted[1]?.message as Record<string, unknown>;
    expect(exportMessage).toMatchObject({
      type: 'workflow.exported',
      nonce: bridge.nonce,
      editorGraph: { nodes: [{ id: 1, type: 'SaveVideo' }] },
      apiGraph: { '1': { class_type: 'SaveVideo', inputs: {} } },
    });
    expect(exportMessage).not.toHaveProperty('token');
    expect(exportMessage).not.toHaveProperty('authorization');

    windowRef.dispatch({
      origin: 'https://studio.example.test',
      source: frameWindow,
      data: {
        ...message('workflow.load', { editorGraph: { nodes: [] } }, 'child'),
        nonce: bridge.nonce,
      },
    });
    await Promise.resolve();
    expect(loaded).toEqual([{ nodes: [] }]);
    expect(errors).toEqual([]);
    bridge.destroy();
  });

  it('fails closed for an unexpected source and never sends a wildcard target origin', () => {
    const { posted, windowRef, documentRef } = fakeParentWindow();
    const errors: string[] = [];
    const bridge = createVideoOpsBridge({
      app: { graphToPrompt: async () => ({ workflow: {}, output: {} }) },
      windowRef,
      documentRef,
      onProtocolError: (code: string) => errors.push(code),
    });
    windowRef.dispatch({
      origin: 'https://studio.example.test',
      source: {},
      data: message('panel.ready', {}, 'child'),
    });
    expect(errors).toContain('SOURCE_MISMATCH');
    expect(posted.every((entry) => entry.targetOrigin !== '*')).toBe(true);
    bridge.destroy();
  });
});

describe('readManagedBridgeContext embedder corroboration', () => {
  const managed = (parentOrigin?: string) =>
    `https://studio.example.com/panel?videoopsManaged=1&nonce=session-nonce${
      parentOrigin ? `&parentOrigin=${encodeURIComponent(parentOrigin)}` : ''
    }`;

  it('accepts a declared parentOrigin that matches the real embedder', () => {
    const context = readManagedBridgeContext(
      managed('https://comfy.example.com'),
      'https://comfy.example.com/index.html',
    );
    expect(context?.parentOrigin).toBe('https://comfy.example.com');
  });

  it('rejects a declared parentOrigin that disagrees with the embedder', () => {
    // A hostile page frames Studio and declares someone else's origin; without
    // corroboration the panel would accept its messages and post run status
    // back to it.
    expect(
      readManagedBridgeContext(
        managed('https://attacker.example'),
        'https://comfy.example.com/index.html',
      ),
    ).toBeNull();
  });

  it('rejects a declared parentOrigin that cannot be corroborated', () => {
    expect(
      readManagedBridgeContext(managed('https://comfy.example.com'), ''),
    ).toBeNull();
  });

  it('falls back to the embedder when no origin is declared', () => {
    const context = readManagedBridgeContext(
      managed(),
      'https://comfy.example.com/index.html',
    );
    expect(context?.parentOrigin).toBe('https://comfy.example.com');
  });

  it('rejects when neither a declaration nor an embedder is available', () => {
    expect(readManagedBridgeContext(managed(), '')).toBeNull();
  });
});

describe('sidebar mount lifecycle', () => {
  function container() {
    const children: unknown[] = [];
    return {
      children,
      appendChild(element: unknown) {
        children.push(element);
        (element as { parentElement?: unknown }).parentElement = this;
      },
    };
  }

  it('re-attaches after the sidebar tab is unmounted', () => {
    const { windowRef, documentRef } = fakeParentWindow();
    const bridge = createVideoOpsBridge({
      app: { graphToPrompt: async () => ({}), loadGraphData: () => {} },
      windowRef,
      documentRef,
    });
    expect(bridge.enabled).toBe(true);

    const first = container();
    expect(bridge.attach(first)).toBe(true);
    expect(first.children).toHaveLength(1);

    // ComfyUI destroys the custom sidebar tab on every tab switch. That must
    // unmount the panel, not end the session: tearing the bridge down here left
    // attach() returning false forever, blanking the panel and killing Managed
    // Run until a full page reload.
    expect(bridge.detach?.()).toBe(true);

    const second = container();
    expect(bridge.attach(second)).toBe(true);
    expect(second.children).toHaveLength(1);
  });

  it('stops attaching only once the session is genuinely destroyed', () => {
    const { windowRef, documentRef } = fakeParentWindow();
    const bridge = createVideoOpsBridge({
      app: { graphToPrompt: async () => ({}), loadGraphData: () => {} },
      windowRef,
      documentRef,
    });
    expect(bridge.attach(container())).toBe(true);
    bridge.destroy();
    expect(bridge.attach(container())).toBe(false);
    expect(bridge.detach?.()).toBe(false);
  });

  it('exposes a no-op detach on a disabled bridge', () => {
    const disabled = createVideoOpsBridge({
      app: {},
      windowRef: {
        location: { href: 'http://comfy.example.test/' },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      documentRef: {
        body: {},
        querySelector: () => null,
        createElement: () => ({}),
      },
    });
    expect(disabled.enabled).toBe(false);
    expect(() => disabled.detach?.()).not.toThrow();
  });
});
