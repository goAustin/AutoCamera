# Changelog

## Phase 7E step 2 follow-up — delivery leaves the outbox transaction

Evidence level: Offline fake. No provider call was made. Resolves the
"Recorded, not fixed" item in the step 2 entry below. No change to the
operator, the trigger set, the isolation rule, leases, retries,
reconciliation, evaluation, SSE transport, or the metric allowlist.

- `OutboxConsumer` gains an optional `afterCommit(message)`
  (`packages/db/src/index.ts:5091`), which `OutboxDispatcher.pollOnce` calls
  after `withTransaction` resolves and only for a message that committed as
  delivered. `NotifyingOutboxConsumer.consume` is now a pass-through to the
  operator and the webhook POST moved to `afterCommit`, so the round trip
  holds no open transaction, no pooled connection, and no lock on the
  claimed outbox row. The finding's title and detail are read back through a
  short transaction of the consumer's own — a `store`, newly passed from
  `app.ts` — instead of borrowing the claim transaction.
- Two properties come free with the reordering. A notification can no longer
  announce a finding that rolled back: `afterCommit` runs only on the
  delivered path, where the pre-fix code delivered from inside a transaction
  that might still fail to commit. And `OperationalOutboxWorker.run`, which
  polls serially, no longer queues every operational message behind one slow
  webhook.
- Contract, normative: `afterCommit` must not throw. The message is already
  delivered, so there is nothing for the outbox to retry, and
  `NotifyingOutboxConsumer` stays the single owner of swallowing — the same
  rule step 2 established for delivery failures, applied one step later.
- Verified against PostgreSQL (`apps/api/src/notify.integration.test.ts`):
  while the webhook is being called, a second connection already counts the
  finding as committed, for both the `executor.unavailable` and the
  `recommendation.created` message. The same measurement read zero before
  this change. The test records every delivery rather than only the last,
  which is what makes it fail under the old ordering — proven by mutation:
  restoring the in-transaction call yields `[0, 1]` against an expected
  `[1]`.
- Not fixed, and now step 3's: the operator's own provider call still runs
  inside the claim transaction. `agentRuns.create` commits before `runPi`
  (`operator.ts:679` and `operator.ts:696`), so moving the model call out is
  a multi-transaction run state machine — the in-flight run row committed
  before the call, updated after — not a reordering. Against `faux` that
  buys nothing measurable, so it is specified in step 3 rather than designed
  here.
- Three new tests: 2 unit (`notify.test.ts`), 1 PostgreSQL integration.
  Unit suite 196 to 198 across 25 files; integration 16 to 17 across 8 to 9
  files.

## Phase 7E step 2 — A finding reaches a webhook without the panel

Evidence level: Offline fake. No provider call was made; the operator still
runs against `faux`. Additive only, composed alongside the existing outbox
consumer only when configured — no code change to the worker, leases,
retries, reconciliation, evaluation, SSE transport, or the metric
allowlist. A configured webhook does change the worker's timing; that is
recorded below, not fixed here.

- Added `NotifyingOutboxConsumer` (`apps/api/src/notify.ts`), wrapping the
  existing `OperationalOutboxConsumer` behind the single `OutboxDispatcher`
  when `NOTIFY_WEBHOOK_URL` is configured. Isolation rule, normative: the
  operator's `consume()` runs first and is authoritative — its errors still
  propagate so the outbox retries the message — and the notifier's errors
  are caught, recorded on an `operator.notify` telemetry span, and
  swallowed. A failed webhook call therefore never fails the outbox message
  and never re-runs the operator (a second paid inference call, once a real
  provider lands) for the same event. Verified with a permanently
  unreachable webhook: the finding still commits, the operator runs exactly
  once, and the outbox still drains.
- Notifies on `recommendation.created`, `project.budget_denied`, and
  `executor.unavailable`; no success event is notified.
  `project.budget_denied` is not in `OPERATIONAL_TRIGGER_EVENT_TYPES`, so a
  webhook is the only way it reaches an operator who is not polling.
  `executor.unavailable` is notified twice by design — once as the raw
  trigger, again once its `recommendation.created` finding exists.
- `WebhookNotificationDelivery` POSTs one bounded JSON body with a
  configurable timeout: `NOTIFY_WEBHOOK_URL` (unset disables notification
  entirely), `NOTIFY_TIMEOUT_MS` (default 5000). Unset leaves the dispatcher
  byte-for-byte the pre-step-2 consumer, not merely a no-op wrapper. Works
  with ntfy, Slack, Discord, or a local listener; no SMTP dependency.
