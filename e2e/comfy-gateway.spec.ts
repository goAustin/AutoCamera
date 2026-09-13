import { expect, test } from '@playwright/test';

// Phase 8 gate row 2.11, item 5: browser POST /prompt, queue mutation and
// interrupt must be denied by the gateway.
//
// The browser suite already proves the frontend *disables* its Queue control
// (comfy-inversion.spec.ts). That is an affordance, not a control: it says the
// UI offers no way around the managed path, not that there isn't one. These
// assertions are the control — they go at the gateway, below the frontend,
// where a hand-crafted fetch from the console lands.
//
// The runbook has this checked once by hand in an authenticated browser on a
// rented host. Asserting it here instead costs no GPU and re-proves it on
// every commit.

const gatewayOrigin = process.env.E2E_GATEWAY_ORIGIN ?? 'http://127.0.0.1:8190';

// Everything ComfyUI exposes that queues, cancels, or frees work.
const executionControl = ['/comfy/prompt', '/comfy/interrupt', '/comfy/free'];

test.describe('ComfyUI browser gateway', () => {
  for (const path of executionControl) {
    test(`denies POST ${path}`, async ({ request }) => {
      const response = await request.post(`${gatewayOrigin}${path}`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(response.status()).toBe(405);
    });
  }

  test('allows reading the queue but not mutating it', async ({ request }) => {
    const read = await request.get(`${gatewayOrigin}/comfy/queue`, {
      failOnStatusCode: false,
    });
    expect(read.status()).toBe(200);
    expect(await read.json()).toHaveProperty('queue_pending');

    for (const method of ['post', 'delete'] as const) {
      const mutation = await request[method](`${gatewayOrigin}/comfy/queue`, {
        failOnStatusCode: false,
      });
      expect(mutation.status(), `${method.toUpperCase()} /comfy/queue`).toBe(
        405,
      );
    }
  });

  test('denies an unlisted mutation rather than proxying it', async ({
    request,
  }) => {
    // The broad method policy, not the explicit deny list: a ComfyUI endpoint
    // nobody enumerated here must still be unreachable by a mutating method.
    const response = await request.post(`${gatewayOrigin}/comfy/upload/image`, {
      data: {},
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(405);
  });

  test('serves the read surface with an exact frame-ancestors origin', async ({
    request,
  }) => {
    const response = await request.get(`${gatewayOrigin}/comfy/system_stats`, {
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(200);

    const csp = response.headers()['content-security-policy'] ?? '';
    expect(csp).toContain('frame-ancestors');
    // "*" would let any page frame the editor; section 5 forbids it.
    expect(csp).not.toContain('*');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('never leaks an upstream credential to the browser', async ({
    request,
  }) => {
    const response = await request.get(`${gatewayOrigin}/comfy/system_stats`, {
      failOnStatusCode: false,
    });
    const headers = JSON.stringify(response.headers()).toLowerCase();
    expect(headers).not.toContain('authorization');
    expect(headers).not.toContain('bearer');
  });
});
