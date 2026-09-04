import {
  BridgeMessageGuard,
  BridgeProtocolError,
  createBridgeMessage,
  isJsonObject,
  makeRequestId,
} from './bridge-contract.js';

export const PINNED_FRONTEND_REF = '3697a1bc3ba7f6b98a1ead888721f7676b536eb5';

function errorCode(error, fallback = 'BRIDGE_ERROR') {
  return error instanceof BridgeProtocolError && typeof error.code === 'string'
    ? error.code
    : fallback;
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function metaContent(documentRef, name) {
  const meta = documentRef?.querySelector?.(`meta[name="${name}"]`);
  return typeof meta?.getAttribute === 'function'
    ? (meta.getAttribute('content') ?? undefined)
    : undefined;
}

function resolveStudioUrl(windowRef, documentRef, options) {
  const query = (() => {
    try {
      return new URL(windowRef.location.href).searchParams;
    } catch {
      return undefined;
    }
  })();
  const configured =
    options.studioUrl ??
    windowRef.__VIDEOOPS_STUDIO_URL__ ??
    query?.get('videoopsStudioUrl') ??
    undefined;
  const configuredUrl = safeUrl(configured);
  if (configuredUrl) return configuredUrl;

  const origin =
    options.studioOrigin ??
    windowRef.__VIDEOOPS_STUDIO_ORIGIN__ ??
    metaContent(documentRef, 'videoops-studio-origin') ??
    query?.get('videoopsStudioOrigin') ??
    undefined;
  const originUrl = safeUrl(origin);
  if (!originUrl) return undefined;
  return new URL(options.panelPath ?? '/panel', originUrl.origin);
}

function createPanelUrl(windowRef, documentRef, options, nonce) {
  const url = resolveStudioUrl(windowRef, documentRef, options);
  if (!url) return undefined;
  let parentOrigin;
  try {
    parentOrigin = new URL(windowRef.location.href).origin;
  } catch {
    return undefined;
  }
  url.searchParams.set('videoopsManaged', '1');
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('parentOrigin', parentOrigin);
  url.searchParams.set(
    'frontendVersion',
    options.frontendVersion ?? PINNED_FRONTEND_REF,
  );
  return { url, studioOrigin: url.origin, parentOrigin };
}

function createDisabledBridge(reason) {
  return Object.freeze({
    enabled: false,
    reason,
    getState: () => ({ connected: false }),
    subscribe: () => () => {},
    attach: () => false,
    detach: () => {},
    exportCurrentWorkflow: async () => false,
    destroy: () => {},
  });
}

function notify(listeners, state) {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch {
      // A panel observer must not be able to break the bridge.
    }
  }
}

function jsonSafeObject(value) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') return undefined;
    const clone = JSON.parse(serialized);
    return isJsonObject(clone) ? clone : undefined;
  } catch {
    return undefined;
  }
}