- Redaction: every text field in the notification body is run through the
  existing `safeRecommendationText` (now exported from `operator.ts`, the
  same sanitizer already relied on for persisted recommendation
  title/detail), and a `recommendation.created` body looks up the finding's
  title and detail so the notification reads as something other than a bare
  identifier dump. Verified with a seeded recommendation whose detail
  contains a bearer token, a `token=` credential, and a filesystem path:
  none of the three raw values reach the delivered body.
- Recorded, not a hostname filter: `safeRecommendationText` has no
  hostname-matching rule — its bearer, credential, path, and prompt patterns
  do not cover a bare private hostname embedded in free text. Nothing in
  this codebase writes a hostname into recommendation title/detail today, so
  this is a latent gap for whatever step 3's real model produces, not a
  regression.
- Recorded, not fixed — delivery runs inside the outbox transaction.
  `OutboxDispatcher.pollOnce` (`packages/db/src/index.ts:5100`) wraps
  `consume()` in `store.withTransaction`, so the webhook POST executes
  between `BEGIN` and `COMMIT`. Measured against the live database with a
  600ms stub webhook: a second connection counted zero
  `operational_recommendations` rows mid-delivery and one after, and
  `pollOnce()` took 680ms. A pooled connection therefore sits
  idle-in-transaction holding the claimed outbox row for the whole round
  trip, and because `OperationalOutboxWorker.run` polls serially, a slow
  webhook is head-of-line blocking for the whole operational outbox — up
  to `NOTIFY_TIMEOUT_MS` per notifiable message, two messages per
  finding, and the config admits 120_000. `stop()` awaits `currentWork`,
  so shutdown inherits the same delay. Delivery also fires before the
  commit, so a transaction that then fails to commit has already sent a
  notification for a finding that rolled back, and the retry sends a
  second one. None of this violates the isolation rule, which fixed
  whether a notifier failure propagates, not when delivery runs. Deferred
  to step 3 rather than fixed here: the fix is a post-commit hand-off,
  and step 3 forces that work anyway — `runPi` (`operator.ts:696`) is
  called from inside the same transaction, so a real provider puts a
  multi-second inference call between the same `BEGIN` and `COMMIT`,
  against which the notifier's 5s is the smaller half.
- Prerequisite finding from step 1, resolved: deleted the `UNIQUE_VIOLATION`
  recovery branch (old `operator.ts:776-798`), dead code on PostgreSQL
  because `PostgresOperationalRecommendationRepository.create` does not
  translate `23505` and `withDatabaseTransaction` has no `SAVEPOINT` to
  survive it. A genuine collision now aborts the transaction and relies on
  retry, which the code already did correctly by falling through to the
  `existing` check. Added the PostgreSQL-side test step 1 could not write
  (`apps/api/src/operator.integration.test.ts`): it forces a real `create()`
  call to collide with an already-committed row, asserts the raw error
  carries Postgres code `23505`, and asserts a subsequent retry resolves to
  the committed winner without a second event or a second model run.
  Rewrote the corresponding unit test in `operator.test.ts`, which exercised
  the now-deleted branch, to the same shape against `InMemoryStore`.
- Fifteen new tests: 13 unit (`notify.test.ts`), 1 unit (`config.test.ts`,
  the `NOTIFY_WEBHOOK_URL`/`NOTIFY_TIMEOUT_MS` config surface), 1 PostgreSQL
  integration. The `operator.test.ts` UNIQUE_VIOLATION test was rewritten in
  place, not added. Unit suite 182 to 196 across 24 to 25 files; integration
  suite 15 to 16 across 7 to 8 files.

## Phase 7E step 1 — A finding enters the timeline

Evidence level: Offline fake. No provider call was made; the operator still
runs against `faux`. Additive only — no change to the worker, leases, retries,
reconciliation, evaluation, SSE transport, or the metric allowlist.

- The operator now emits `recommendation.created` when it persists a finding,
  carrying `{ recommendationId, severity, recommendationCode,
  proposedActionType, triggeringEventType }`. Until now a finding was written
  to `operational_recommendations` and announced nowhere: it never reached
  `domain_events`, never reached `outbox_events`, and was visible only to a
  client polling the recommendations route. On a rented GPU running
  asynchronously, nobody is polling.
