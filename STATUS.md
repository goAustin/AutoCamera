# Status

Evidence level: **Offline fake**. No real MiniMax H3 clip has been generated,
and no remote executor has been exercised in this environment.

## What is implemented

The durable control plane is complete and tested: PostgreSQL as the authority
for business state, immutable server-hashed workflow revisions pinned to the
executor capability fingerprint, reclaimable queue leases, retry lineage,
reconciliation of duplicate and uncertain executor events, deterministic media
evaluation, authorized byte-range artifact delivery, an append-only domain
event timeline over REST and SSE, and trace propagation across worker, outbox,
executor observation, and stream boundaries.

ComfyUI is the entry point. The VideoOps panel mounts inside it as a
Studio-origin iframe, native browser queueing is refused, and a loaded graph is
submitted through one managed `POST /v1/runs`. The VideoOps bearer token never
enters the ComfyUI origin. A standalone run view remains available at `/` for
use when no ComfyUI host is running, which is the normal case on a rented GPU
whose host is destroyed between sessions.

The brief-first workflow — planner, storyboard approval, and the per-shot
authoring screens — has been removed. What remains is a durable execution and
monitoring record for a ComfyUI executor running on a separate GPU host.

The Pi operator adapter is read-only, bounded, and human-gated: it proposes,
and a person applies or dismisses. A finding now emits `recommendation.created`
into the durable timeline and the outbox, so it reaches a reader who is not
watching the panel, and — when `NOTIFY_WEBHOOK_URL` is configured — an
operator running a rented GPU asynchronously is notified directly, without
polling anything. `PI_PROVIDER` defaults to `faux` (fixed findings from a
lookup table, no key required, no network call) but a real provider is now
wired in — DeepSeek, via a terminal `submit_recommendation` tool and
three-tier degradation back to the fixed findings on any provider or
structured-output failure — and the model call runs outside the outbox
transaction. Automated verification in this repository runs entirely against
`faux` or an injected stub; no paid call is made by any test.

## What is not implemented

- **Real H3 inference.** No GPU has been provisioned, no weights are bundled,
  and no real clip has been generated. Deferred to Phase 8.
- **The remote ComfyUI contract.** `COMFY_LIVE_TEST=1 COMFY_MODE=remote pnpm
  test:comfy-live` reports SKIP, not pass, because no pinned remote executor is
  configured here. Also Phase 8.
- **A cross-run digest and inference-cost reporting.** `POST /v1/digest` and
  splitting inference spend from attempt spend on the cost endpoint are
  specified (Phase 7E steps 4-5) but not built.
- Production billing, autoscaling, multitenancy, SLOs, and Kubernetes.

Fake output is not a quality or throughput benchmark, and no capture in this
repository may be read as evidence of H3 inference. Capture provenance is
recorded in [`EVIDENCE-MANIFEST.md`](EVIDENCE-MANIFEST.md).

## Verification record

| Check | Result |
|---|---|
| Frozen install | PASS |
| Format, lint, strict TypeScript, production build | PASS — all exit 0 |
| Unit suite | PASS — 217 tests across 25 files |
| Integration suite | PASS — 18 tests across 10 files, PostgreSQL-backed |
| Browser suite | PASS — 10/10 at the last recorded full run |
| Token isolation | PASS — `storageHasCredential: false`, `globalsHaveCredential: false`, `crossOriginProtected: true` |
| Documentation and provenance | PASS — 13 captures accounted for |
| Secret scan | PASS — 184 tracked files inspected |
| Live ComfyUI contract | SKIP — no configured pinned remote executor |
| Real H3 GPU smoke | NOT RUN — Phase 8 |

## Known issues

The pinned ComfyUI frontend exposes no supported queue-interception hook. This
release does not monkey-patch frontend internals; it disables the native
control and surfaces the managed action instead. Its topbar badge metadata is
static in the pinned ref, so live readiness, count, and budget values are
carried by the postMessage status feed and the bottom panel rather than the
badge.
