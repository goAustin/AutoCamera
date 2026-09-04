import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const fakeComfyOrigin =
  process.env.E2E_FAKE_COMFY_ORIGIN ??
  `http://127.0.0.1:${process.env.E2E_FAKE_COMFY_PORT ?? '38188'}`;
const frontendRoot = resolve(
  process.env.COMFY_FRONTEND_DIST ?? '.data/comfy-frontend/dist',
);
const frontendAvailable = existsSync(resolve(frontendRoot, 'index.html'));
const screenshotRoot = resolve(
  process.cwd(),
  'assets/screenshots/comfy-frontend',
);
const skipReason =
  'pinned ComfyUI frontend build is absent; run pnpm comfy:frontend before running @comfy-frontend specs';

if (!frontendAvailable) {
  console.info(`[comfy-frontend] SKIP: ${skipReason}`);
}

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.locator('#graph-canvas')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const candidate = (
      window as unknown as {
        app?: { rootGraph?: unknown; graphToPrompt?: unknown };
      }
    ).app;
    return Boolean(candidate?.rootGraph && candidate.graphToPrompt);
  });
}

async function openH3Template(page: Page): Promise<void> {
  await page.goto(
    `${fakeComfyOrigin}/?template=video_minimax_h3_t2v&source=default`,
  );
  await waitForEditor(page);
  await page.waitForFunction(() => {
    const candidate = (
      window as unknown as {
        app?: { rootGraph?: { _nodes?: unknown[] } };
      }
    ).app;
    return (candidate?.rootGraph?._nodes?.length ?? 0) > 0;
  });
}

function graphState(page: Page): Promise<{
  readonly nodeCount: number;
  readonly nodeTypes: readonly string[];
}> {
  return page.evaluate(() => {
    const candidate = (
      window as unknown as {
        app?: {
          rootGraph?: {
            _nodes?: ReadonlyArray<{ readonly type?: unknown }>;
          };
        };
      }
    ).app;
    const nodes = candidate?.rootGraph?._nodes ?? [];
    return {
      nodeCount: nodes.length,
      nodeTypes: nodes.flatMap((node) =>
        typeof node.type === 'string' ? [node.type] : [],
      ),
    };
  });
}

test.describe('@comfy-frontend pinned editor shell', () => {
  test.skip(!frontendAvailable, skipReason);

  test('loads the pinned editor shell', async ({ page }) => {
    await page.goto(`${fakeComfyOrigin}/`);
    await waitForEditor(page);
    await page.keyboard.press('Escape');
    mkdirSync(screenshotRoot, { recursive: true });
    await page.screenshot({
      path: resolve(screenshotRoot, '01-editor-loaded.png'),
      fullPage: true,
      animations: 'disabled',
    });
  });

  test('opens the pinned H3 workflow template', async ({ page }) => {
    await openH3Template(page);
    const state = await graphState(page);
    expect(state.nodeCount).toBeGreaterThan(0);
    expect(state.nodeTypes).toContain('SaveVideo');
    mkdirSync(screenshotRoot, { recursive: true });
    await page.screenshot({
      path: resolve(screenshotRoot, '02-h3-template-open.png'),
      fullPage: true,
      animations: 'disabled',
    });
  });

  test('exports workflow and output through app.graphToPrompt', async ({
    page,
  }) => {
    await openH3Template(page);
    const exported = await page.evaluate(async () => {
      const candidate = (
        window as unknown as {
          app?: {
            graphToPrompt?: () => Promise<{
              readonly workflow?: unknown;
              readonly output?: unknown;
            }>;
          };
        }
      ).app;
      if (!candidate?.graphToPrompt) {
        throw new Error('window.app.graphToPrompt is unavailable');
      }
      const result = await candidate.graphToPrompt();
      return {
        workflow: result.workflow,
        output: result.output,
      };
    });
    expect(exported.workflow).toMatchObject({ nodes: expect.any(Array) });
    expect(
      Object.keys(exported.output as Record<string, unknown>),
    ).not.toHaveLength(0);
    mkdirSync(screenshotRoot, { recursive: true });
    await page.screenshot({
      path: resolve(screenshotRoot, '03-graph-to-prompt.png'),
      fullPage: true,
      animations: 'disabled',
    });
  });
});