- The event is emitted once per persisted finding, inside the same transaction,
  and only after the insert succeeds — neither duplicate path announces a
  finding twice. `domain_events` is append-only, so an emit on the duplicate
  path would append another announcement on every outbox retry of the same
  message.
- `recommendation.created` is deliberately absent from
  `OPERATIONAL_TRIGGER_EVENT_TYPES`; a test proves the operator returns
  `not_trigger` for its own output rather than looping on it. This is free
  today under `faux` and will not be once a paid provider is wired in.
- Five unit tests and one PostgreSQL integration test. Each was verified by
  mutation — breaking the implementation fails them — including the SSE test,
  which guards an allowlist (`SSE_PAYLOAD_KEYS`) that drops unregistered
  payload keys silently. Unit suite 177 to 182; integration suite 14 to 15.
- Recorded, not fixed: the `UNIQUE_VIOLATION` recovery branch at
  `operator.ts:776-798` is unreachable under PostgreSQL. The repository does
  not translate `23505` into a `RepositoryError`, and the transaction is
  aborted by the violation regardless, so the recovery query inside the catch
  would fail with `25P02`. A collision still resolves correctly by retry, and
  the branch predates this checkpoint. The test covering it is meaningful only
  as a guard on the emit's placement, not as proof the branch works.

## Unreleased — correctness and documentation

Evidence level: Offline fake. No behaviour change to the durable core beyond
the evaluator fix below.

- Fixed the media evaluator's motion check, which could not fail.
  `blackdetect` and `freezedetect` report at info level while the probe ran at
  `-v error`, so their output never reached the parser and any artifact that
  decoded was recorded as having motion. An all-black clip passed. The probe
  now runs at info, and a `freeze_start` with no duration — what a clip frozen
  through to end-of-file produces — counts as evidence on its own.
- Fixed the browser suite overwriting published evidence. Three specs wrote
  captures straight into the tracked `assets/screenshots/`, so an ordinary
  `pnpm test:e2e` rewrote 12 published images, including the README's. Captures
  now go to the ignored `test-results/` tree unless `CAPTURE_EVIDENCE=1`.
- Fixed `01-editor-loaded.png` capturing the ComfyUI splash screen instead of
  the editor. `#splash-loader` covers the canvas until the Vue app mounts, and
  `app.rootGraph` is populated before it clears, so waiting on the JS objects
  alone photographed the splash. The failure was order-dependent and appeared
  only in the full suite. Every capture is now size-checked.
- Removed `comfy-frontend/03-graph-to-prompt.png`. `app.graphToPrompt()` is a
  pure read with no visual effect, so its capture was the same image as
  `02-h3-template-open.png` by construction. The export assertion remains;
  only the duplicate image is gone. Published captures: 13 to 12.
- Fixed a Phase 7A integration assertion that expected `acceptedAttemptId`
  after a run was reviewed `rejected` and pinned. Pin sets `pinnedAttemptId`;
  only human acceptance sets `acceptedAttemptId`. The test contradicted the
  design it was testing.
- Rewrote `README.md` for users rather than reviewers, moved `RESUME.md` out of
  the tracked tree, reframed `EVIDENCE-MANIFEST.md` as release provenance, and
  brought `STATUS.md` up to date. `validate-docs.ts` no longer requires
  completed-phase phrases that went stale as soon as the next checkpoint
  landed, and now requires every capture to be accounted for in the provenance
  manifest rather than enumerated in the README.
- Cleared the `format:check` baseline, which had been failing on five files and
  taking `pnpm check` and `pnpm release:verify` down with it.

## Phase 7D — Remove the brief-first product

Evidence level: Offline fake. The creative-brief workflow is gone. What remains
is a durable execution and monitoring record for a ComfyUI executor running on
a separate GPU host. Net -5,561 lines, with no change to the durable core.

**Breaking — removed API routes.** Ten registrations:

- `POST   /v1/projects/:projectId/plan`
- `GET    /v1/projects/:projectId/storyboard`
- `POST   /v1/projects/:projectId/storyboard/approve`
- `GET    /v1/projects/:projectId/shots`
- `GET    /v1/projects/:projectId/shots/:shotId/workflow-draft`
- `PUT    /v1/projects/:projectId/shots/:shotId/workflow-draft`
- `GET    /v1/projects/:projectId/shots/:shotId/workflow-revisions`
- `POST   /v1/projects/:projectId/shots/:shotId/workflow-revisions`
- `POST   /v1/projects/:projectId/shots/:shotId/managed-attempts`
- `POST   /v1/attempts/:attemptId/regenerate`

