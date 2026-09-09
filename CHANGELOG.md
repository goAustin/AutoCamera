# Changelog

## Phase 7E step 3 review follow-up — deferred-run isolation, bounds, and signal

Evidence level: Offline fake. No provider call was made; every test runs
against `faux` or an injected `streamFnOverride` stub. Fixes the review
findings on step 3 that are not about tool design; the two tool-design defects
are planned separately in
`docs/75-PHASE-7E-STEP-3-FOLLOWUP-TOOL-USE.md` (W1/W2/W8) and are untouched
here.

- **The model call now runs with no transaction open at all.** Step 3 moved it
  out of the outbox *claim* transaction but still wrapped it in one of its own,
  so `withDatabaseTransaction` held a pooled client with `BEGIN` open across
  the whole provider round trip — only the first half of the
  `OutboxConsumer.afterCommit` contract in `packages/db/src/index.ts`, which
  names the claimed row's lock *and* the pooled connection.
  `completeRun` split into `runModel` (no repositories) and `persistOutcome`;
  `runDeferred` now runs three phases — a short transaction for the guards and
  evidence, the model call with nothing held, then a short transaction to
  persist. `faux` is unchanged: `completeRun` still composes both halves inside
  the caller's transaction.
- **The read tools each get their own short transaction** on the deferred path
  (`storeBackedServices`), so the agent loop holds no connection *between* tool
  calls either. `getExecutorReadiness` is the one remaining case that spans a
  network call, documented in place; it reaches ComfyUI rather than PostgreSQL
  and is bounded by `COMFY_REQUEST_TIMEOUT_MS`.
- **A failed deferred run is no longer silent.** The design deliberately leaves
  the run visibly `'running'` with nothing to retry, so that signal was the
  only one — and it reached nowhere: no logger on the adapter, no metric
  (`pi_agent_runs_total` is incremented inside `completeRun`, which never runs
  on that path), `BufferedSpan.setStatus` drops the error object, and with no
  OTLP endpoint no span is exported at all. `completeDeferredRun` now
  increments `pi_agent_runs_total{status="failure"}` and records `failureCode`
  as a span attribute.
- **`completeDeferredRun` cannot throw.** Its telemetry calls sat outside its
  own try/catch; a throw would have reached `pollOnce` and from there the
  outbox worker's unawaited `run()`. Span creation and the outcome record are
  both isolated now, and the span continues the trigger event's `traceId` like
  every other operator span instead of starting a detached trace.
- **The webhook no longer queues behind the model call.**
  `NotifyingOutboxConsumer.afterCommit` forwarded to the inner consumer first,
  so an `executor.unavailable` alert waited for an unrelated DeepSeek round
  trip. The two side effects are independent and now run concurrently under
  `Promise.allSettled`, with the forward wrapped so a throwing inner consumer
  is recorded on an `operator.notify.inner` span rather than escaping — the
  class doc claimed sole ownership of the "never throw" rule, which the
  unguarded forward had made false.
- **A run that keeps calling tools is now bounded by spend, not the wall
  clock.** Pi's loop already ends when the model stops calling tools
  (`dist/agent-loop.js:132`), the same condition Claude Code uses, so no turn
  cap is wanted; what it lacks is a bound on a model that does not stop.
  `maxRunCostMicrousd` (default 50,000 = $0.05, ~100x the recorded spike) and
  `maxRunTokens` (default 200,000) stop the run at the next turn boundary
  through Pi's `shouldStopAfterTurn` hook. The token limit is not redundant:
  a provider that reports no cost would disable the cost ceiling silently.
  Neither is wired to an environment variable yet.
- `processEvent` now documents that it is only the first half of a non-faux
  run — it returns no `recommendation` and leaves a `'running'` row that only
  `completeDeferredRun` finishes. Two integration tests call it directly and
  pass only because the default provider is `faux`.
