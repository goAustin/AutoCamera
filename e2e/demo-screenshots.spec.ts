import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { screenshotRoot as resolveScreenshotRoot } from './evidence-path.js';

// Phase 7D step 6: the legacy Studio screens this spec used to walk through
// (project create, storyboard approve, managed workflow shaping, revision
// history, ...) are deleted. This captures the offline release evidence set
// from what replaced them: `StandaloneRunPage`, mounted at `/` with no
// ComfyUI origin present, which is the durable execution and monitoring
// record described in `70-PHASE-7-DESIGN-REFERENCE.md`. Every screenshot
// here is written under `assets/screenshots/` directly -- never under
// `assets/screenshots/comfy-frontend/`, which belongs to
// `comfy-frontend.spec.ts` and `comfy-inversion.spec.ts` and is unaffected
// by this checkpoint. The ComfyUI-sidebar half of the run view already has
// its own evidence there (`comfy-frontend/05-videoops-managed-run.png`);
// this spec does not duplicate it.
//
// Evidence level: Offline fake. `COMFY_MODE=fake` drives every attempt
// below; no GPU, model weights, or real H3 inference is involved, and
// nothing here may be read as GPU or H3 inference evidence.

const token = 'e2e-token';
const apiOrigin =
  process.env.E2E_API_ORIGIN ??
  `http://127.0.0.1:${process.env.E2E_API_PORT ?? '3300'}`;
const screenshotRoot = resolveScreenshotRoot();

async function capture(page: Page, filename: string): Promise<void> {
  await page.screenshot({
    path: resolve(screenshotRoot, filename),
    fullPage: true,
    animations: 'disabled',
  });
}

function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function apiCall(
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly key?: string;
    readonly expectStatus?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  };
  const init: RequestInit = { method: options.method ?? 'GET', headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (options.key) headers['idempotency-key'] = options.key;
  const response = await fetch(`${apiOrigin}${path}`, init);
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (options.expectStatus !== undefined) {
    expect(response.status, `${path} -> ${JSON.stringify(payload)}`).toBe(
      options.expectStatus,
    );
  } else {
    expect(response.ok, `${path} -> ${JSON.stringify(payload)}`).toBe(true);
  }
  return payload;
}

/**
 * Shots are never listed or otherwise addressable from outside (Phase 7D
 * removed the planner UI and its `/plan` and `/storyboard/approve` routes
 * along with the last place that surfaced a shot id directly). Submitting
 * `POST /v1/runs` with a graph that fails validation still creates the
 * project's implicit shot and a `shot.created` domain event without
 * reaching attempt creation, leaving the shot `approved_for_generation` --
 * exactly the fixture `e2e/run-view.spec.ts` uses for the same reason.
 */
async function createApprovedShot(prefix: string): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = await apiCall('/v1/projects', {
    method: 'POST',
    key: `demo-screenshots-project-${suffix}`,
    body: {
      title: uniqueName(prefix),
      brief:
        'A calm product story showing how a small team turns an idea into a reviewable video preview.',
      targetDurationSeconds: 15,
      budgetUsd: '25.00',
    },
  });
  const projectId = (created.project as Record<string, unknown>).id as string;
  await apiCall('/v1/runs', {
    method: 'POST',
    key: `demo-screenshots-seed-run-${suffix}`,
    body: { projectId, editorGraph: {}, apiGraph: {} },
    expectStatus: 422,
  });
  const events = await apiCall(`/v1/projects/${projectId}/events`);
  const shotCreated = (
    events.events as ReadonlyArray<Record<string, unknown>>
  ).find((event) => event.type === 'shot.created');
  const shotId = shotCreated?.shotId as string | undefined;
  if (!shotId) throw new Error('Expected a shot.created event with a shotId.');
  return shotId;
}

async function createScenarioAttempt(
  shotId: string,
  scenario?: string,
): Promise<Record<string, unknown>> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await apiCall(`/v1/shots/${shotId}/attempts`, {
    method: 'POST',
    key: `demo-screenshots-attempt-${suffix}`,
    body: scenario ? { scenario } : {},
  });
  return result.attempt as Record<string, unknown>;
}

async function findRetryRunId(sourceRunId: string): Promise<string> {
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const result = await apiCall('/v1/runs?limit=25');
    const runs = result.runs as ReadonlyArray<Record<string, unknown>>;
    const match = runs.find((run) => {
      const attempt = run.attempt as Record<string, unknown>;
      return attempt.sourceAttemptId === sourceRunId;
    });
    if (match) return match.runId as string;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('The retried run was not found within the timeout.');
}

function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

async function enterRunView(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Development token').fill(token);
  await page.getByRole('button', { name: 'Enter Project Studio' }).click();
  await expect(page.getByRole('heading', { name: 'Run history' })).toBeVisible({
    timeout: 15_000,
  });
}

function selectedRunDetail(page: Page) {
  return page.locator('[aria-label="Selected run"]');
}

async function selectRun(page: Page, runId: string): Promise<void> {
  await expect(
    page.locator('.run-rail-item', { hasText: shortId(runId) }),
  ).toBeVisible({ timeout: 30_000 });
  await page.locator('.run-rail-item', { hasText: shortId(runId) }).click();
  // The run's own id is never headlined raw (see conventions.md) — the
  // header shows the same shortened form the rail row does.
  await expect(selectedRunDetail(page).getByText(shortId(runId))).toBeVisible({
    timeout: 30_000,
  });
}