`POST /v1/shots/:shotId/attempts` is unaffected, as are the revision-scoped
`GET /v1/workflow-revisions/:revisionId` and its `/validate`.

- Extracted `RunView` as a single implementation used by both the ComfyUI
  sidebar panel and the standalone route, carrying playback, retry, findings,
  and the recovery path.
- Deleted the Pi planning agent, the `PlanningAgent` interface,
  `StaticStoryboardPlanner`, the storyboard domain and repository types, and
  nine web components.
- Added migration `0009`, which drops the `0006` CHECK constraint first —
  it references the column being dropped — then converts non-implicit shots to
  implicit rather than dropping them, preserving each row with its attempts and
  events.
- Kept deliberately: `POST /v1/projects` with `budgetUsd` and its `/cost`
  route, the only way to arm cost enforcement against a metered GPU;
  `apps/fake-comfy` and `COMFY_MODE=fake`, which is the entire local loop on a
  workstation with no GPU; the evaluator; the operator adapter; telemetry; the
  three audit invariants; and `agent_runs`.
- The five planner-era strings remain in `DOMAIN_EVENT_TYPES`. `domain_events`
  is append-only and `parseDomainEventType` throws on an unknown value, so
  removing them would not delete old rows — it would make them unreadable,
  taking the event timeline and SSE replay with them. The emitters are gone;
  the strings are a retention schema, not an API surface.

## Phase 7C — ComfyUI-first plugin inversion

Evidence level: Offline fake. ComfyUI is the graph-shell entry point and the
VideoOps panel is an exact-origin Studio iframe. The integration now exposes a
managed Run action, run history/detail, pin/review, findings, revision restore,
and read-only status surfaces while keeping the bearer token in Studio.

- Added the inverted child/parent bridge contract with origin, nonce, replay,
  payload-size, and credential-field validation.
- Added the pinned-frontend plugin surfaces and native queue refusal without
  monkey-patching unsupported frontend internals.
- Added the ComfyUI-first browser acceptance test and screenshots.
- Kept the standalone Studio fallback and Phase 5 routes available.

Known limitation: the pinned frontend exposes no supported queue interception
hook and its topbar badge metadata is static. Native queue controls are
disabled; live status values are carried through the Studio-fed bottom-panel
bridge. Remote ComfyUI compatibility and real H3 GPU generation remain
deferred to Phase 8.

## v0.1.0-mvp — Phase 6 Offline fake release

Evidence level: Offline fake. The release demonstrates the deterministic fake
ComfyUI path through Project Studio, VideoOps durable orchestration, immutable
workflow revisions, queue leases, recovery, artifact evaluation, human review,
Pi recommendations, tracing, bounded metrics, and browser E2E.

- Added a deterministic seed/reset workflow and a five-minute demo.
- Added redacted distributed telemetry, Prometheus metrics, and an optional
  pinned local observability stack.
- Added architecture, dependency/pin, evidence, status, and resume records.
- Added eight deterministic offline screenshots and a manifest.
- Preserved explicit fake and remote executor modes and the private worker-only
  execution boundary.

### Known limitations

- The pinned live ComfyUI backend/frontend contract was SKIP in this
  environment because no remote executor was configured.
- No real MiniMax H3 clip was generated; model weights and GPU runtime are not
  bundled. Both remote contract validation and real H3 smoke are deferred to
  Phase 8.
- Fake output is not a quality, latency, throughput, VRAM, or cost benchmark.
- Billing, production multitenancy, autoscaling, SLOs, Kubernetes, and public
  production readiness are out of scope.
- The project is private and no project license has been selected yet.

### Migration and upgrade notes

This release uses the existing forward-only database migrations, including the
Phase 5 workflow/revision and operational-state migrations. Run pnpm db:migrate
against the intended development database before starting the API. Do not
delete PostgreSQL volumes or artifact roots during a routine observability
shutdown. Use pnpm demo:reset -- --force only after reviewing its printed
demo-only target.

### Verification

The exact command matrix and pass/fail/skip counts are recorded in the final
handoff and STATUS.md. The live contract remains a skip rather than a pass; no
H3 evidence is inferred from fake execution.
