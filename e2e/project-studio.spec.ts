import { expect, test, type Page } from '@playwright/test';

const token = 'e2e-token';
const apiOrigin =
  process.env.E2E_API_ORIGIN ??
  `http://127.0.0.1:${process.env.E2E_API_PORT ?? '3300'}`;

function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function browserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    // The happy-path test intentionally aborts the project event stream to
    // prove that REST refresh recovery is sufficient. Chromium reports that
    // expected route abort as a generic resource error; retain all useful
    // application and page errors.
    if (
      message.type() === 'error' &&
      message.text() !== 'Failed to load resource: net::ERR_FAILED'
    ) {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function enterStudio(page: Page): Promise<void> {
  // Phase 7D step 1 moves the legacy Studio entry point from `/` (now
  // `StandaloneRunPage`) to `/projects`; the screen and behaviour below are
  // otherwise unchanged.
  await page.goto('/projects');
  await page.getByLabel('Development token').fill(token);
  await page.getByRole('button', { name: 'Enter Project Studio' }).click();
  await expect(
    page.getByRole('heading', { name: 'Projects that stay explainable.' }),
  ).toBeVisible();
}

async function createProject(page: Page, prefix: string): Promise<void> {
  await page.getByLabel('Project title').fill(uniqueName(prefix));
  await page
    .getByLabel('Creative brief')
    .fill(
      'A premium product story with clear motion and natural stereo sound.',
    );
  await page.getByLabel('Target duration (seconds)').fill('15');
  await page.getByLabel('Budget (USD)').fill('25.00');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Storyboard' })).toBeVisible();
}

async function planAndApprove(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Plan with Pi' }).click();
  await expect(page.getByText('Ready for human approval')).toBeVisible();
  await expect(page.locator('.storyboard-card')).toHaveCount(3);
  await page.getByRole('button', { name: 'Approve storyboard' }).click();
  await expect(
    page.getByText('The storyboard is approved.', { exact: false }),
  ).toBeVisible();
}

async function selectFirstShot(page: Page): Promise<void> {
  await page.getByRole('link', { name: /Shot 01/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Shape the managed graph' }),
  ).toBeVisible();
  await expect(page.getByText('SIMULATED', { exact: true })).toBeVisible();
}

async function createRevision(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: 'Create revision & validate' })
    .click();
  await expect(page.getByText('Revision 1 validated.')).toBeVisible();
  await expect(
    page
      .locator('section[aria-labelledby="revision-history-title"]')
      .getByText('Revision 1', { exact: true }),
  ).toBeVisible();
}

