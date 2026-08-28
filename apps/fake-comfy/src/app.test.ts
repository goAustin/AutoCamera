import { afterEach, describe, expect, it } from 'vitest';
import { getFakeComfyConfig } from '@h3/config';
import {
  DeterministicFakeComfyService,
  HttpWsComfyClient,
} from '@h3/comfy-client';
import { buildFakeComfyApp } from './app.js';

describe('fake ComfyUI shell', () => {
  let app: ReturnType<typeof buildFakeComfyApp> | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('returns stable health and object information responses', async () => {
    app = buildFakeComfyApp({
      config: getFakeComfyConfig({ NODE_ENV: 'test' }),
    });

    const health = await app.inject({ method: 'GET', url: '/health' });
    const objectInfo = await app.inject({ method: 'GET', url: '/object_info' });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ service: 'fake-comfy', status: 'ok' });
    expect(objectInfo.statusCode).toBe(200);
    expect(objectInfo.json()).toEqual({
      nodes: {
        CLIPTextEncode: {},
        EmptyHunyuanLatentVideo: {},
        KSampler: {},
        SaveVideo: {},
      },
    });
  });

  it('serves the official-shaped prompt, history, output, and interruption surface', async () => {
    const service = new DeterministicFakeComfyService();
    app = buildFakeComfyApp({
      config: getFakeComfyConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
      service,
    });
    const submitted = await app.inject({
      method: 'POST',
      url: '/prompt',
      headers: { 'content-type': 'application/json' },
      payload: {
        prompt: {},
        extra_data: {
          correlation_id: 'fake-app-test',
          seed: 5,
          scenario: 'success',
        },
      },
    });
    expect(submitted.statusCode).toBe(200);
    const promptId = submitted.json().prompt_id as string;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const history = await app.inject({
      method: 'GET',
      url: `/history/${promptId}`,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()[promptId].extra_data.correlation_id).toBe(
      'fake-app-test',
    );
    const output = await app.inject({
      method: 'GET',
      url: `/view?filename=${promptId}.mp4&subfolder=&type=output`,
    });
    expect(output.statusCode).toBe(200);
    expect(output.headers['content-type']).toContain('video/mp4');

    const timeout = await app.inject({
      method: 'POST',
      url: '/prompt',
      headers: { 'content-type': 'application/json' },
      payload: {
        prompt: {},
        extra_data: { correlation_id: 'interrupt-me', scenario: 'timeout' },
      },
    });
    const timeoutPromptId = timeout.json().prompt_id as string;
    const interrupted = await app.inject({
      method: 'POST',
      url: '/interrupt',
      headers: { 'content-type': 'application/json' },
      payload: { prompt_id: timeoutPromptId },
    });
    expect(interrupted.statusCode).toBe(200);
    expect(
      (
        await app.inject({ method: 'GET', url: `/history/${timeoutPromptId}` })
      ).json()[timeoutPromptId].status.status_str,
    ).toBe('interrupted');
  });

  it('lets the HTTP/WebSocket client use the fake app without a live server', async () => {
    const service = new DeterministicFakeComfyService();
    app = buildFakeComfyApp({
      config: getFakeComfyConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
      service,
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input.toString());
      const response = await app?.inject({
        method: init?.method ?? 'GET',
        url: `${url.pathname}${url.search}`,
        ...(init?.body
          ? { headers: { 'content-type': 'application/json' } }
          : {}),
        ...(init?.body ? { payload: init.body.toString() } : {}),
      });
      if (!response) throw new Error('Fake app was not available.');
      return new Response(response.rawPayload, {
        status: response.statusCode,
        headers: {
          'content-type': String(
            response.headers['content-type'] ?? 'application/json',
          ),
        },
      });
    };
    class InProcessWebSocket {
      onopen: (() => void) | null = null;
      onmessage: ((event: { readonly data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(_url: string) {
        setTimeout(() => {
          this.onopen?.();
          for (const event of service.eventsSnapshot()) {
            this.onmessage?.({ data: JSON.stringify(event.message) });
          }
        }, 0);
      }
      close(): void {
        this.onclose?.();
      }
      send(_data: string): void {}
    }
    const client = new HttpWsComfyClient({
      baseUrl: 'http://fake-comfy.test',
      wsUrl: 'ws://fake-comfy.test/ws',
      clientId: 'fake-app-client',
      fetchImpl,
      webSocket: InProcessWebSocket,
    });
    const submitted = await client.submitPrompt({
      workflow: {},
      extraData: { correlation_id: 'http-client-test', seed: 6 },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const history = await client.getHistory(submitted.promptId);
    expect(history?.status).toBe('success');
    expect(
      (await client.findHistoryByCorrelation('http-client-test'))?.promptId,
    ).toBe(submitted.promptId);
    expect(
      (
        await client.downloadOutput(
          history?.outputs[0] as NonNullable<typeof history>['outputs'][number],
        )
      ).byteLength,
    ).toBeGreaterThan(0);
    const messages: string[] = [];
    for await (const message of client.events({
      promptId: submitted.promptId,
    })) {
      messages.push(message.type);
    }
    expect(messages).toContain('execution_success');
  });
});
