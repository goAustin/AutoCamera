# Changelog

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
