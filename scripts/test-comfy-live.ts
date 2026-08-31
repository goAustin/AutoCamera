function safeError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    const status = (error as { readonly status?: unknown }).status;
    if (typeof code === 'string') {
      return `${code}${typeof status === 'number' ? ` (HTTP ${status})` : ''}`;
    }
  }
  if (error instanceof Error) return error.message;
  return 'unexpected live-contract failure';
}

function skip(reason: string): void {
  console.log(`SKIP test:comfy-live: ${reason}`);
}

async function run(): Promise<void> {
  if (process.env.COMFY_LIVE_TEST !== '1') {
    skip('set COMFY_LIVE_TEST=1 to use the configured remote ComfyUI.');
    return;
  }

  if (process.env.COMFY_MODE !== 'remote') {
    skip('COMFY_MODE=remote and a pinned executor are not configured.');
    return;
  }

  if (
    !process.env.COMFY_BASE_URL ||
    !process.env.COMFY_WS_URL ||
    !process.env.COMFY_FRONTEND_URL
  ) {
    skip(
      'COMFY_BASE_URL, COMFY_WS_URL, and COMFY_FRONTEND_URL are required for the remote contract.',
    );
    return;
  }

  const { getApiConfig } = await import('../packages/config/src/index.ts');
  const { ComfyClientError, ComfyPromptRejectedError, HttpWsComfyClient } =
    await import('../packages/comfy-client/src/index.ts');
  let workflowCompiler: typeof import('../packages/workflow-compiler/dist/index.js');
  try {
    workflowCompiler = await import(
      '../packages/workflow-compiler/dist/index.js'
    );
  } catch {
    throw new Error('Run pnpm build before enabling the live contract test.');
  }

  const config = getApiConfig({ ...process.env, NODE_ENV: 'test' });
  if (config.comfyMode !== 'remote') {
    throw new Error(
      'COMFY_MODE=remote is required for the live contract test.',
    );
  }
  if (config.comfyAuthToken) {
    throw new Error(
      'The live WebSocket check requires a gateway identity or custom WebSocket factory; bearer tokens are never placed in the URL.',
    );
  }

  const NativeWebSocket = WebSocket as unknown as {
    new (
      url: string,
    ): {
      onopen: (() => void) | null;
      onmessage: ((event: { readonly data: unknown }) => void) | null;
      onerror: (() => void) | null;
      onclose: (() => void) | null;
      close(): void;
      send(data: string): void;
    };
  };
  const client = new HttpWsComfyClient({
    baseUrl: config.comfyBaseUrl,
    wsUrl: config.comfyWsUrl,
    clientId: `${config.comfyClientIdPrefix}-${config.gpuWorkerId}-live`,
    requestTimeoutMs: config.comfyRequestTimeoutMs,
    webSocket: NativeWebSocket,
  });
  const readiness = await client.checkReady();
  if (!readiness.ready) {
    if (
      readiness.errorCode === 'COMFY_NETWORK_ERROR' ||
      readiness.errorCode === 'COMFY_REQUEST_TIMEOUT' ||
      readiness.errorCode === 'COMFY_UNAVAILABLE'
    ) {
      skip(
        `the configured pinned executor is unavailable (${readiness.errorCode}).`,
      );
      return;
    }
    throw new ComfyClientError(
      readiness.errorCode ?? 'COMFY_UNAVAILABLE',
      'Configured remote ComfyUI is not ready.',
      { retryable: true },
    );
  }

  const objectInfo = await client.getObjectInfo();
  const fixtures = await workflowCompiler.loadMinimaxH3Fixtures();
  const compatibility = workflowCompiler.validateMinimaxH3T2vaPreview({
    editorGraph: fixtures.editorGraph,
    apiGraph: fixtures.apiGraph,
    objectInfo,
    requireExecutor: true,
  });
  if (!compatibility.valid) {
    throw new Error(
      `H3 capability validation failed: ${compatibility.errors.map((issue) => issue.code).join(',')}`,
    );
  }
  const capabilities = await client.getCapabilities();
  if (capabilities.capabilityFingerprint !== readiness.capabilityFingerprint) {
    throw new Error('ComfyUI capability fingerprint changed during the check.');
  }

  const invalidWorkflow = JSON.parse(
    JSON.stringify(fixtures.apiGraph),
  ) as Record<string, unknown>;
  invalidWorkflow.__h3_contract_invalid__ = {
    class_type: '__H3_CONTRACT_INVALID__',
    inputs: {},
  };
  let rejected = false;
  try {
    const accepted = await client.submitPrompt({
      workflow: invalidWorkflow,
      extraData: {
        correlation_id: `comfy-live-invalid-${Date.now()}`,
      },
    });
    await client.cancelPrompt(accepted.promptId);
  } catch (error) {
    if (!(error instanceof ComfyPromptRejectedError)) throw error;
    rejected = true;
  }
  if (!rejected) {
    throw new Error(
      'Remote ComfyUI accepted the intentionally invalid prompt.',
    );
  }

  const queue = await client.getQueue();
  if (
    !Array.isArray(queue.queuePending) ||
    !Array.isArray(queue.queueRunning)
  ) {
    throw new Error('Remote ComfyUI queue response was not normalized.');
  }

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 3_000);
  let sawStatus = false;
  try {
    for await (const message of client.events({ signal: controller.signal })) {
      if (message.type === 'status') {
        sawStatus = true;
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(abortTimer);
  }
  if (!sawStatus)
    throw new Error('Remote ComfyUI WebSocket sent no status event.');

  console.log(
    `PASS test:comfy-live: ready; H3 capabilities ${capabilities.capabilityFingerprint}; invalid prompt rejected; WebSocket status received.`,
  );
}

try {
  await run();
} catch (error) {
  console.error(`FAIL test:comfy-live: ${safeError(error)}`);
  process.exitCode = 1;
}
