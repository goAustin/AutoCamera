import {
  BridgeMessageGuard,
  BridgeProtocolError,
  createBridgeMessage,
  isJsonObject,
  makeRequestId,
  readManagedBridgeContext,
} from './bridge-contract.js';

function getErrorCode(error, fallback = 'BRIDGE_ERROR') {
  return error instanceof BridgeProtocolError && typeof error.code === 'string'
    ? error.code
    : fallback;
}

function createDisabledBridge(reason) {
  return Object.freeze({
    enabled: false,
    reason,
    exportCurrentWorkflow: () => false,
    destroy: () => {},
  });
}

export function createVideoOpsBridge(options = {}) {
  const windowRef = options.windowRef ?? globalThis.window;
  if (!windowRef || windowRef.parent === windowRef) {
    return createDisabledBridge('NOT_EMBEDDED');
  }

  const documentRef = options.documentRef ?? globalThis.document;
  const locationLike = windowRef.location;
  const referrer = documentRef?.referrer ?? '';
  const context = readManagedBridgeContext(locationLike, referrer);
  if (!context) return createDisabledBridge('MANAGED_CONTEXT_MISSING');

  const parentWindow = windowRef.parent;
  const guard = new BridgeMessageGuard({
    allowedOrigin: context.parentOrigin,
    expectedSource: parentWindow,
    expectedNonce: context.nonce,
    direction: 'parent',
  });
  const sent = new Set();
  let active = true;
  let contextReceived = false;
  let currentContext;

  const notifyError = (code) => {
    options.onProtocolError?.(code);
  };

  const post = (type, fields, requestId) => {
    if (!active) return false;
    const message = createBridgeMessage(type, fields, {
      nonce: context.nonce,
      requestId,
      direction: 'child',
    });
    const key = `${message.type}:${message.requestId}`;
    if (sent.has(key)) {
      notifyError('DUPLICATE_MESSAGE');
      return false;
    }
    sent.add(key);
    parentWindow.postMessage(message, context.parentOrigin);
    return true;
  };

  const reportError = (code) => {
    notifyError(code);
    try {
      post('bridge.error', { code }, makeRequestId('error'));
    } catch {
      // A protocol error must never expose the underlying exception or graph.
    }
  };

  const exportCurrentWorkflow = () => {
    if (!contextReceived) {
      reportError('CONTEXT_REQUIRED');
      return false;
    }

    let prompt;
    try {
      if (typeof options.app?.graphToPrompt !== 'function') {
        reportError('GRAPH_EXPORT_UNAVAILABLE');
        return false;
      }
      prompt = options.app.graphToPrompt();
    } catch {
      reportError('GRAPH_EXPORT_FAILED');
      return false;
    }

    const editorGraph = prompt?.workflow;
    const apiGraph = prompt?.output;
    if (!isJsonObject(editorGraph) || !isJsonObject(apiGraph)) {
      reportError('GRAPH_EXPORT_INVALID');
      return false;
    }

    try {
      return post(
        'workflow.exported',
        {
          editorGraph,
          apiGraph,
          frontendVersion: context.frontendVersion,
        },
        makeRequestId('export'),
      );
    } catch (error) {
      reportError(getErrorCode(error, 'GRAPH_EXPORT_INVALID'));
      return false;
    }
  };

  const handleContext = (message) => {
    if (
      context.projectId !== undefined &&
      context.projectId !== message.projectId
    ) {
      notifyError('CONTEXT_MISMATCH');
      return;
    }
    if (context.shotId !== undefined && context.shotId !== message.shotId) {
      notifyError('CONTEXT_MISMATCH');
      return;
    }
    currentContext = {
      projectId: message.projectId,
      shotId: message.shotId,
    };
    contextReceived = true;
    options.onContext?.(currentContext);
  };

  const handleMessage = (event) => {
    if (!active) return;
    let message;
    try {
      message = guard.accept(event);
    } catch (error) {
      notifyError(getErrorCode(error, 'MESSAGE_INVALID'));
      return;
    }

    switch (message.type) {
      case 'studio.context':
        handleContext(message);
        return;
      case 'workflow.load':
        if (
          !contextReceived ||
          typeof options.app?.loadGraphData !== 'function'
        ) {
          notifyError('CONTEXT_REQUIRED');
          return;
        }
        try {
          options.app.loadGraphData(message.editorGraph);
        } catch {
          notifyError('GRAPH_LOAD_FAILED');
        }
        return;
      case 'workflow.result':
        options.onResult?.({
          status: message.status,
          ...(message.code ? { code: message.code } : {}),
          ...(message.message ? { message: message.message } : {}),
          ...(message.revisionId ? { revisionId: message.revisionId } : {}),
          ...(message.attemptId ? { attemptId: message.attemptId } : {}),
        });
        return;
      default:
        notifyError('MESSAGE_DIRECTION_INVALID');
    }
  };

  windowRef.addEventListener('message', handleMessage);
  try {
    post(
      'bridge.ready',
      { frontendVersion: context.frontendVersion },
      context.nonce,
    );
  } catch (error) {
    notifyError(getErrorCode(error, 'READY_FAILED'));
  }

  return {
    enabled: true,
    context,
    getCurrentContext: () => currentContext,
    exportCurrentWorkflow,
    destroy: () => {
      if (!active) return;
      active = false;
      windowRef.removeEventListener('message', handleMessage);
    },
  };
}
