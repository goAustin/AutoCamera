import { expect, test, type Page } from '@playwright/test';

// Coverage for `RunView`, mounted standalone at `/` via `StandaloneRunPage`
// with no ComfyUI origin present at all. `apps/web/src/App.tsx` carries the
// same recovery-path components (`AttemptCard`, `ArtifactPlayer`,
// `RecommendationPanel`, `RevisionHistory`, `EvaluationPanel`,
// `EventTimeline`, `ConfirmPanel`) that the legacy Studio in
// `project-studio.spec.ts` already exercises; this file proves the same
// underlying attempt lifecycle is reachable and actionable through the new
// run view instead. It ports that file's four behaviours (see the
// `describe` block referencing it below) and adds the new standalone-page
// coverage the 7D checkpoint requires. `project-studio.spec.ts` itself is
// left in place and still green -- this file only adds coverage.

const token = 'e2e-token';
const apiOrigin =
  process.env.E2E_API_ORIGIN ??
  `http://127.0.0.1:${process.env.E2E_API_PORT ?? '3300'}`;

function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Mirrors `apps/web/src/App.tsx`'s `shortRunId`, which is what the run list
// renders for each entry -- there is no other stable, visible handle to
// select a specific run once more than one exists.
function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

async function apiCall(
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly key?: string;
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
  expect(response.ok, `${path} -> ${JSON.stringify(payload)}`).toBe(true);
  return payload;
}

/**
 * `RunView` never exposes a shot or a project-creation form of its own --
 * that authoring surface lives only in the legacy Studio, which this
 * checkpoint keeps working but does not route through here. These tests
 * seed the durable core directly through the same REST endpoints the
 * legacy UI calls (`project-studio.spec.ts`'s own `apiJson` helper uses the
 * identical pattern for its infrastructure-failure case), then drive
 * `RunView` itself for every assertion the checkpoint actually cares about:
 * review, retry, playback, and findings.
 */
async function createApprovedShot(prefix: string): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = await apiCall('/v1/projects', {
    method: 'POST',
    key: `run-view-project-${suffix}`,
    body: {
      title: uniqueName(prefix),
      brief:
        'A premium product story with clear motion and natural stereo sound.',
      targetDurationSeconds: 15,
      budgetUsd: '25.00',
    },
  });
  const projectId = (created.project as Record<string, unknown>).id as string;
  const planned = await apiCall(`/v1/projects/${projectId}/plan`, {
    method: 'POST',
    key: `run-view-plan-${suffix}`,
  });
  const proposal = planned.proposal as Record<string, unknown>;
  const approved = await apiCall(
    `/v1/projects/${projectId}/storyboard/approve`,
    {
      method: 'POST',
      key: `run-view-approve-${suffix}`,
      body: { proposalId: proposal.id },
    },
  );
  const shots = approved.shots as ReadonlyArray<Record<string, unknown>>;
  const shotId = shots[0]?.id as string | undefined;
  if (!shotId) {
    throw new Error('Approving the storyboard did not materialize a shot.');
  }
  return shotId;
}

async function createScenarioAttempt(
  shotId: string,
  scenario?: string,
): Promise<Record<string, unknown>> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await apiCall(`/v1/shots/${shotId}/attempts`, {
    method: 'POST',
    key: `run-view-attempt-${suffix}`,
    body: scenario ? { scenario } : {},
  });
  return result.attempt as Record<string, unknown>;
}

/** Polls `GET /v1/runs` for the derived retry created from `sourceRunId`. */
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

async function enterRunView(page: Page): Promise<void> {
  await page.goto('/');
  // A prior call in the same test (e.g. a legacy-Studio detour) may have
  // already authenticated this session; the dev token lives in
  // `sessionStorage` and survives the navigation, so the token gate is
  // skipped entirely in that case.
  const tokenField = page.getByLabel('Development token');
  const heading = page.getByRole('heading', { name: 'Run history' });
  await expect(tokenField.or(heading)).toBeVisible({ timeout: 15_000 });
  if (await tokenField.isVisible()) {
    await tokenField.fill(token);
    await page.getByRole('button', { name: 'Enter Project Studio' }).click();
  }
  await expect(heading).toBeVisible();
  // Confirms this is `StandaloneRunPage`, not the ComfyUI-embedded
  // `ManagedPanelPage`: the eyebrow text differs and only one of the two
  // ever renders outside an iframe with the managed bridge query params.
  await expect(page.getByText('VIDEOOPS / RUN VIEW')).toBeVisible();
  expect(new URL(page.url()).searchParams.has('videoopsManaged')).toBe(false);
}

function selectedRunDetail(page: Page) {
  return page.locator('section[aria-labelledby="managed-detail-title"]');
}

