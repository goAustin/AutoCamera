import { EventEmitter } from 'node:events';
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

  it('returns stable health, readiness, and H3 object information', async () => {
    app = buildFakeComfyApp({
      config: getFakeComfyConfig({ NODE_ENV: 'test' }),
    });

    const health = await app.inject({ method: 'GET', url: '/health' });
    const systemStats = await app.inject({
      method: 'GET',
      url: '/system_stats',
    });
    const objectInfo = await app.inject({ method: 'GET', url: '/object_info' });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ service: 'fake-comfy', status: 'ok' });
    expect(systemStats.statusCode).toBe(200);
    expect(systemStats.json().system.comfyui_version).toBe('0.0.1-fake');
    expect(objectInfo.statusCode).toBe(200);
    expect(objectInfo.json()).not.toHaveProperty('nodes');
    expect(Object.keys(objectInfo.json())).toEqual(
      expect.arrayContaining([
        'UNETLoader',
        'CLIPLoader',
        'VAELoader',
        'MiniMaxH3ImageToVideo',
        'RandomNoise',
        'BasicScheduler',
        'KSamplerSelect',
        'BasicGuider',
        'SamplerCustomAdvanced',
        'VAEDecode',
        'VAEDecodeAudio',
        'CreateVideo',
        'SaveVideo',
      ]),
    );
  });

  it('keeps health public and protects the executor protocol with a bearer token', async () => {
    app = buildFakeComfyApp({
      config: getFakeComfyConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        COMFY_AUTH_TOKEN: 'fake-secret',
      }),
    });

    expect(
      (await app.inject({ method: 'GET', url: '/health' })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/object_info' })).statusCode,
    ).toBe(401);
    const authorized = await app.inject({
      method: 'GET',
      url: '/object_info',
      headers: { authorization: 'Bearer fake-secret' },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.body).not.toContain('fake-secret');
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
    const queue = await app.inject({ method: 'GET', url: '/queue' });
    expect(queue.statusCode).toBe(200);
    expect(queue.json()).toEqual(
      expect.objectContaining({
        queue_pending: expect.any(Array),
        queue_running: expect.any(Array),
      }),
    );
    const queueEntries = [
      ...queue.json().queue_pending,
      ...queue.json().queue_running,
    ];
    if (queueEntries.length > 0) {
      expect(queueEntries[0]).toEqual(
        expect.arrayContaining([expect.anything(), promptId]),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    const history = await app.inject({
      method: 'GET',
      url: `/history/${promptId}`,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()[promptId].extra_data.correlation_id).toBe(
      'fake-app-test',
    );
    expect(history.json()[promptId].prompt[1]).toBe(promptId);
    const invalid = await app.inject({
      method: 'POST',
      url: '/prompt',
      headers: { 'content-type': 'application/json' },
      payload: {
        prompt: { 'bad-node': { class_type: 'MissingH3Node', inputs: {} } },
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: expect.any(String),
      node_errors: { 'bad-node': expect.any(Object) },
    });
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
      const json = (value: unknown, status = 200): Response =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url.pathname === '/system_stats') {
        return json(service.getSystemStats());
      }
      if (url.pathname === '/object_info') {
        return json(service.getObjectInfo());
      }
      if (url.pathname === '/queue') {
        return json(service.queueProtocol());
      }
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
          const queue = service.queue();
          this.onmessage?.({
            data: JSON.stringify({
              type: 'status',
              data: {
                status: {
                  exec_info: {
                    queue_remaining:
                      queue.queuePending.length + queue.queueRunning.length,
                  },
                },
                sid: 'fake-app-client',
              },
            }),
          });
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
    const statusIterator = client.events()[Symbol.asyncIterator]();
    expect(await statusIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({ type: 'status' }),
    });
    await statusIterator.return?.();
    const readiness = await client.checkReady();
    expect(readiness.ready).toBe(true);
    expect(readiness.capabilityFingerprint).toBe(
      service.capabilities.capabilityFingerprint,
    );
    expect((await client.getCapabilities()).capabilityFingerprint).toBe(
      service.capabilities.capabilityFingerprint,
    );
    const submitted = await client.submitPrompt({
      workflow: {},
      extraData: { correlation_id: 'http-client-test', seed: 6 },
    });
    const normalizedQueue = await client.getQueue();
    expect(normalizedQueue.queuePending).toEqual(expect.any(Array));
    expect(normalizedQueue.queueRunning).toEqual(expect.any(Array));
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

  it('writes the official status frame during a fake WebSocket upgrade', () => {
    app = buildFakeComfyApp({
      config: getFakeComfyConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    });
    class FakeUpgradeSocket extends EventEmitter {
      readonly writes: Buffer[] = [];

      write(chunk: string | Uint8Array): boolean {
        this.writes.push(Buffer.from(chunk));
        return true;
      }

      end(chunk?: string): this {
        if (chunk) this.write(chunk);
        this.emit('close');
        return this;
      }

      destroy(): this {
        this.emit('close');
        return this;
      }
    }
    const socket = new FakeUpgradeSocket();
    app.server.emit(
      'upgrade',
      {
        url: '/ws?clientId=fake-wire-client',
        headers: {
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      },
      socket,
    );

    expect(socket.writes[0]?.toString()).toContain('101 Switching Protocols');
    const frame = Buffer.concat(socket.writes.slice(1));
    const secondByte = frame[1] ?? 0;
    const payloadLength =
      (secondByte & 0x7f) === 126 ? frame.readUInt16BE(2) : secondByte & 0x7f;
    const payloadOffset = (secondByte & 0x7f) === 126 ? 4 : 2;
    const status = JSON.parse(
      frame.subarray(payloadOffset, payloadOffset + payloadLength).toString(),
    ) as { readonly type: string; readonly data: Record<string, unknown> };
    expect(status).toEqual({
      type: 'status',
      data: expect.objectContaining({ sid: 'fake-wire-client' }),
    });
    socket.emit('close');
  });
});
