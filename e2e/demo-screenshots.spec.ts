import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const token = 'e2e-token';
const apiOrigin =
  process.env.E2E_API_ORIGIN ??
  `http://127.0.0.1:${process.env.E2E_API_PORT ?? '3300'}`;
const screenshotRoot = resolve(process.cwd(), 'assets/screenshots');

async function capture(page: Page, filename: string): Promise<void> {
  await page.screenshot({
    path: resolve(screenshotRoot, filename),
    fullPage: true,
    animations: 'disabled',
  });
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

async function createProject(page: Page): Promise<string> {
  await page
    .getByLabel('Project title')
    .fill('[Demo] Product story control room');
  await page
    .getByLabel('Creative brief')
    .fill(
      'A calm product story showing how a small team turns an idea into a reviewable video preview.',
    );
  await page.getByLabel('Target duration (seconds)').fill('15');
  await page.getByLabel('Budget (USD)').fill('25.00');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Storyboard' })).toBeVisible();
  const match = /\/projects\/([^/]+)/.exec(page.url());
  if (!match?.[1]) throw new Error('The created project route was not found.');
  return match[1];
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

async function selectShot(page: Page, ordinal: number): Promise<string> {
  const link = page.getByRole('link', {
    name: new RegExp(`Shot 0${ordinal}`),
  });
  await link.click();
  await expect(
    page.getByRole('heading', { name: 'Shape the managed graph' }),
  ).toBeVisible();
  await expect(page.getByText('SIMULATED', { exact: true })).toBeVisible();
  const href = await link.getAttribute('href');
  const shotId = href?.split('/').pop();
  if (!shotId) throw new Error('The selected shot route was not found.');
  return shotId;
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

function history(page: Page) {
  return page.locator('section[aria-labelledby="attempt-history-title"]');
}

async function waitForReview(page: Page): Promise<void> {
  const card = history(page).locator('.attempt-card').first();
  await expect(card.getByText('Awaiting Review', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    card.getByText('Technical evaluation', { exact: true }),
  ).toBeVisible();
  await expect(card.getByText('Passed', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

async function acceptFirstAttempt(page: Page): Promise<void> {
  const card = history(page).locator('.attempt-card').first();
  await card.getByRole('button', { name: 'Accept passing attempt' }).click();
  await expect(card.getByText('Accepted', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

async function apiJson(
  path: string,
  key: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(apiOrigin + path, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as unknown;
  expect(response.ok, JSON.stringify(payload)).toBe(true);
  expect(typeof payload).toBe('object');
  return payload as Record<string, unknown>;
}

test('captures the deterministic offline release evidence set', async ({
  page,
}) => {
  mkdirSync(screenshotRoot, { recursive: true });
  await enterStudio(page);
  const projectId = await createProject(page);
  await capture(page, '01-project-create.png');

  await planAndApprove(page);
  await capture(page, '02-storyboard-approved.png');

  await selectShot(page, 1);
  await capture(page, '03-managed-workflow.png');

  await createRevision(page);
  await capture(page, '04-revision-history.png');

  await generateManaged(page);
  await expect(history(page).locator('.attempt-card')).toHaveCount(1);
  await capture(page, '05-attempt-progress.png');

  await waitForReview(page);
  await capture(page, '06-artifact-review.png');
  await acceptFirstAttempt(page);

  const shotTwoHref = await page
    .getByRole('link', { name: /Shot 02/ })
    .getAttribute('href');
  const shotTwoId = shotTwoHref?.split('/').pop();
  if (!shotTwoId) throw new Error('Shot 02 route was not found.');
  await apiJson(
    `/v1/shots/${shotTwoId}/attempts`,
    'phase6-screenshot-failure',
    { scenario: 'execution-failure' },
  );
  await expect(page.getByText('ATTEMPT_FAILED', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await capture(page, '07-timeline-recommendation.png');

  await selectShot(page, 2);
  const failed = history(page).locator('.attempt-card').first();
  await expect(failed.getByText('Failed', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await failed.getByRole('button', { name: 'Retry with confirmation' }).click();
  await expect(
    page.getByRole('alertdialog', { name: 'Spend budget on a derived retry?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm retry' }).click();
  await expect(history(page).locator('.attempt-card')).toHaveCount(2, {
    timeout: 30_000,
  });
  await waitForReview(page);
  await acceptFirstAttempt(page);

  await selectShot(page, 3);
  await createRevision(page);
  await generateManaged(page);
  await waitForReview(page);
  await acceptFirstAttempt(page);

  await page.goto(`/projects/${projectId}`);
  await expect(page.getByText('Completed', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await capture(page, '08-completed-project.png');
});
