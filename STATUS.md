# Status

Evidence level: **Two real generations, through the managed run path, on
different hardware.** On 2026-09-13 a pinned remote executor on a rented RTX 5090
produced a clip at the profile defaults — 960x544, 124 frames, 24 fps, 5.17 s,
AAC 32 kHz stereo — submitted through `POST /v1/runs` against a budgeted project
and stored as an **accepted** attempt (`docs/85-PHASE-8-STEP2-RESULT.md`).

On 2026-09-15 the same profile was produced again on a rented **RTX PRO 5000
Blackwell** running `torch 2.10.0+cu130`, this time provisioned end to end by
`scripts/setup/gpu-rented.sh` from a clean clone with no manual install steps.
The capability fingerprint and workflow hash were identical to the first run;
the attempt reached **`awaiting_review`** with evaluation passed and was not
carried through human review. Recorded in
[`EVIDENCE-MANIFEST.md`](EVIDENCE-MANIFEST.md).

**Phase 8 is not complete.** Its gate is every row of Step 2's table, and row
2.11 — the six browser-bridge checks of `infra/gpu-executor/README.md` §6 — was
split into a separate pass and has not been performed. Everything in this
repository that is not that one clip remains offline fake output.

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

A session digest (`POST /v1/projects/:projectId/digest`) runs the same
read-only tools over a time window instead of a single event, returning one
bounded, Zod-validated summary and recording its own cost; the window is
enforced on the underlying reads, and a run id outside it is denied rather
than cited. `GET /v1/projects/:projectId/cost` reports `inferenceCostMicrousd`
as a fourth figure alongside budget/spent/remaining — what monitoring a
project has cost, summed across its `agent_runs` rows — kept separate from
`spentMicrousd`; budget admission for a new attempt still keys on attempt
spend alone. This closes Phase 7E, and with it **Phase 7 (7A-7E) is
complete**.

## What is not implemented

- **The Phase 8 gate, row 2.11.** Item 5 — gateway denial of browser queue
  mutation — is now closed by `e2e/comfy-gateway.spec.ts` against the Caddy
  route in `infra/caddy/Caddyfile`. Item 1 is still open: whether real
  ComfyUI's pip-served pinned frontend behaves like the
  `.data/comfy-frontend/dist` build the suite exercises. The row, and so the
  gate, is not discharged.
- **On-demand GPU provisioning.** The setup scripts install and run the system
  on a host you have already rented; nothing here rents one. No weights are
  bundled. Real inference is now reproducible — the 2026-09-15 run came from a
  clean clone on hardware the first run never touched — but it is reproducible
  by a person who provisions a host, not by CI.
- Production billing, autoscaling, multitenancy, SLOs, and Kubernetes.

Fake output is not a quality or throughput benchmark. Exactly two captures are
real H3 inference — the 2026-09-13 and 2026-09-15 runs, both held outside what
this repository publishes. Every other capture here is fake output and may not be
read as evidence of it. Capture provenance is recorded in
[`EVIDENCE-MANIFEST.md`](EVIDENCE-MANIFEST.md).

## Verification record

| Check | Result |
|---|---|
| Frozen install | PASS |
| Format, lint, strict TypeScript, production build | PASS — all exit 0 |
| Unit suite | PASS — 284 tests across 28 files |
| Integration suite | PASS — 24 tests across 12 files, PostgreSQL-backed, verified against a freshly provisioned database as well as a developer one |
| Browser suite | PASS — 17/17 |
| ComfyUI browser gateway | PASS — 7/7, queue mutation denied at the gateway |
| Token isolation | PASS — `storageHasCredential: false`, `globalsHaveCredential: false`, `crossOriginProtected: true` |
| Documentation and provenance | PASS — 12 captures accounted for |
| Secret scan | PASS — 262 tracked files inspected |
| Live ComfyUI contract | PASS — against the pinned remote executor on a rented RTX 5090, 2026-09-13 |
| Real H3 GPU smoke | PASS — accepted attempt at profile defaults through `POST /v1/runs`, 2026-09-13 |
| Real H3 GPU smoke, reproduced | PASS — 2026-09-15, RTX PRO 5000 Blackwell, provisioned by `scripts/setup/gpu-rented.sh` from a clean clone; identical capability fingerprint and workflow hash; attempt `awaiting_review`, evaluation passed |
| Phase 8 gate row 2.11 | NOT RUN — browser bridge checks split into a separate pass |
| GitHub Actions CI | PASS — every step on `65c324a`, including the browser suite; the `packages/ui` redesign commits after it have not yet run in CI |

## Known issues

**The frontend bridge is reported as `IMPORT FAILED` by real ComfyUI.** On
2026-09-15 ComfyUI 0.34.0 logged `Skip … comfyui-videoops module for custom nodes
due to the lack of NODE_CLASS_MAPPINGS or comfy_entrypoint` followed by
`0.0 seconds (IMPORT FAILED)`. The package declares only `WEB_DIRECTORY` and
registers no execution nodes, which is deliberate and is what
`pin-manifest.json` asserts. Whether ComfyUI still serves the extension's web
directory after logging that was **not determined** — no browser was opened on
that host. This sharpens Phase 8 row 2.11 item 1 rather than closing it: the
question is no longer only whether the pip-served frontend matches the built
dist, but whether the bridge loads at all under this ComfyUI version. Generation
is unaffected; both real runs were submitted through the API.

**A prebuilt ComfyUI image cannot host the pinned executor on the default port.**
Such images serve their own ComfyUI behind a proxy bound to the IPv4 wildcard on
8188, so the pinned executor cannot bind there, and the image's preinstalled
torch becomes the one it runs. `COMFY_PORT` selects another port; a plain
CUDA/PyTorch base image avoids the situation.

The pinned ComfyUI frontend exposes no supported queue-interception hook. This
release does not monkey-patch frontend internals; it disables the native
control and surfaces the managed action instead. Its topbar badge metadata is
static in the pinned ref, so live readiness, count, and budget values are
carried by the postMessage status feed and the bottom panel rather than the
badge.
