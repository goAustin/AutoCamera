import { defineConfig } from '@playwright/test';

const apiPort = Number(process.env.E2E_API_PORT ?? 3300);
const fakeComfyPort = Number(process.env.E2E_FAKE_COMFY_PORT ?? 38188);
const webPort = Number(process.env.E2E_WEB_PORT ?? 35173);
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const fakeComfyOrigin = `http://127.0.0.1:${fakeComfyPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;

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
  H3_MEDIA_FIXTURE_PATH: `${process.cwd()}/.data/fixtures/h3-t2v-fixture.mp4`,
  PI_PROVIDER: 'faux',
  API_HOST: '127.0.0.1',
  API_PORT: String(apiPort),
  WEB_ORIGIN: webOrigin,
  VIDEOOPS_STUDIO_ORIGIN: webOrigin,
  FAKE_COMFY_HOST: '127.0.0.1',
  FAKE_COMFY_PORT: String(fakeComfyPort),
  WEB_HOST: '127.0.0.1',
  WEB_PORT: String(webPort),
  VITE_API_ORIGIN: apiOrigin,
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
