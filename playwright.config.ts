import { defineConfig } from '@playwright/test';

const apiPort = Number(process.env.E2E_API_PORT ?? 3300);
const fakeComfyPort = Number(process.env.E2E_FAKE_COMFY_PORT ?? 38188);
const webPort = Number(process.env.E2E_WEB_PORT ?? 35173);
const gatewayPort = Number(process.env.E2E_GATEWAY_PORT ?? 38190);
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const fakeComfyOrigin = `http://127.0.0.1:${fakeComfyPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;

// `commonEnvironment` below reaches the webServer processes, not the test
// workers. This config module is evaluated in the runner and in each worker,
// so setting it here is what e2e/comfy-gateway.spec.ts actually reads.
process.env.E2E_GATEWAY_ORIGIN = gatewayOrigin;

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);

const commonEnvironment = {
  ...inheritedEnvironment,
  NODE_ENV: 'test',
  LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
  DATABASE_URL:
    process.env.DATABASE_URL ??
    'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops',
  DEV_AUTH_TOKEN: 'e2e-token',
  ARTIFACT_ROOT: `${process.cwd()}/.data/e2e-artifacts`,
  COMFY_MODE: 'fake',
  COMFY_BASE_URL: fakeComfyOrigin,
  COMFY_WS_URL: `ws://127.0.0.1:${fakeComfyPort}/ws`,
  COMFY_FRONTEND_URL: fakeComfyOrigin,
  COMFY_CLIENT_ID_PREFIX: 'h3-e2e',
  GPU_WORKER_ID: 'e2e-worker',
  // Overrides the 300s production default (packages/config/src/index.ts) so
  // e2e/run-view.spec.ts's `timeout` scenario resolves within this file's
  // 60s per-test budget (playwright.config.ts `timeout` below), without
  // relying on a shell-set variable the suite would otherwise silently pass
  // or fail depending on. `GenerationWorker` fires this as a plain
  // `setTimeout` (apps/api/src/generation.ts), so the wall-clock cost of a
  // real timeout is ~ATTEMPT_TIMEOUT_SECONDS, not a fraction of it: 20s
  // leaves the rest of that test's steps (three API-seeded shots, two full
  // "success"-scenario completions, and the UI navigation, retry, and
  // finding-apply interactions around them) comfortable room inside 60s.
  // Measured "success"-scenario completion (attempt creation to
  // `awaiting_review` with evaluation, this machine, 5 trials): 344-349ms,
  // so 20s is ~57x that -- ample margin against a slower or loaded CI host
  // before any happy-path attempt could plausibly graze this threshold.
  ATTEMPT_TIMEOUT_SECONDS: '20',
  H3_MEDIA_FIXTURE_PATH: `${process.cwd()}/.data/fixtures/h3-t2v-fixture.mp4`,
  PI_PROVIDER: 'faux',
  API_HOST: '127.0.0.1',
  API_PORT: String(apiPort),
  WEB_ORIGIN: webOrigin,
  VIDEOOPS_STUDIO_ORIGIN: webOrigin,
  // Not 127.0.0.1, and it matters. The gateway webServer above runs Caddy in a
  // container and proxies to this process through `host.docker.internal`. On
  // Docker Desktop that name reaches a loopback-bound host socket; on Linux --
  // every CI run -- `host-gateway` resolves to the bridge address, and a
  // loopback-bound socket refuses it. The whole browser suite then fails before
  // its first test, on the gateway health check's 120s timeout, while passing
  // on every developer machine. The API and web servers below stay on loopback
  // because nothing outside this host has to reach them; this one does.
  FAKE_COMFY_HOST: '0.0.0.0',
  FAKE_COMFY_PORT: String(fakeComfyPort),
  WEB_HOST: '127.0.0.1',
  WEB_PORT: String(webPort),
  VITE_API_ORIGIN: apiOrigin,
  E2E_GATEWAY_ORIGIN: gatewayOrigin,
};

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: 'line',
  use: {
    baseURL: webOrigin,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm exec tsx apps/fake-comfy/src/main.ts',
      cwd: process.cwd(),
      env: commonEnvironment,
      url: `${fakeComfyOrigin}/health`,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      // The ComfyUI browser gateway (infra/caddy/Caddyfile). Docker is already
      // a hard prerequisite for this suite -- scripts/test-e2e.ts refuses to
      // run without PostgreSQL -- so requiring it here adds no new dependency,
      // and it lets e2e/comfy-gateway.spec.ts assert the section 5 denials on
      // every run instead of once by hand on a rented host.
      command:
        'docker compose -f infra/compose.yaml --profile gateway up comfy-gateway',
      cwd: process.cwd(),
      env: {
        ...commonEnvironment,
        GATEWAY_PORT: String(gatewayPort),
        COMFY_UPSTREAM: `host.docker.internal:${fakeComfyPort}`,
        VIDEOOPS_STUDIO_ORIGIN: webOrigin,
      },
      url: `${gatewayOrigin}/comfy/system_stats`,
      timeout: 120_000,
      reuseExistingServer: true,
    },
    {
      command: 'pnpm exec tsx apps/api/src/main.ts',
      cwd: process.cwd(),
      env: commonEnvironment,
      url: `${apiOrigin}/health/ready`,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @h3/web dev',
      cwd: process.cwd(),
      env: commonEnvironment,
      url: webOrigin,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
