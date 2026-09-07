import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { screenshotRoot as resolveScreenshotRoot } from './evidence-path.js';

const fakeComfyOrigin =
  process.env.E2E_FAKE_COMFY_ORIGIN ??
  `http://127.0.0.1:${process.env.E2E_FAKE_COMFY_PORT ?? '38188'}`;
const frontendRoot = resolve(
  process.env.COMFY_FRONTEND_DIST ?? '.data/comfy-frontend/dist',
);
const frontendAvailable = existsSync(resolve(frontendRoot, 'index.html'));
const screenshotRoot = resolveScreenshotRoot('comfy-frontend');
const skipReason =
  'pinned ComfyUI frontend build is absent; run pnpm comfy:frontend before running @comfy-frontend specs';

if (!frontendAvailable) {
  console.info(`[comfy-frontend] SKIP: ${skipReason}`);
}

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.locator('#graph-canvas')).toBeVisible({ timeout: 30_000 });
  // `#splash-loader` is a fixed z-index-9999 overlay that covers the canvas
  // until the Vue app mounts, and `app.rootGraph` is populated before it
  // clears. Waiting on the JS objects alone therefore screenshots the splash,
  // which is what made `01-editor-loaded.png` regenerate as a 10 KB Comfy logo
  // in a file whose name claims the editor is loaded.
  await expect(page.locator('#splash-loader')).toBeHidden({ timeout: 30_000 });
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

// A capture that renders nothing still writes a valid PNG, and the
// documentation gate only checks that the file exists and is cited. Both
// observed failures were therefore invisible: `01-editor-loaded.png`
// regenerating as the splash screen collapsed it from ~44 KB to ~10 KB, and two
// captures of the same state came out byte-identical. Guard the bytes directly
// -- it needs no knowledge of ComfyUI's DOM, and it fails on exactly the two
// things that went wrong.
const MINIMUM_CAPTURE_BYTES = 20_000;

async function capture(page: Page, filename: string): Promise<number> {
  mkdirSync(screenshotRoot, { recursive: true });
  const path = resolve(screenshotRoot, filename);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  const { size } = statSync(path);
  expect(
    size,
    `${filename} is ${size} bytes; an unrendered editor collapses to roughly 10 KB`,
  ).toBeGreaterThan(MINIMUM_CAPTURE_BYTES);
  return size;
}

test.describe('@comfy-frontend pinned editor shell', () => {
  test.skip(!frontendAvailable, skipReason);

  test('loads the pinned editor shell', async ({ page }) => {
    await page.goto(`${fakeComfyOrigin}/`);
    await waitForEditor(page);
    await page.keyboard.press('Escape');
    await capture(page, '01-editor-loaded.png');
  });

  test('opens the pinned H3 workflow template', async ({ page }) => {
    await openH3Template(page);
    const state = await graphState(page);
    expect(state.nodeCount).toBeGreaterThan(0);
    expect(state.nodeTypes).toContain('SaveVideo');
    await capture(page, '02-h3-template-open.png');
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
    // Deliberately captures nothing. `app.graphToPrompt()` is a pure read of
    // the graph with no visual effect, so a screenshot here is the same picture
    // as `02-h3-template-open.png` -- which is why the two regenerated
    // byte-identical. The export is proven by the assertions above; a duplicate
    // image named after an operation it cannot depict is not evidence of it.
  });
});