async function selectRun(page: Page, runId: string): Promise<void> {
  await expect(
    page.locator('.managed-run-item', { hasText: shortId(runId) }),
  ).toBeVisible({ timeout: 30_000 });
  await page.locator('.managed-run-item', { hasText: shortId(runId) }).click();
  await expect(selectedRunDetail(page).getByText(runId)).toBeVisible({
    timeout: 30_000,
  });
}

test.describe('RunView, ported from project-studio.spec.ts', () => {
  // These four cases port the coverage at e2e/project-studio.spec.ts:133,
  // :166, :214, and :240 so it exists against RunView before that spec is
  // ever deleted. The original spec is untouched and still runs.

  test('lists a run through review with state reconstructed after refresh', async ({
    page,
  }) => {
    const shotId = await createApprovedShot('Run view happy path');
    const attempt = await createScenarioAttempt(shotId);
    const runId = attempt.id as string;

    await enterRunView(page);
    await selectRun(page, runId);
    const card = selectedRunDetail(page).locator('.attempt-card');
    await expect(
      card.getByText('Awaiting Review', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText('Passed', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(card.locator('video.artifact-player')).toBeVisible();

    await card.getByRole('button', { name: 'Accept passing attempt' }).click();
    await expect(card.getByText('Accepted', { exact: true })).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Run history' }),
    ).toBeVisible();
    await expect(selectedRunDetail(page).getByText(runId)).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      selectedRunDetail(page)
        .locator('.attempt-card')
        .getByText('Accepted', { exact: true }),
    ).toBeVisible();
  });

  test('rejects an attempt, derives a retry, and accepts the replacement', async ({
    page,
  }) => {
    const shotId = await createApprovedShot('Run view retry');
    const attempt = await createScenarioAttempt(shotId);
    const runId = attempt.id as string;

    await enterRunView(page);
    await selectRun(page, runId);
    const card = selectedRunDetail(page).locator('.attempt-card');
    await expect(
      card.getByText('Awaiting Review', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText('Passed', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await card.getByRole('button', { name: 'Reject' }).click();
    await card.getByLabel('Review reason code').fill('TOO_DARK');
    await card.getByRole('button', { name: 'Reject attempt' }).click();
    await expect(card.getByText('Rejected', { exact: true })).toBeVisible();

    await card.getByRole('button', { name: 'Retry with confirmation' }).click();
    await expect(
      page.getByRole('alertdialog', {
        name: 'Spend budget on a derived retry?',
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Confirm retry' }).click();

    const retryRunId = await findRetryRunId(runId);
    await selectRun(page, retryRunId);
    const retryCard = selectedRunDetail(page).locator('.attempt-card');
    await expect(
      retryCard.getByText('Awaiting Review', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(retryCard.getByText('Passed', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await retryCard
      .getByRole('button', { name: 'Accept passing attempt' })
      .click();
    await expect(
      retryCard.getByText('Accepted', { exact: true }),
    ).toBeVisible();
  });

  test('an invalid graph creates no attempt, so no new run surfaces here either', async ({
    page,
  }) => {
    // RunView has no workflow-authoring surface: submitting a graph at all
    // is only reachable through the legacy Studio (kept working, unmodified,
    // by this checkpoint). What this test proves against RunView is the
    // invariant the original case protects -- an invalid revision creates no
    // attempt -- by showing the run list RunView reads from gains no entry.
    const before = await apiCall('/v1/runs?limit=50');
    const beforeCount = (before.runs as ReadonlyArray<unknown>).length;

    await page.goto('/projects');
    await page.getByLabel('Development token').fill(token);
    await page.getByRole('button', { name: 'Enter Project Studio' }).click();
    await expect(
      page.getByRole('heading', { name: 'Projects that stay explainable.' }),
    ).toBeVisible();
    await page.getByLabel('Project title').fill(uniqueName('Run view invalid'));
    await page
      .getByLabel('Creative brief')
      .fill(
        'A premium product story with clear motion and natural stereo sound.',
      );
    await page.getByLabel('Target duration (seconds)').fill('15');
    await page.getByLabel('Budget (USD)').fill('25.00');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(
      page.getByRole('heading', { name: 'Storyboard' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Plan with Pi' }).click();
    await expect(page.getByText('Ready for human approval')).toBeVisible();
    await page.getByRole('button', { name: 'Approve storyboard' }).click();
    await expect(
      page.getByText('The storyboard is approved.', { exact: false }),
    ).toBeVisible();
    await page.getByRole('link', { name: /Shot 01/ }).click();
    await expect(
      page.getByRole('heading', { name: 'Shape the managed graph' }),
    ).toBeVisible();
    await page.getByLabel('Width').fill('950');
    await page
      .getByRole('button', { name: 'Create revision & validate' })
      .click();
    await expect(
      page.getByText('saved with validation errors', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Generate managed' }),
    ).toBeDisabled();
    await expect(page.getByText('No managed attempts')).toBeVisible();

    const after = await apiCall('/v1/runs?limit=50');
    const afterCount = (after.runs as ReadonlyArray<unknown>).length;
    expect(afterCount).toBe(beforeCount);

    await enterRunView(page);
    await expect(
      page.getByRole('heading', { name: 'History', exact: true }),
    ).toBeVisible();
  });

  test('surfaces a recoverable infrastructure failure and requires explicit retry confirmation', async ({
    page,
  }) => {
    const shotId = await createApprovedShot('Run view infra recovery');
    const attempt = await createScenarioAttempt(shotId, 'execution-failure');
    const runId = attempt.id as string;

    await enterRunView(page);
    await selectRun(page, runId);
    const card = selectedRunDetail(page).locator('.attempt-card');
    await expect(card.getByText('Failed', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(card.getByText('COMFY_EXECUTION_FAILED')).toBeVisible();

    await card.getByRole('button', { name: 'Retry with confirmation' }).click();
    await expect(
      page.getByRole('alertdialog', {
        name: 'Spend budget on a derived retry?',
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Confirm retry' }).click();

    const retryRunId = await findRetryRunId(runId);
    await selectRun(page, retryRunId);
    const retryCard = selectedRunDetail(page).locator('.attempt-card');
    await expect(
      retryCard.getByText('Awaiting Review', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(retryCard.getByText('Passed', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await retryCard
      .getByRole('button', { name: 'Accept passing attempt' })
      .click();
    await expect(
      retryCard.getByText('Accepted', { exact: true }),
    ).toBeVisible();
  });
});

test.describe('StandaloneRunPage with no ComfyUI origin present', () => {
  test('lists runs, plays an artifact, retries a timed_out attempt, and applies a finding', async ({
    page,
  }) => {
    // A shot only accepts a new attempt while it is
    // `approved_for_generation`, `rejected`, or `retryable`
    // (`apps/api/src/generation.ts`), and creating an attempt moves it out of
    // that set until the attempt reaches a terminal status. Each attempt
    // below therefore gets its own freshly approved shot rather than sharing
    // one, mirroring how each `POST /v1/runs` submission gets its own
    // implicit shot in the real flow.
    const playableShotId = await createApprovedShot('Standalone run view');
    const playable = await createScenarioAttempt(playableShotId, 'success');
    const playableRunId = playable.id as string;

    const manualRetryShotId = await createApprovedShot(
      'Standalone run view retry',
    );
    const manualRetrySource = await createScenarioAttempt(
      manualRetryShotId,
      'timeout',
    );
    const manualRetryRunId = manualRetrySource.id as string;

    const findingShotId = await createApprovedShot(
      'Standalone run view finding',
    );
    const findingSource = await createScenarioAttempt(findingShotId, 'timeout');
    const findingRunId = findingSource.id as string;

    await enterRunView(page);

    // Lists runs: all three just-seeded runs are reachable from the list.
    for (const runId of [playableRunId, manualRetryRunId, findingRunId]) {
      await expect(
        page.locator('.managed-run-item', { hasText: shortId(runId) }),
      ).toBeVisible({ timeout: 30_000 });
    }

    // Plays an artifact.
    await selectRun(page, playableRunId);
    const playableCard = selectedRunDetail(page).locator('.attempt-card');
    await expect(
      playableCard.getByText('Awaiting Review', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(playableCard.locator('video.artifact-player')).toBeVisible();

    // Retries a timed_out attempt.
    await selectRun(page, manualRetryRunId);
    const timedOutCard = selectedRunDetail(page).locator('.attempt-card');
    await expect(
      timedOutCard.getByText('Timed Out', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(timedOutCard.getByText('GENERATION_TIMEOUT')).toBeVisible();
    await timedOutCard
      .getByRole('button', { name: 'Retry with confirmation' })
      .click();
    await expect(
      page.getByRole('alertdialog', {
        name: 'Spend budget on a derived retry?',
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Confirm retry' }).click();
    const retryRunId = await findRetryRunId(manualRetryRunId);
    await selectRun(page, retryRunId);
    await expect(
      selectedRunDetail(page)
        .locator('.attempt-card')
        .getByText('Awaiting Review', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    // Applies a finding. Findings are scoped to the project, so
    // `findingSource`'s run must be selected first; its own
    // `attempt.timed_out` event is what the running operational worker
    // (`startOperationalWorker: true` in `apps/api/src/app.ts`) turns into
    // this recommendation.
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
    await page.getByRole('button', { name: 'Apply and retry' }).click();
    await expect(findingCard).toHaveCount(0, { timeout: 30_000 });
  });
});
