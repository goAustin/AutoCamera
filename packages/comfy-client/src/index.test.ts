import { describe, expect, it } from 'vitest';
import {
  ComfyClientError,
  ComfyPromptRejectedError,
  type ComfyScenario,
  ComfyStreamDisconnectedError,
  ComfySubmissionUncertainError,
  type ComfyWebSocketLike,
  computeComfyCapabilityFingerprint,
  DeterministicFakeComfyService,
  FakeComfyClient,
  HttpWsComfyClient,
} from './index.js';

const waitForTimers = async (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5));

describe('Comfy client contract', () => {
  // The default service now answers with the pinned capture rather than a
  // hand-written stand-in, so this fingerprint must equal the one
  // `apps/fake-comfy` serves. Both packages pin the literal deliberately: when
  // the ComfyUI pin moves and the fixture is re-captured, both should be
  // updated as one visible decision, not drift apart the way the two fixtures
  // it replaced did.
  it('serves the pinned object-info contract, matching apps/fake-comfy', () => {
    expect(
      new DeterministicFakeComfyService().capabilities.capabilityFingerprint,
    ).toBe('4da7d9759f98506d8f8ac52e802e17fabe7917e8a058df1c3c325bde8390d90e');
  });

  // The specific input whose absence from the old stand-in let a graph the real
  // executor rejects validate clean offline.
  it('carries the required inputs the replaced stand-in omitted', () => {
    const unetLoader = new DeterministicFakeComfyService().getObjectInfo()
      .UNETLoader as
      | { readonly input?: { readonly required?: Record<string, unknown> } }
      | undefined;
    expect(Object.keys(unetLoader?.input?.required ?? {})).toContain(
      'weight_dtype',
    );
  });

  it.each([
    'success',
    'duplicate-events',
    'disconnect-reconcile',
    'execution-failure',
    'timeout',
    'uncertain-submission',
  ] as ComfyScenario[])('supports the %s fake scenario', async (scenario) => {
    const service = new DeterministicFakeComfyService();
    const client = new FakeComfyClient(service);
    const correlationId = `contract-${scenario}`;
    let promptId: string | undefined;
    if (scenario === 'uncertain-submission') {
      await expect(
        client.submitPrompt({
          workflow: { '1': { class_type: 'CLIPTextEncode' } },
          extraData: { correlation_id: correlationId, scenario, seed: 7 },
          scenario,
          seed: 7,
        }),
      ).rejects.toBeInstanceOf(ComfySubmissionUncertainError);
      const recovered = await client.findHistoryByCorrelation(correlationId);
      promptId = recovered?.promptId;
      expect(promptId).toBeDefined();
    } else {
      promptId = (
        await client.submitPrompt({
          workflow: { '1': { class_type: 'CLIPTextEncode' } },
          extraData: { correlation_id: correlationId, scenario, seed: 7 },
          scenario,
          seed: 7,
        })
      ).promptId;
    }
    await waitForTimers();
    const history = await client.getHistory(promptId as string);
    expect(history?.extraData.correlation_id).toBe(correlationId);
    if (scenario === 'timeout') {
      expect(history?.status).toBe('running');
      await client.cancelPrompt(promptId);
      expect((await client.getHistory(promptId as string))?.status).toBe(
        'interrupted',
      );
    } else if (scenario === 'execution-failure') {
      expect(history?.status).toBe('error');
    } else {
      expect(history?.status).toBe('success');
      expect(history?.outputs).toHaveLength(1);
    }
    expect(service.submissionCount(correlationId)).toBe(1);
  });

  it('replays terminal events and validates workflow classes', async () => {
    const service = new DeterministicFakeComfyService();
    const client = new FakeComfyClient(service);
    const valid = await client.validateWorkflow({
      '1': { class_type: 'CLIPTextEncode' },
      '2': { class_type: 'SaveVideo' },
    });
    const invalid = await client.validateWorkflow({
      '1': { class_type: 'MissingNode' },
    });
    expect(valid.valid).toBe(true);
    expect(invalid).toEqual({ valid: false, missingClasses: ['MissingNode'] });

    const { promptId } = await client.submitPrompt({
      workflow: {},
      extraData: { correlation_id: 'replay' },
      seed: 1,
    });
    await waitForTimers();
    const messages: string[] = [];
    for await (const message of client.events({ promptId })) {
      messages.push(message.type);
    }
    expect(messages).toContain('execution_success');
  });

  it('speaks official HTTP contracts and preserves authenticated metadata', async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> =
      [];
    const workflow = { '1': { class_type: 'SaveVideo' } };
    const objectInfo = { SaveVideo: {}, MiniMaxH3ImageToVideo: {} };
    const outputBytes = Uint8Array.from([1, 2, 3, 4]);
    const historyRecord = {
      prompt: [
        4,
        'remote-prompt',
        workflow,
        { correlation_id: 'remote-correlation', seed: 12 },
        [],
      ],
      outputs: {
        '4': {
          videos: [
            {
              filename: 'remote.mp4',
              subfolder: 'renders',
              type: 'output',
              format: 'video/h264-mp4',
            },
          ],
        },
      },
      status: { completed: true, status_str: 'success' },
    };
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input.toString();
      calls.push({ url, ...(init ? { init } : {}) });
      const parsed = new URL(url);
      if (parsed.pathname === '/system_stats') {
        return json({ system: { comfyui_version: '0.3.0' }, devices: [] });
      }
      if (parsed.pathname === '/object_info') return json(objectInfo);
      if (parsed.pathname === '/queue') {
        return json({
          queue_pending: [
            [1, 'pending-prompt', {}, {}, []],
            [2, 'pending-prompt', {}, {}, []],
          ],
          queue_running: [[3, 'running-prompt', {}, {}, []]],
        });
      }
      if (parsed.pathname === '/prompt' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          readonly prompt: unknown;
          readonly client_id: string;
          readonly extra_data: Readonly<Record<string, unknown>>;
        };
        expect(body.prompt).toEqual(workflow);
        expect(body.client_id).toBe('http-contract-client');
        expect(body.extra_data).toMatchObject({
          correlation_id: 'remote-correlation',
          seed: 12,
          scenario: 'success',
        });
        return json({ prompt_id: 'remote-prompt', number: 4, node_errors: {} });
      }
      if (parsed.pathname === '/history/remote-prompt') {
        return json({ 'remote-prompt': historyRecord });
      }
      if (parsed.pathname === '/history')
        return json({ 'remote-prompt': historyRecord });
      if (parsed.pathname === '/interrupt') return json({});
      if (parsed.pathname === '/view') return new Response(outputBytes);
      throw new Error(`Unhandled contract path ${url}`);
    };
    const client = new HttpWsComfyClient({
      baseUrl: 'https://comfy.example.test/',
      wsUrl: 'wss://comfy.example.test/ws',
      clientId: 'http-contract-client',
      authToken: 'secret-http-token',
      historyLimit: 7,
      fetchImpl,
    });

    const readiness = await client.checkReady();
    expect(readiness).toMatchObject({
      ready: true,
      apiVersion: '0.3.0',
      capabilityFingerprint: computeComfyCapabilityFingerprint(objectInfo),
    });
    expect(await client.getCapabilities()).toMatchObject({
      apiVersion: '0.3.0',
      supportsWebSocket: true,
      supportsCancellation: true,
      preservesExtraData: true,
      capabilityFingerprint: readiness.capabilityFingerprint,
    });
    expect(
      await client.validateWorkflow({
        '1': { class_type: 'SaveVideo' },
        '2': { class_type: 'MissingNode' },
      }),
    ).toEqual({ valid: false, missingClasses: ['MissingNode'] });
    expect(await client.getQueue()).toEqual({
      queuePending: ['pending-prompt'],
      queueRunning: ['running-prompt'],
    });

    const submitted = await client.submitPrompt({
      workflow,
      extraData: { correlation_id: 'remote-correlation', seed: 12 },
      scenario: 'success',
      seed: 12,
    });
    expect(submitted).toEqual({
      promptId: 'remote-prompt',
      queueNumber: 4,
      nodeErrors: {},
    });
    const history = await client.getHistory('remote-prompt');
    expect(history).toMatchObject({
      promptId: 'remote-prompt',
      status: 'success',
      completed: true,
      extraData: { correlation_id: 'remote-correlation', seed: 12 },
      workflow,
      outputs: [
        {
          filename: 'remote.mp4',
          subfolder: 'renders',
          type: 'output',
          mimeType: 'video/mp4',
          format: 'video/h264-mp4',
        },
      ],
    });
    expect(
      (await client.findHistoryByCorrelation('remote-correlation'))?.promptId,
    ).toBe('remote-prompt');
    await client.cancelPrompt('remote-prompt');
    expect(
      (
        await client.downloadOutput(
          history?.outputs[0] as NonNullable<typeof history>['outputs'][number],
        )
      ).byteLength,
    ).toBe(outputBytes.byteLength);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get('authorization')).toBe(
        'Bearer secret-http-token',
      );
      expect(call.url).not.toContain('secret-http-token');
    }
    const promptCall = calls.find(
      (call) => new URL(call.url).pathname === '/prompt',
    );
    expect(promptCall).toBeDefined();
  });

  it('classifies rejection, uncertain submission, deadlines, and unsafe output safely', async () => {
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const rejected = new HttpWsComfyClient({
      baseUrl: 'http://comfy.test',
      wsUrl: 'ws://comfy.test/ws',
      clientId: 'error-client',
      authToken: 'secret-error-token',
      fetchImpl: async () =>
        json({ error: 'invalid prompt', node_errors: {} }, 400),
    });
    await expect(
      rejected.submitPrompt({
        workflow: {},
        extraData: { correlation_id: 'rejected' },
      }),
    ).rejects.toBeInstanceOf(ComfyPromptRejectedError);

    const uncertain = new HttpWsComfyClient({
      baseUrl: 'http://comfy.test',
      wsUrl: 'ws://comfy.test/ws',
      clientId: 'uncertain-client',
      fetchImpl: async () => json({ error: 'overloaded' }, 503),
    });
    await expect(
      uncertain.submitPrompt({
        workflow: {},
        extraData: { correlation_id: 'uncertain' },
      }),
    ).rejects.toMatchObject({ code: 'COMFY_SUBMISSION_UNCERTAIN' });

    const timedOut = new HttpWsComfyClient({
      baseUrl: 'http://comfy.test',
      wsUrl: 'ws://comfy.test/ws',
      clientId: 'timeout-client',
      requestTimeoutMs: 100,
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });
    await expect(
      timedOut.submitPrompt({
        workflow: {},
        extraData: { correlation_id: 'timeout' },
      }),
    ).rejects.toMatchObject({ code: 'COMFY_SUBMISSION_UNCERTAIN' });
    expect(
      String(
        await timedOut
          .checkReady()
          .then((value) => value.errorCode ?? '')
          .catch(() => ''),
      ),
    ).not.toContain('secret');

    const oversized = new HttpWsComfyClient({
      baseUrl: 'http://comfy.test',
      wsUrl: 'ws://comfy.test/ws',
      clientId: 'output-client',
      maxOutputBytes: 2,
      fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3])),
    });
    await expect(
      oversized.downloadOutput({
        filename: 'output.mp4',
        subfolder: '',
        type: 'output',
        mimeType: 'video/mp4',
      }),
    ).rejects.toMatchObject({ code: 'COMFY_OUTPUT_TOO_LARGE' });
    await expect(
      oversized.downloadOutput({
        filename: '../secret.mp4',
        subfolder: '',
        type: 'output',
        mimeType: 'video/mp4',
      }),
    ).rejects.toMatchObject({ code: 'COMFY_OUTPUT_INVALID' });
    expect(new ComfyClientError('COMFY_HTTP_ERROR', 'safe').retryable).toBe(
      false,
    );
  });

  it('authenticates the WebSocket gateway without putting tokens in the URL', async () => {
    let observedUrl = '';
    let observedHeaders: Readonly<Record<string, string>> = {};
    class ContractWebSocket implements ComfyWebSocketLike {
      onopen: (() => void) | null = null;
      onmessage: ((event: { readonly data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(url: string) {
        observedUrl = url;
        setTimeout(() => {
          this.onopen?.();
          this.onmessage?.({
            data: JSON.stringify({
              type: 'status',
              data: { status: { exec_info: { queue_remaining: 0 } } },
            }),
          });
          this.onmessage?.({
            data: JSON.stringify({
              type: 'progress',
              data: { prompt_id: 'ws-prompt', value: 1, max: 1 },
            }),
          });
          this.onmessage?.({
            data: JSON.stringify({
              type: 'execution_success',
              data: { prompt_id: 'ws-prompt' },
            }),
          });
        }, 0);
      }

      close(): void {
        this.onclose?.();
      }

      send(_data: string): void {}
    }
    const client = new HttpWsComfyClient({
      baseUrl: 'http://comfy.test',
      wsUrl: 'ws://comfy.test/ws',
      clientId: 'ws-contract-client',
      authToken: 'secret-ws-token',
      webSocketFactory: (url, options) => {
        observedHeaders = options.headers;
        return new ContractWebSocket(url);
      },
    });
    const messages: string[] = [];
    for await (const message of client.events({ promptId: 'ws-prompt' })) {
      messages.push(message.type);
    }
    expect(messages).toEqual(['progress', 'execution_success']);
    expect(observedUrl).toContain('clientId=ws-contract-client');
    expect(observedUrl).not.toContain('secret-ws-token');
    expect(observedHeaders).toEqual({
      authorization: 'Bearer secret-ws-token',
    });
  });

  it('reports an unexpected WebSocket disconnect as recoverable', async () => {
    class DisconnectingWebSocket implements ComfyWebSocketLike {
      onopen: (() => void) | null = null;
      onmessage: ((event: { readonly data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;

      constructor() {
        setTimeout(() => {
          this.onopen?.();
          this.onclose?.();
        }, 0);
      }

      close(): void {}

      send(_data: string): void {}
    }
    const client = new HttpWsComfyClient({
      baseUrl: 'http://comfy.test',
      wsUrl: 'ws://comfy.test/ws',
      clientId: 'disconnect-client',
      webSocket: DisconnectingWebSocket,
    });
    const iterator = client.events()[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBeInstanceOf(
      ComfyStreamDisconnectedError,
    );
  });
});