export function createVideoOpsBridge(options = {}) {
  const windowRef = options.windowRef ?? globalThis.window;
  const documentRef = options.documentRef ?? globalThis.document;
  if (!windowRef || !documentRef)
    return createDisabledBridge('DOM_UNAVAILABLE');

  const nonce = options.nonce ?? makeRequestId('panel');
  const resolved = createPanelUrl(windowRef, documentRef, options, nonce);
  if (!resolved) return createDisabledBridge('STUDIO_ORIGIN_MISSING');

  const iframe =
    options.iframe ??
    (() => {
      const element = documentRef.createElement('iframe');
      element.className = 'videoops-panel-frame';
      element.title = 'VideoOps managed run panel';
      element.setAttribute('aria-label', 'VideoOps managed run panel');
      element.setAttribute('data-videoops-iframe', 'true');
      element.style.width = '100%';
      element.style.height = '100vh';
      element.style.minHeight = '100vh';
      element.style.display = 'block';
      element.style.border = '0';
      element.hidden = true;
      return element;
    })();
  const body = documentRef.body;
  if (!options.iframe && body) body.appendChild(iframe);
  const frameWindow = iframe.contentWindow;
  if (!frameWindow) return createDisabledBridge('IFRAME_WINDOW_MISSING');

  const listeners = new Set();
  const guard = new BridgeMessageGuard({
    allowedOrigin: resolved.studioOrigin,
    expectedSource: frameWindow,
    expectedNonce: nonce,
    direction: 'child',
  });
  const sent = new Set();
  let active = true;
  let connected = false;
  let latestStatus;
  let errorCodeValue;
  let eventCount = 0;
  const state = () => ({
    connected,
    latestStatus,
    errorCode: errorCodeValue,
    eventCount,
    frontendVersion: options.frontendVersion ?? PINNED_FRONTEND_REF,
    studioOrigin: resolved.studioOrigin,
    iframe,
  });
  const emit = () => notify(listeners, state());
  const onProtocolError = options.onProtocolError ?? (() => {});
  const reportError = (code) => {
    errorCodeValue = code;
    onProtocolError(code);
    emit();
    try {
      postToPanel('bridge.error', { code }, makeRequestId('error'));
    } catch {
      // Never send exception text or credentials across the boundary.
    }
  };
  const postToPanel = (type, fields, requestId) => {
    if (!active) return false;
    const currentFrameWindow = iframe.contentWindow;
    if (!currentFrameWindow) return false;
    const message = createBridgeMessage(type, fields, {
      nonce,
      requestId,
      direction: 'parent',
    });
    const key = `${message.type}:${message.requestId}`;
    if (sent.has(key)) {
      onProtocolError('DUPLICATE_MESSAGE');
      return false;
    }
    sent.add(key);
    currentFrameWindow.postMessage(message, resolved.studioOrigin);
    return true;
  };
  const sendContext = () => {
    if (!connected) return false;
    return postToPanel(
      'comfy.context',
      {
        frontendVersion: options.frontendVersion ?? PINNED_FRONTEND_REF,
      },
      makeRequestId('context'),
    );
  };
  const handleMessage = (event) => {
    if (!active) return;
    const currentFrameWindow = iframe.contentWindow;
    if (!currentFrameWindow || event.source !== currentFrameWindow) {
      onProtocolError('SOURCE_MISMATCH');
      return;
    }
    guard.options.expectedSource = currentFrameWindow;
    let message;
    try {
      message = guard.accept(event);
    } catch (error) {
      onProtocolError(errorCode(error, 'MESSAGE_INVALID'));
      return;
    }

    if (message.type === 'panel.ready') {
      connected = true;
      errorCodeValue = undefined;
      eventCount += 1;
      emit();
      sendContext();
      return;
    }
    if (message.type === 'workflow.load') {
      if (typeof options.app?.loadGraphData !== 'function') {
        reportError('GRAPH_LOAD_UNAVAILABLE');
        return;
      }
      Promise.resolve()
        .then(() => options.app.loadGraphData(message.editorGraph))
        .catch(() => reportError('GRAPH_LOAD_FAILED'));
      return;
    }
    if (message.type === 'run.status') {
      latestStatus = message;
      eventCount += 1;
      emit();
    }
  };
  const handleLoad = () => {
    guard.reset();
    connected = false;
    latestStatus = undefined;
    errorCodeValue = undefined;
    emit();
  };

  windowRef.addEventListener('message', handleMessage);
  iframe.addEventListener?.('load', handleLoad);
  if (!options.iframe) iframe.src = resolved.url.toString();
  const attach = (container) => {
    if (!active || !container || typeof container.appendChild !== 'function')
      return false;
    container.appendChild(iframe);
    iframe.hidden = false;
    return true;
  };

  /**
   * Unmount the panel from its container while keeping the bridge session
   * alive. The sidebar tab is destroyed whenever the user switches tabs, which
   * must not end the bridge: the window message listener, nonce and queue gate
   * outlive any one mount. Re-inserting an iframe reloads its document, so the
   * panel re-runs its handshake and `panel.ready` restores `connected`.
   */
  const detach = () => {
    if (!active) return false;
    iframe.hidden = true;
    iframe.remove?.();
    return true;
  };

  const exportCurrentWorkflow = async () => {
    if (!connected) {
      reportError('PANEL_NOT_READY');
      return false;
    }
    if (typeof options.app?.graphToPrompt !== 'function') {
      reportError('GRAPH_EXPORT_UNAVAILABLE');
      return false;
    }
    let prompt;
    try {
      // graphToPrompt is public in the pinned frontend and is asynchronous.
      prompt = await options.app.graphToPrompt();
    } catch {
      reportError('GRAPH_EXPORT_FAILED');
      return false;
    }
    // The public exporter can include undefined optional widget fields. JSON
    // normalization preserves the wire format used by the frontend while
    // keeping the bridge strictly JSON-only.
    const editorGraph = jsonSafeObject(prompt?.workflow);
    const apiGraph = jsonSafeObject(prompt?.output);
    if (!editorGraph || !apiGraph) {
      reportError('GRAPH_EXPORT_INVALID');
      return false;
    }
    try {
      eventCount += 1;
      const result = postToPanel(
        'workflow.exported',
        { editorGraph, apiGraph },
        makeRequestId('export'),
      );
      emit();
      return result;
    } catch (error) {
      reportError(errorCode(error, 'GRAPH_EXPORT_INVALID'));
      return false;
    }
  };

  return {
    enabled: true,
    nonce,
    studioOrigin: resolved.studioOrigin,
    iframe,
    getState: state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state());
      return () => listeners.delete(listener);
    },
    attach,
    detach,
    exportCurrentWorkflow,
    destroy: () => {
      if (!active) return;
      active = false;
      windowRef.removeEventListener('message', handleMessage);
      iframe.removeEventListener?.('load', handleLoad);
      iframe.remove?.();
      listeners.clear();
    },
  };
}
