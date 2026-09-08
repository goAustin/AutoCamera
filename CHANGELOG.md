# Changelog

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
