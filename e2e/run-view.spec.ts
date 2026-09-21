import { expect, test, type Page } from '@playwright/test';

// Coverage for `RunView`, mounted standalone at `/` via `StandaloneRunPage`
// with no ComfyUI origin present at all. `apps/web/src/App.tsx` carries the
// same recovery-path components (`RunDetailColumn` and its
// `AttemptActionBar` / `AttemptGates` / `AttemptDetail` parts, `ArtifactPlayer`,
// `RecommendationPanel`, `RevisionHistory`, `EvaluationPanel`,
// `EventTimeline`, `ConfirmPanel`) that the legacy Studio in the
// now-deleted `project-studio.spec.ts` used to exercise; this file ports
// that spec's four behaviours (see the `describe` block referencing it
// below) against the new run view instead, and adds the new
// standalone-page coverage the Phase 7D checkpoint requires. Phase 7D step
// 3 removed the legacy Studio screens themselves (`ProjectListPage`,
// `ProjectStudioPage`, `StoryboardSection`, `ShotWorkspace`, and the
// `/plan` and `/storyboard/approve` routes their fixtures used to call),
// so shot seeding below goes through `POST /v1/runs` with a deliberately
// invalid graph instead -- the durable core's only remaining way to
// materialize an implicit shot without also queuing an attempt on it.

const token = 'e2e-token';
const apiOrigin =
  process.env.E2E_API_ORIGIN ??
  `http://127.0.0.1:${process.env.E2E_API_PORT ?? '3300'}`;

function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Mirrors `@h3/ui`'s `shortId` at its default head/tail, which is what the
// rail and the run header render for every entry -- there is no other
// stable, visible handle to select a specific run once more than one exists.
function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

