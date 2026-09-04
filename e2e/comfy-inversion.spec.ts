import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const token = 'e2e-token';
const studioOrigin =
  process.env.E2E_WEB_ORIGIN ??
  `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '35173'}`;
const comfyOrigin =
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

async function graphState(page: Page): Promise<{
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

async function authenticateStudioSession(page: Page): Promise<void> {
  await page.goto(studioOrigin);
  await page.evaluate(
    ({ storageKey, value }) => sessionStorage.setItem(storageKey, value),
    { storageKey: 'h3-videoops-development-token', value: token },
  );
}

test.describe('ComfyUI plugin inversion', () => {
  test.skip(
    !frontendAvailable,
    'pinned ComfyUI frontend build is absent; run pnpm comfy:frontend before running @comfy-frontend specs',
  );

  test('keeps credentials in Studio, disables native queue, and creates a managed run', async ({
    page,
  }) => {
    await authenticateStudioSession(page);
    await page.goto(`${comfyOrigin}/`);
    await waitForEditor(page);
    const templateOverlay = page.locator(
      '[data-testid="dialog-overlay"][data-state="open"]',
    );
    await templateOverlay
      .first()
      .waitFor({ state: 'visible', timeout: 3_000 })
      .catch(() => {});
    if (await templateOverlay.first().isVisible()) {
      await page
        .getByRole('button', { name: 'Close dialog' })
        .last()
        .click({ force: true });
      await expect(templateOverlay.first()).toHaveCount(0);
    }

    await expect(page.getByTestId('queue-button')).toBeDisabled();
    await expect(page.getByTestId('queue-mode-menu-trigger')).toBeDisabled();
    await expect(page.getByTestId('queue-mode-menu-trigger')).toBeDisabled();
    const managedRunButton = page
      .locator('[data-testid="action-bar-buttons"] button')
      .filter({ hasText: 'Managed Run' });
    await expect(managedRunButton).toBeVisible();
    await expect(page.getByTestId('h3-videoops-tab-button')).toBeVisible();
    await expect(page.getByText('VideoOps · managed')).toBeVisible();
    await expect(page.getByText('VideoOps · managed')).toBeVisible();

    const isolation = await page.evaluate((credential) => {
      const storage = `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`;
      const documentText = document.documentElement.textContent ?? '';
      const globalKeys = Object.getOwnPropertyNames(window);
      const globalValues = globalKeys.flatMap((key) => {
        try {
          const value = (window as unknown as Record<string, unknown>)[key];
          return typeof value === 'string' ? [value] : [];
        } catch {
          return [];
        }
      });
      const iframe = document.querySelector(
        'iframe[data-videoops-iframe="true"]',
      );
      let crossOriginProtected = false;
      try {
        void (iframe as HTMLIFrameElement | null)?.contentWindow?.document;
      } catch {
        crossOriginProtected = true;
      }
      return {
        storageHasCredential: storage.includes(credential),
        globalsHaveCredential:
          documentText.includes(credential) ||
          globalKeys.some((key) => key.includes(credential)) ||
          globalValues.some((value) => value.includes(credential)),
        crossOriginProtected,
        iframeSrc: iframe?.getAttribute('src') ?? '',
      };
    }, token);
    console.log(`[comfy-isolation] ${JSON.stringify(isolation)}`);
    expect(isolation.storageHasCredential).toBe(false);
    expect(isolation.globalsHaveCredential).toBe(false);
    expect(isolation.crossOriginProtected).toBe(true);
    expect(isolation.iframeSrc).toContain(studioOrigin);
    expect(isolation.iframeSrc).not.toContain(token);

    const browserQueue = await page.evaluate(async () => {
      const response = await fetch('/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: {} }),
      });
      return response.status;
    });
    expect(browserQueue).toBe(405);

    await page.getByTestId('h3-videoops-tab-button').click();
    const panel = page.frameLocator('iframe[data-videoops-iframe="true"]');
    await expect(
      panel.getByRole('heading', { name: 'Run history' }),
    ).toBeVisible();
    await expect(panel.getByText('Template opened in ComfyUI')).toBeVisible();
    await expect(
      panel.getByRole('link', { name: 'Start from a brief' }),
    ).toBeVisible();
    await expect(
      panel.getByRole('link', { name: 'Start from a brief' }),
    ).toBeVisible();
    await page.waitForFunction(() => {
      const candidate = (
        window as unknown as {
          app?: { rootGraph?: { _nodes?: unknown[] } };
        }
      ).app;
      return (candidate?.rootGraph?._nodes?.length ?? 0) > 0;
    });
    expect((await graphState(page)).nodeTypes).toContain('SaveVideo');

    // ComfyUI destroys the custom sidebar tab on every switch. Closing and
    // reopening previously left the panel blank and Managed Run dead until a
    // full page reload, because the tab teardown ended the bridge session.
    await page.getByTestId('h3-videoops-tab-button').click();
    await expect(
      page.locator('iframe[data-videoops-iframe="true"]'),
    ).toHaveCount(0);
    await page.getByTestId('h3-videoops-tab-button').click();
    await expect(
      panel.getByRole('heading', { name: 'Run history' }),
    ).toBeVisible({ timeout: 30_000 });

    mkdirSync(screenshotRoot, { recursive: true });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: resolve(screenshotRoot, '04-videoops-sidebar.png'),
      fullPage: true,
      animations: 'disabled',
    });

    let createRequests = 0;
    let createPayload: Record<string, unknown> | undefined;
    let createResponse: { status: number; body: string } | undefined;
    page.on('response', async (response) => {
      if (
        response.request().method() !== 'POST' ||
        new URL(response.url()).pathname !== '/v1/runs'
      ) {
        return;
      }
      try {
        createResponse = {
          status: response.status(),
          body: (await response.text()).slice(0, 2000),
        };
      } catch {
        createResponse = undefined;
      }
    });
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/v1/runs'
      ) {
        createRequests += 1;
        try {
          createPayload = request.postDataJSON() as Record<string, unknown>;
        } catch {
          createPayload = undefined;
        }
      }
    });
    await managedRunButton.click();
    await expect.poll(() => createRequests).toBe(1);

    // The managed profile executes a resolved graph, so the submitted API graph
    // is a compilation of the export rather than a copy of it. What must hold
    // is that the compilation is faithful: `unresolvableNodeClasses` refuses
    // any export it cannot express, so a submission that happens at all covers
    // every node the user built. See web.test.ts for the refusal cases.
    expect(createPayload?.apiGraph).toBeTruthy();
    expect(Object.keys(createPayload?.apiGraph as object).length).toBeGreaterThan(0);
    // Surface the response body on failure; a validation rejection is the most
    // likely reason a managed run never appears.
    await expect
      .poll(
        () =>
          createResponse
            ? `${createResponse.status} ${createResponse.body}`
            : 'no POST /v1/runs response',
        { timeout: 30_000 },
      )
      .toMatch(/^201 /);
    await expect(panel.getByText(/Managed run .* created/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(panel.getByText('No managed runs')).toHaveCount(0);
    await expect(
      panel.getByRole('button', { name: 'Pin keeper' }),
    ).toBeVisible();
    await expect(
      panel.getByText('Awaiting Review', { exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    });

    mkdirSync(screenshotRoot, { recursive: true });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: resolve(screenshotRoot, '05-videoops-managed-run.png'),
      fullPage: true,
      animations: 'disabled',
    });

    await panel.getByRole('button', { name: 'Pin keeper' }).click();
    await expect(
      panel.getByRole('button', { name: 'Unpin keeper' }),
    ).toBeVisible();
    await panel
      .getByLabel('Review note')
      .fill('Managed panel review evidence.');
    await panel.getByRole('button', { name: 'Accept annotation' }).click();
    await expect(panel.getByText('Accepted', { exact: true })).toBeVisible();
    await panel
      .getByRole('button', { name: 'Load revision in ComfyUI' })
      .click();
    await expect(panel.getByText(/Revision .* sent to ComfyUI/)).toBeVisible();
    expect((await graphState(page)).nodeTypes).toContain('SaveVideo');
  });
});