test('captures the deterministic offline release evidence set', async ({
  page,
}) => {
  mkdirSync(screenshotRoot, { recursive: true });

  // 01: the history list, populated with the first run of this walkthrough,
  // captured before its attempt has finished (queued/generating).
  const historyShotId = await createApprovedShot('Demo history');
  const historyAttempt = await createScenarioAttempt(historyShotId, 'success');
  const historyRunId = historyAttempt.id as string;
  await enterRunView(page);
  await expect(
    page.locator('.run-rail-item', { hasText: shortId(historyRunId) }),
  ).toBeVisible({ timeout: 30_000 });
  await capture(page, '01-run-history.png');

  // `fake-comfy` resolves an attempt in ~350ms (see playwright.config.ts's
  // ATTEMPT_TIMEOUT_SECONDS comment), so by the time any Playwright
  // assertion above can resolve, the run is already `awaiting_review` --
  // there is no reachable "still executing" moment left to capture
  // truthfully. Trace ID and progress are shown below as part of the same
  // detail view rather than as a separate, misleadingly-labelled capture.

  // 02: the artifact player and passed evaluation once the fake executor
  // finishes, still awaiting human review.
  await selectRun(page, historyRunId);
  const historyCard = selectedRunDetail(page).locator('.attempt-card');
  await expect(
    historyCard.getByText('Awaiting Review', { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(historyCard.getByText('Passed', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    historyCard.locator('video[aria-label="Generated artifact"]'),
  ).toBeVisible();
  await expect(
    selectedRunDetail(page).getByText('Trace', { exact: false }),
  ).toBeVisible();
  await capture(page, '02-artifact-review.png');

  // 03: the run after a human accepts the passing attempt. Accept / Reject /
  // Derive retry now live in the sticky header, not inside the attempt card.
  await selectedRunDetail(page)
    .getByRole('button', { name: 'Accept passing attempt' })
    .click();
  await expect(
    historyCard.getByText('Accepted', { exact: true }),
  ).toBeVisible();
  await capture(page, '03-run-accepted.png');

  // 04: a recoverable infrastructure failure, with the derived-retry
  // confirmation dialog open -- retry is never automatic.
  const failureShotId = await createApprovedShot('Demo recoverable failure');
  const failureAttempt = await createScenarioAttempt(
    failureShotId,
    'execution-failure',
  );
  const failureRunId = failureAttempt.id as string;
  await selectRun(page, failureRunId);
  const failureCard = selectedRunDetail(page).locator('.attempt-card');
  await expect(failureCard.getByText('Failed', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(failureCard.getByText('COMFY_EXECUTION_FAILED')).toBeVisible();
  await selectedRunDetail(page)
    .getByRole('button', { name: 'Derive retry' })
    .click();
  await expect(
    page.getByRole('alertdialog', {
      name: 'Spend budget on a derived retry?',
    }),
  ).toBeVisible();
  await capture(page, '04-recoverable-failure.png');

  // 05: the derived retry, awaiting review with its own passed evaluation --
  // proof the recovery path this checkpoint is built around actually works.
  await page.getByRole('button', { name: 'Confirm retry' }).click();
  const retryRunId = await findRetryRunId(failureRunId);
  await selectRun(page, retryRunId);
  const retryCard = selectedRunDetail(page).locator('.attempt-card');
  await expect(
    retryCard.getByText('Awaiting Review', { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(retryCard.getByText('Passed', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await capture(page, '05-retry-derived.png');
  await selectedRunDetail(page)
    .getByRole('button', { name: 'Accept passing attempt' })
    .click();
  await expect(retryCard.getByText('Accepted', { exact: true })).toBeVisible();

  // 06: an operator finding, generated by the running operational worker
  // from the earlier timed-out-style failure, with its apply-confirmation
  // dialog open. Findings are scoped to the project, so its own run must be
  // selected first.
  const findingShotId = await createApprovedShot('Demo finding');
  const findingAttempt = await createScenarioAttempt(findingShotId, 'timeout');
  const findingRunId = findingAttempt.id as string;
  await selectRun(page, findingRunId);
  const findingCard = page.locator('.recommendation-card', {
    hasText: 'Review the timed-out generation attempt',
  });
  await expect(findingCard).toBeVisible({ timeout: 30_000 });
  await findingCard
    .getByRole('button', { name: 'Apply recommendation' })
    .click();
  await expect(
    page.getByRole('alertdialog', {
      name: 'Apply a budget-spending recommendation?',
    }),
  ).toBeVisible();
  await capture(page, '06-finding-apply-confirmation.png');
  await page.getByRole('button', { name: 'Apply and retry' }).click();
  await expect(findingCard).toHaveCount(0, { timeout: 30_000 });

  // 07: the history list again, now showing every run from this
  // walkthrough -- the bookend "completed" view for a product with no
  // project-level completion screen of its own any more.
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Run history' }),
  ).toBeVisible();
  for (const runId of [historyRunId, retryRunId, findingRunId]) {
    await expect(
      page.locator('.run-rail-item', { hasText: shortId(runId) }),
    ).toBeVisible({ timeout: 30_000 });
  }
  await capture(page, '07-run-history-complete.png');
});