async function apiCall(
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly key?: string;
    /** Set to a specific status to assert a deliberately-failing call instead of a 2xx. */
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
 * `RunView` never exposes a shot or a project-creation form of its own --
 * that authoring surface does not exist anywhere any more; Phase 7D removed
 * the planner UI and `POST /v1/projects/:projectId/plan` and
 * `.../storyboard/approve` along with it. These tests seed the durable core
 * directly through the REST endpoints that remain: create a project, then
 * submit `POST /v1/runs` with a graph that fails validation. That still
 * creates the project's implicit shot (and a `shot.created` domain event)
 * without ever reaching attempt creation, leaving the shot
 * `approved_for_generation` -- the same invariant the "invalid graph creates
 * no attempt" test below now verifies directly. `GET .../events` is the only
 * remaining way to recover the shot's id, since shots are never listed.
 * `createScenarioAttempt` then drives `POST /v1/shots/:shotId/attempts`
 * itself for every assertion the checkpoint actually cares about: review,
 * retry, playback, and findings.
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
  await apiCall('/v1/runs', {
    method: 'POST',
    key: `run-view-seed-run-${suffix}`,
    body: { projectId, editorGraph: {}, apiGraph: {} },
    expectStatus: 422,
  });
  const events = await apiCall(`/v1/projects/${projectId}/events`);
  const shotCreated = (
    events.events as ReadonlyArray<Record<string, unknown>>
  ).find((event) => event.type === 'shot.created');
  const shotId = shotCreated?.shotId as string | undefined;
  if (!shotId) {
    throw new Error('Expected a shot.created event with a shotId.');
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

test.describe('RunView, ported from project-studio.spec.ts', () => {
  // These four cases ported the coverage that used to live at
  // e2e/project-studio.spec.ts:133, :166, :214, and :240. That spec is now
  // deleted (Phase 7D step 3): its four behaviours were confirmed passing
  // here first, against RunView, before it was removed.

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
    await expect(
      card.locator('video[aria-label="Generated artifact"]'),
    ).toBeVisible();

    await selectedRunDetail(page)
      .getByRole('button', { name: 'Accept passing attempt' })
      .click();
    await expect(card.getByText('Accepted', { exact: true })).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Run history' }),
    ).toBeVisible();
    await expect(selectedRunDetail(page).getByText(shortId(runId))).toBeVisible(
      {
        timeout: 30_000,
      },
    );
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

    // Accept / Reject / Derive retry live in the sticky header now, not
    // inside the attempt card; the reject reason form is a body sibling.
    const detail = selectedRunDetail(page);
    await detail.getByRole('button', { name: 'Reject' }).click();
    await detail.getByLabel('Review reason code').fill('TOO_DARK');
    await detail.getByRole('button', { name: 'Reject attempt' }).click();
    await expect(card.getByText('Rejected', { exact: true })).toBeVisible();

    await detail.getByRole('button', { name: 'Derive retry' }).click();
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
    await selectedRunDetail(page)
      .getByRole('button', { name: 'Accept passing attempt' })
      .click();
    await expect(
      retryCard.getByText('Accepted', { exact: true }),
    ).toBeVisible();
  });

  test('an invalid graph creates no attempt, so no new run surfaces in RunView either', async ({
    page,
  }) => {
    // RunView has no workflow-authoring surface, and Phase 7D removed the
    // legacy Studio screens that used to have one (they drove this same
    // invariant through a UI form). `POST /v1/runs` is now the only
    // graph-submission path in the tree, so submit an invalid graph directly
    // through it -- proving the original case's invariant, that an invalid
    // revision creates no attempt, at the layer that actually enforces it --
    // then confirm the run list RunView reads from gains no entry either.
    const before = await apiCall('/v1/runs?limit=50');
    const beforeCount = (before.runs as ReadonlyArray<unknown>).length;

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const created = await apiCall('/v1/projects', {
      method: 'POST',
      key: `run-view-invalid-project-${suffix}`,
      body: {
        title: uniqueName('Run view invalid'),
        brief:
          'A premium product story with clear motion and natural stereo sound.',
        targetDurationSeconds: 15,
        budgetUsd: '25.00',
      },
    });
    const projectId = (created.project as Record<string, unknown>).id as string;
    const invalid = await apiCall('/v1/runs', {
      method: 'POST',
      key: `run-view-invalid-run-${suffix}`,
      body: { projectId, editorGraph: {}, apiGraph: {} },
      expectStatus: 422,
    });
    expect(invalid.runId).toBeNull();
    const validation = invalid.validation as Record<string, unknown>;
    expect(validation.status).toBe('invalid');
    expect(
      (validation.errors as ReadonlyArray<unknown>).length,
    ).toBeGreaterThan(0);

    const after = await apiCall('/v1/runs?limit=50');
    const afterCount = (after.runs as ReadonlyArray<unknown>).length;
    expect(afterCount).toBe(beforeCount);

    await enterRunView(page);
    // The rail is a landmark (`aria-label="Run history"`), not a heading --
    // the grouped/tabbed rail has no single "History" heading any more.
    await expect(
      page.getByRole('complementary', { name: 'Run history' }),
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

    await selectedRunDetail(page)
      .getByRole('button', { name: 'Derive retry' })
      .click();
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
    await selectedRunDetail(page)
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
        page.locator('.run-rail-item', { hasText: shortId(runId) }),
      ).toBeVisible({ timeout: 30_000 });
    }

    // Plays an artifact.
    await selectRun(page, playableRunId);
    const playableCard = selectedRunDetail(page).locator('.attempt-card');
    await expect(
      playableCard.getByText('Awaiting Review', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      playableCard.locator('video[aria-label="Generated artifact"]'),
    ).toBeVisible();

    // Retries a timed_out attempt.
    await selectRun(page, manualRetryRunId);
    const timedOutCard = selectedRunDetail(page).locator('.attempt-card');
    await expect(
      timedOutCard.getByText('Timed Out', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(timedOutCard.getByText('GENERATION_TIMEOUT')).toBeVisible();
    await selectedRunDetail(page)
      .getByRole('button', { name: 'Derive retry' })
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