- Telemetry note: `sanitizeTelemetryAttributes` silently drops keys outside its
  allowlist, and `SENSITIVE_ATTRIBUTE_KEY` rejects anything containing "token"
  as credential-shaped. The budget event therefore reports through the generic
  allowlisted `outcome`/`value`/`max` keys rather than extending the allowlist.
- 7 new tests, unit suite 210 to 217 across 25 files (no new file); integration
  unchanged at 18 across 10 files. Each of the 6 behavioural tests was checked
  against a simulated pre-fix build and fails there; the 7th is the negative
  control for the budget bound.

## Phase 7E step 3 — A real provider behind the per-incident operator

Evidence level: Offline fake for automated verification — every test in this
checkpoint runs against `faux` or an injected `streamFnOverride` stub, never
a paid call. No real DeepSeek request was made during this work; the
`deepseek-v4-flash` tool-calling spike recorded earlier in
`75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md` (3 runs, 13,488 tokens, $0.00135
total) is the only real-provider evidence this checkpoint relies on, and it
predates this change. `.env` on this workstation already carries
`PI_PROVIDER=deepseek`, `PI_MODEL=deepseek-v4-flash`, and a `DEEPSEEK_API_KEY`
— set by that earlier spike, not by this session — so `pnpm dev` will now
route real operator findings through DeepSeek the next time an operational
trigger fires; a real call was neither made nor required to finish this
checkpoint.

- Replaced the `PROVIDER_ERROR` throw for any non-faux provider
  (`operator.ts`, old `runPi:873-878`) with a real path: `runPi` now branches
  on `this.provider === 'faux'` (`operator.ts:643`) and, for anything else,
  resolves a model via `resolveHostedModel` (`operator.ts:1235`) — DeepSeek
  through `@earendil-works/pi-ai/providers/deepseek`'s `deepseekProvider()`
  registered into a fresh `createModels()`, or a test-only
  `streamFnOverride` when one is supplied, regardless of `this.provider`'s
  value. Unsupported provider strings still throw `PROVIDER_ERROR`.
- `PI_API_KEY` resolution moved into `packages/config` (`index.ts:120`):
  when `PI_PROVIDER=deepseek` and `PI_API_KEY` is unset, `DEEPSEEK_API_KEY`
  is the fallback, checked in both the "non-faux requires a key" validation
  and the resolved `ApiConfig.piApiKey`. The key is threaded through
  explicitly, on every stream call (`operator.ts`'s `streamFn` wrapper merges
  `apiKey: this.apiKey` into stream options), not read from `process.env` by
  the adapter or left to Pi's own ambient env lookup — so a `PI_API_KEY`
  without a matching `DEEPSEEK_API_KEY` still works, which ambient
  resolution alone would not have caught. `app.ts` now constructs the
  operational adapter from `config.piProvider` / `config.piModel` /
  `config.piApiKey` instead of a hardcoded `'faux'`. Fixed the stale
  `PI_MODEL` default (`h3-videoops-storyboard-v1`, a Phase 4 planner label
  meaningless after 7D) to `h3-videoops-operator-v1`; `.env.example` now
  documents the DeepSeek variables next to it.
- Output handling (`operator.ts:1271-1420`), settled by what Pi can actually
  do: `openai-completions` never sends `response_format`, and `ToolChoice`
  has no `"required"`, so neither API-level structured output nor a forced
  tool call is reachable. Added a terminal `submit_recommendation` tool
  (`createOperationalSubmissionTool`, `packages/agent-tools/src/index.ts`)
  whose TypeBox parameters are the recommendation schema and which returns
  `terminate: true`, in a **separate factory** from
  `createOperationalReadTools` so "the read tools are reads only" stays a
  property a test asserts, not a judgement call. Three-tier degradation: (1)
  `submit_recommendation` arguments, read straight off the tool-call content
  block (`submissionArguments`, `operator.ts:1301`) — no text parsing; (2)
  else tolerant extraction — strip fenced code blocks, scan for the last
  brace-balanced JSON object ignoring braces inside string literals
  (`stripFencedCodeBlocks` / `lastBalancedJsonObject`) — then the same
  strict `validateOperationalRecommendation`; (3) else throw
  `INVALID_STRUCTURED_OUTPUT`, which the existing `defaultOutput()` fallback
  in `completeRun` (old `processEventInTransaction`) already covers.
  `validateOperationalRecommendation` stays the sole authority at every
  tier — the tool schema steers the model, it never approves the result.