async function generateManaged(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Generate managed' }).click();
  await expect(
    page.getByRole('alertdialog', { name: 'Generate this managed revision?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm Generate managed' }).click();
  await expect(page.getByText(/Managed attempt .* queued/)).toBeVisible();
}

function attemptHistory(page: Page) {
  return page.locator('section[aria-labelledby="attempt-history-title"]');
}

async function waitForAwaitingReview(page: Page): Promise<void> {
  const firstAttempt = attemptHistory(page).locator('.attempt-card').first();
  await expect(
    firstAttempt.getByText('Awaiting Review', { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    firstAttempt.getByText('Technical evaluation', { exact: true }),
  ).toBeVisible();
  await expect(firstAttempt.getByText('Passed', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

async function apiJson(
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly key: string;
  },
): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiOrigin}${path}`, {
    method: options.method ?? 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': options.key,
    },
    body: JSON.stringify(options.body ?? {}),
  });
  const payload = (await response.json()) as unknown;
  expect(response.ok, JSON.stringify(payload)).toBe(true);
  expect(typeof payload).toBe('object');
  return payload as Record<string, unknown>;
}

test.describe('Project Studio offline journeys', () => {
  test('runs the happy path through review and reconstructs after refresh', async ({
    page,
  }) => {
    const errors = browserErrors(page);
    await page.route('**/v1/projects/*/events/stream', (route) =>
      route.abort('failed'),
    );
    await enterStudio(page);
    await createProject(page, 'Happy path');
    await planAndApprove(page);
    await selectFirstShot(page);
    await createRevision(page);
    await generateManaged(page);
    await waitForAwaitingReview(page);

    const history = attemptHistory(page);
    await expect(history.locator('video.artifact-player')).toBeVisible();
    await expect(history.getByText('Passed', { exact: true })).toBeVisible();
    await history
      .getByRole('button', { name: 'Accept passing attempt' })
      .click();
    await expect(history.getByText('Accepted', { exact: true })).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Shape the managed graph' }),
    ).toBeVisible();
    await expect(
      attemptHistory(page).getByText('Accepted', { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('rejects, derives a retry, and accepts the replacement attempt', async ({
    page,
  }) => {
    await enterStudio(page);
    await createProject(page, 'Regeneration');
    await planAndApprove(page);
    await selectFirstShot(page);
    await createRevision(page);
    await generateManaged(page);
    await waitForAwaitingReview(page);

    const history = attemptHistory(page);
    await history.getByRole('button', { name: 'Reject' }).click();
    await history.getByLabel('Review reason code').fill('TOO_DARK');
    await history.getByRole('button', { name: 'Reject attempt' }).click();
    await expect(history.getByText('Rejected', { exact: true })).toBeVisible();
    await history
      .getByRole('button', { name: 'Retry with confirmation' })
      .click();
    await expect(
      history.getByRole('alertdialog', {
        name: 'Spend budget on a derived retry?',
      }),
    ).toBeVisible();
    await history.getByRole('button', { name: 'Confirm retry' }).click();
    await expect(history.locator('.attempt-card')).toHaveCount(2, {
      timeout: 30_000,
    });
    const replacement = history.locator('.attempt-card').first();
    await expect(
      replacement.getByText('Awaiting Review', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(replacement.getByText('Passed', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await history
      .locator('.attempt-card')
      .first()
      .getByRole('button', { name: 'Accept passing attempt' })
      .click();
    await expect(
      history
        .locator('.attempt-card')
        .first()
        .getByText('Accepted', { exact: true }),
    ).toBeVisible();
  });

  test('shows invalid graph correction details without creating an attempt', async ({
    page,
  }) => {
    await enterStudio(page);
    await createProject(page, 'Invalid graph');
    await planAndApprove(page);
    await selectFirstShot(page);
    await page.getByLabel('Width').fill('950');
    await page
      .getByRole('button', { name: 'Create revision & validate' })
      .click();
    await expect(
      page.getByText('saved with validation errors', { exact: false }),
    ).toBeVisible();
    await expect(
      page
        .locator('section[aria-labelledby="revision-history-title"]')
        .getByText('DIMENSION_INVALID', { exact: false })
        .first(),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Generate managed' }),
    ).toBeDisabled();
    await expect(page.getByText('No managed attempts')).toBeVisible();
  });

  test('surfaces a recoverable infrastructure failure and requires human retry confirmation', async ({
    page,
  }) => {
    await enterStudio(page);
    await createProject(page, 'Infrastructure recovery');
    await planAndApprove(page);
    await selectFirstShot(page);

    const shotHref = await page
      .getByRole('link', { name: /Shot 01/ })
      .getAttribute('href');
    const shotId = shotHref?.split('/').pop();
    expect(shotId).toBeTruthy();
    const created = await apiJson(`/v1/shots/${shotId}/attempts`, {
      key: `e2e-failure-${Date.now()}`,
      body: { scenario: 'execution-failure' },
    });
    expect(created.attempt).toBeTruthy();

    const history = attemptHistory(page);
    await expect(history.getByText('Failed', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(history.getByText('COMFY_EXECUTION_FAILED')).toBeVisible();
    await history
      .getByRole('button', { name: 'Retry with confirmation' })
      .click();
    await expect(
      history.getByRole('alertdialog', {
        name: 'Spend budget on a derived retry?',
      }),
    ).toBeVisible();
    await history.getByRole('button', { name: 'Confirm retry' }).click();
    await expect(history.locator('.attempt-card')).toHaveCount(2, {
      timeout: 30_000,
    });
    const replacement = history.locator('.attempt-card').first();
    await expect(
      replacement.getByText('Awaiting Review', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(replacement.getByText('Passed', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await history
      .locator('.attempt-card')
      .first()
      .getByRole('button', { name: 'Accept passing attempt' })
      .click();
    await expect(
      history
        .locator('.attempt-card')
        .first()
        .getByText('Accepted', { exact: true }),
    ).toBeVisible();
  });
});