- Fixed the other three defects a real spike run surfaced against the old
  code, none of them DeepSeek's fault: the system prompt now states the
  five required fields and instructs a single `submit_recommendation` call
  (`OPERATIONAL_SYSTEM_PROMPT`, `operator.ts:1271`); the user prompt seeds
  the scoped `projectId`/`shotId`/`attemptId`/`workflowRevisionId` the
  adapter already holds instead of the old bare `Review durable event
  {id}.` (`operationalPrompt`, `operator.ts:1284`) — the tools still deny an
  out-of-scope identifier the model supplies regardless, so this narrows
  guessing, not scope.
- Moved the model call out of the outbox claim transaction, the prerequisite
  step 2 follow-up recorded and deferred here. `processEventInTransaction`
  now only resolves evidence and commits an `agent_runs` row with status
  `'running'` before returning (`operator.ts:576`, non-faux branch at
  `:643`); the model call, recommendation, `recommendation.created` event,
  and outbox enqueue all move into `completeDeferredRun`
  (`operator.ts:675`), which `OperationalOutboxConsumer.afterCommit` calls
  once the claim transaction has committed — never inside it. `faux` is
  exempt and keeps running synchronously in the claim transaction unchanged,
  since every existing test and the whole faux contract depends on that.
  `completeDeferredRun` re-checks the `existing` recommendation and the
  run's `'running'` status before proceeding, and — matching the
  `afterCommit` contract `NotifyingOutboxConsumer` established in step
  2 — never throws; a failure here leaves the run visibly `'running'`
  rather than losing it silently, deliberately preferring a visible stuck
  run over a duplicated paid model call. `NotifyingOutboxConsumer.afterCommit`
  (`notify.ts`) now forwards to `inner.afterCommit` first: without this fix,
  composing the webhook with a non-faux operator would have silently
  dropped the deferred model call.
- Verified against PostgreSQL
  (`apps/api/src/operator.deferred.integration.test.ts`, modeled on the
  step-2-follow-up webhook test): across two separate trigger events, a
  second connection's count of `'running'` `agent_runs` rows was `1` at the
  moment each model call started — proving the claim transaction had
  already committed by then, for both calls, not just the first.
- `agent_runs.provider` / `.model` were already persisted on `create()`
  (`packages/db/src/index.ts:2654`, columns `$7`/`$8`); this checkpoint
  exercises that path for a non-faux provider for the first time and adds
  the assertion.
- 20 new tests: 1 unit (`config.test.ts`, the four `PI_API_KEY` /
  `DEEPSEEK_API_KEY` combinations), 2 unit
  (`packages/agent-tools/src/operational.test.ts`, the submission tool and
  the read-tools-stay-read-only assertion), 8 unit (`operator.test.ts`, the
  non-faux paths above), 1 unit (`notify.test.ts`, the `afterCommit`
  forwarding fix), 1 PostgreSQL integration
  (`operator.deferred.integration.test.ts`). Unit suite 198 to 210 across 25
  files (no new unit file); integration 17 to 18 across 9 to 10 files.
- Not built here, staying step 4/5: `POST /v1/digest` and separating
  inference spend from attempt spend on `GET
  /v1/projects/:projectId/cost`.
- Recorded, not a defect: `.env`'s `DEEPSEEK_API_KEY` reaches the API server
  process for `pnpm dev` (`scripts/dev.ts` loads `.env` into `process.env`
  before spawning it) but not for `node dist/main.js` directly, which has no
  such loader. `~/.zshenv` (not `~/.zshrc`, which does not source for
  non-interactive shells) is the alternative for that path; nothing in this
  checkpoint changes server startup.

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
