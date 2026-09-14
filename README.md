# H3 VideoOps

H3 VideoOps is a durable video-operations control plane for ComfyUI. You build a
graph in ComfyUI; VideoOps runs it on a GPU host you control, and keeps an
auditable record of exactly what ran.

ComfyUI is the visual entry point and graph shell. The VideoOps panel mounts
inside it as an exact-origin Studio iframe, and the bearer token stays in the
Studio origin. VideoOps owns workflow revisions, queue policy, retries,
artifacts, evaluation, and human review. Pi supplies bounded operational
recommendations. MiniMax H3 owns inference only.

![ComfyUI shell with VideoOps managed panel](assets/screenshots/comfy-frontend/05-videoops-managed-run.png)

## Quick start

Every command, from nothing to a running system. Nothing is skipped.

### 1. Install the prerequisites (once per machine)

```sh
# macOS
brew install ffmpeg
brew install --cask docker            # then launch Docker Desktop once
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 24 && nvm use 24
```

```sh
# Ubuntu / Debian
sudo apt-get update && sudo apt-get install -y ffmpeg docker.io docker-compose-v2
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Clone and start

```sh
git clone https://github.com/goAustin/AutoCamera.git
cd AutoCamera
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` writes `.env` from `.env.example`, starts PostgreSQL, applies
migrations, builds, and starts the API, worker, fake ComfyUI, and Project
Studio. Leave it running; it takes about ten seconds.

### 3. Confirm it is up

In a second terminal:

```sh
curl http://127.0.0.1:3000/health/ready
# {"service":"api","status":"ok","dependencies":{"postgres":"ok"}}
```

Open **<http://127.0.0.1:5173>**, paste the token `dev-token`, and click
**Enter Project Studio**. You should land on **Run history**. That is the whole
system running, against the bundled simulator — no GPU, no account, no spend.

### 4. Generate something

```sh
pnpm demo:seed       # creates the "[Demo] Product story control room" project
```

Submit the graph this repository ships, against that project:

```sh
PROJECT_ID=$(curl -sS http://127.0.0.1:3000/v1/projects \
  -H "authorization: Bearer dev-token" \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.find(p=>p.title.startsWith('[Demo]')).id")

curl -sS -X POST http://127.0.0.1:3000/v1/runs \
  -H "authorization: Bearer dev-token" \
  -H 'content-type: application/json' \
  -H "idempotency-key: first-run-$(date +%s)" \
  -d "{\"projectId\":\"$PROJECT_ID\",
       \"editorGraph\":$(cat workflows/minimax-h3/editor.json),
       \"apiGraph\":$(cat workflows/minimax-h3/api.json)}"
```

Refresh Project Studio. The run appears in **Run history** and finishes in about
a second: the worker claims it, the simulator returns the fixture clip, the
artifact is stored and evaluated, and the attempt lands on **Awaiting Review**
with evaluation **Passed**. Select it, play the clip, then click **Accept
passing attempt**. That is the whole loop — submission, queue, execution,
artifact, evaluation, human review.

### 5. Use ComfyUI as the front door (optional)

The fake shell at `:8188` serves the real pinned ComfyUI editor, which is not
vendored here. Fetch and build it once — without this it answers `503`:

```sh
pnpm comfy:frontend
```

Open **<http://127.0.0.1:8188>**, load the H3 template, and use **Managed Run**.
The VideoOps panel mounts in the sidebar; the native Queue button is disabled on
purpose, because every run goes through the managed path.

### Stopping and resetting

```sh
# Ctrl-C the pnpm dev terminal, then:
pnpm infra:down                 # stop PostgreSQL
pnpm demo:reset -- --force      # remove only the demo project and its artifacts
```

### Choose an executor

The control plane is identical in all three; only the executor changes.

| `COMFY_MODE` | Executor | GPU | Use it for |
|---|---|---|---|
| `fake` (default) | bundled simulator | none | The whole loop with no GPU and no spend — the commands above |
| `remote` | ComfyUI on your own machine | yours | Real H3 generation locally |
| `remote` | ComfyUI on a rented host | rented | Real H3 generation without owning the card |

`remote` means *a real ComfyUI*, not *a remote machine* — your own GPU uses it
too, pointed at `127.0.0.1`. And `fake` is not a lesser mode: it is the only way
to test the recovery paths, because a real GPU cannot be asked to drop a
WebSocket, emit a duplicate event, or return an uncertain submission on demand.

### Run it on a GPU

A real executor needs a GPU with **at least 32 GB of VRAM** (the verified run
peaked at 31.9 GB of an RTX 5090's 32.6), about **44 GB of model files**, ~120 GB
of disk, and a **CUDA 13-capable driver** (verified with `torch 2.14.0+cu130`).
Expect the first bring-up to be dominated by downloading the weights.

ComfyUI is a separate checkout: it is not vendored here, and its model directory
is never a client resource.

Run these on whichever machine has the GPU — your own or a rented host.

```sh
# 1. ComfyUI at the pinned ref, with a CUDA 13 build of torch
git clone https://github.com/Comfy-Org/ComfyUI.git ~/comfyui-h3
cd ~/comfyui-h3
git checkout 8a33128f2f8c5585c57486c07de481241e70a39c
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt \
  --extra-index-url https://download.pytorch.org/whl/cu130
```

```sh
# 2. The five model files (~44 GB, and the slow part)
HF=https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main
LORA=https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main
mkdir -p models/{diffusion_models,text_encoders,vae,loras}
curl -L -o models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors \
  $HF/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors
curl -L -o models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors \
  $HF/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
curl -L -o models/vae/minimax_h3_video_vae_fp16.safetensors \
  $HF/vae/minimax_h3_video_vae_fp16.safetensors
curl -L -o models/vae/minimax_h3_audio_vae_fp32.safetensors \
  $HF/vae/minimax_h3_audio_vae_fp32.safetensors
curl -L -o models/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors \
  $LORA/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
```

```sh
# 3. The VideoOps bridge (frontend-only, registers no execution nodes)
cp -r ~/AutoCamera/integrations/comfyui-videoops ~/comfyui-h3/custom_nodes/

# 4. Start ComfyUI on loopback and leave it running
.venv/bin/python main.py --listen 127.0.0.1 --port 8188
```

```sh
# 5. Point VideoOps at it, in a second terminal
cd ~/AutoCamera
cat >> .env <<'EOF'
COMFY_MODE=remote
COMFY_BASE_URL=http://127.0.0.1:8188
COMFY_WS_URL=ws://127.0.0.1:8188/ws
COMFY_FRONTEND_URL=http://127.0.0.1:8188
EOF
pnpm dev                                  # skips the fake service in this mode
```

```sh
# 6. Confirm the executor before submitting anything
curl http://127.0.0.1:3000/v1/executor -H "authorization: Bearer dev-token"
COMFY_LIVE_TEST=1 COMFY_MODE=remote pnpm test:comfy-live
```

Then use it exactly as in fake mode: open ComfyUI, load the H3 graph, choose
**Managed Run**.

### On a rented GPU server

The same six steps, with the whole VideoOps stack on the rented host and ComfyUI
bound to loopback, so no generated byte crosses a network. Because the host is
disposable, treat its PostgreSQL data and `ARTIFACT_ROOT` as evidence to export
before teardown rather than as storage.

[`infra/gpu-executor/README.md`](infra/gpu-executor/README.md) is the full host
runbook and covers what this section does not: the other topologies, the browser
gateway that denies `POST /prompt` and queue mutation, keeping models on a
volume that outlives the host, the cost breaker, and teardown.

### A longer walkthrough

[`DEMO-SCRIPT.md`](DEMO-SCRIPT.md) is a talk track over the same stack: the
retryable-failure and derived-retry paths, the operator findings and their
confirmations, the cost and digest routes, and following one trace through
Tempo.

## What it does

- **One-call submission.** A loaded graph goes through a single managed
  `POST /v1/runs`. There is no planning chain to walk first.
- **Immutable revisions.** Every submission is hashed server-side and pinned to
  the executor capability fingerprint observed at submit time, so "which nodes
  and which model actually existed" is recorded rather than reconstructed.
- **Durable execution.** PostgreSQL is the authority. Queue leases are
  reclaimable after worker loss; duplicate executor events and uncertain
  submissions are reconciled before a human-confirmed derived retry.
- **Deterministic evaluation.** Every artifact passes media checks before it can
  be accepted.
- **An append-only timeline.** Domain events reconstruct what happened over REST
  or SSE, with trace context carried across worker, outbox, executor
  observation, and stream boundaries.

## Status

The durable control plane, the ComfyUI-first shell, and the offline execution
loop are implemented and tested. The run view is at
`assets/screenshots/01-run-history.png` and the rest of the captured set.

**One real MiniMax H3 clip has been generated, through the managed run path.**
On 2026-09-13 a pinned remote executor on a rented RTX 5090 accepted the graph
this repository ships: submitted through a single `POST /v1/runs` against a
budgeted project, driven by the durable worker, evaluated, and stored as an
accepted attempt — h264 960x544, 124 frames, 24 fps, 5.17 s, AAC 32 kHz stereo,
which is the pinned profile default exactly. That host no longer exists and
nothing here provisions a GPU on demand, so it is a record of one run, not
something a clone of this repository reproduces.

**Phase 8 is not complete.** Its gate is every row of the step 2 table, and the
browser-bridge row — whether a real ComfyUI's pip-served pinned frontend behaves
like the build the browser suite exercises — has not been performed.

Every capture published here is `Offline fake` — produced by the deterministic
fake executor, not by a GPU. They demonstrate orchestration, revisions, retries,
evaluation, review, and browser flow. They are not H3 inference evidence, and
fake output is not a quality or throughput benchmark.

The current evidence level, the verification record, and what remains open are
in [`STATUS.md`](STATUS.md). Capture commands, provenance, and secret review for
every image — and the full record of that one real run — are in
[`EVIDENCE-MANIFEST.md`](EVIDENCE-MANIFEST.md).

## Architecture

```mermaid
flowchart LR
  U[User] --> C[ComfyUI graph shell]
  C --> S[Studio-origin VideoOps panel]
  S --> P[Pi package adapter]
  S --> A[VideoOps API]
  A --> D[(PostgreSQL authority)]
  D --> W[Durable worker]
  W --> F[Fake ComfyUI]
  W --> R[Private remote ComfyUI]
  R --> H[MiniMax H3 inference]
  W --> O[(Authorized artifact store)]
  W --> E[Media evaluator]
  E --> D
  D --> S
  D --> OP[Pi operator adapter]
  OP -->|bounded recommendation| D
  S -->|human-approved action| A
```

| Component | Owns | Does not own |
|---|---|---|
| Project Studio | Authenticated embedded panel, run history, revision loading, pin/review, findings, trace display, and standalone fallback routes | Private executor credentials or direct executor submission |
| VideoOps API/worker | PostgreSQL state, immutable revisions, validation, budgets, leases, retries, reconciliation, artifacts, evaluation, SSE, review, operator policy | Model inference |
| ComfyUI | Visual graph editor, public graph-to-API export, plugin surfaces, and host-side executor shell | VideoOps bearer token, project policy, durable review, billing, or VideoOps authorization |
| Pi packages | Bounded operational recommendations | Direct database, shell, filesystem, ComfyUI, token, or automatic remediation access |
| MiniMax H3 | Inference when actually deployed on a compatible GPU host | Monitoring, queue durability, retries, artifacts, or human approval |

VideoOps consumes the published `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai` packages, not the whole Pi repository. The H3 model is an
inference dependency, not a monitoring service.

### Trust and route boundaries

The browser opens the ComfyUI graph shell and the plugin mounts a Studio-origin
iframe. Only the Studio iframe calls the public VideoOps API, using the token in
its own origin. Only the VideoOps worker can call the private ComfyUI
`POST /prompt` route. The browser never receives `COMFY_BASE_URL`,
`COMFY_WS_URL`, `COMFY_AUTH_TOKEN`, private hostnames, signed output paths, or a
ComfyUI bearer token. The bridge uses an exact parent origin, nonce, source
window, schema, and payload-size check; ComfyUI exports the editable graph and
API graph without calling VideoOps itself.

The token isolation test records no credential in ComfyUI storage or globals,
and confirms that the Studio iframe remains cross-origin.

### Artifact handling

Artifacts are stored outside public static paths with tenant/project/attempt
scope checks. Project Studio requests an authorized artifact resource and the
API supports bounded byte-range responses for playback. Clients submit opaque
resource IDs, never filesystem paths or object keys.

## Verification

None of this is required to run the system — `pnpm dev` above needs none of it.
These are the gates the project holds itself to, and CI runs them on every push:

```sh
pnpm check                           # format, lint, strict TypeScript, unit tests, build
pnpm test:integration                # PostgreSQL-backed
pnpm test:e2e                        # browser suite against the fake executor
pnpm test:comfy-live                 # SKIP when no remote executor is configured
pnpm observability:config
pnpm security:scan
pnpm docs:check
pnpm release:verify
```

`COMFY_LIVE_TEST=1 COMFY_MODE=remote pnpm test:comfy-live` is an opt-in contract
check and reports **SKIP**, not pass, without the separately deployed pinned
service.

The pinned ComfyUI frontend is not vendored and never builds in CI. To run the
tagged `@comfy-frontend` specs against it:

```sh
pnpm comfy:frontend
pnpm test:e2e e2e/comfy-frontend.spec.ts
```

Without `.data/comfy-frontend/dist`, the fake shell returns an actionable 503 on
`/` and the tagged specs skip with that remediation. The untagged suite is
unaffected.

## Observability

The named observability services are pinned and optional for normal tests:

```sh
pnpm observability:up
# open http://127.0.0.1:3001 and select the H3 VideoOps dashboard
pnpm observability:down
```

`observability:down` stops only OpenTelemetry Collector, Tempo, Prometheus, and
Grafana. It does not remove PostgreSQL, its volume, or the artifact directory.
The API exposes Prometheus text at `http://127.0.0.1:3000/metrics`. Copy the
`x-trace-id` response header or the trace shown in a Project Studio error
notice, then search that value in Tempo. The same trace is continued by worker
spans, executor observation, artifact/evaluation, SSE/REST reconstruction,
review, and the optional operator action where that path is exercised.

Exporter failure is diagnostic only and cannot roll back or block business
state.

## Repository map

- `apps/web` — React/Vite Project Studio
- `apps/api` — Fastify API, durable worker, Pi operator adapter
- `apps/fake-comfy` — deterministic ComfyUI HTTP/WebSocket simulator
- `packages/db` — PostgreSQL schema, migrations, repositories, leases
- `packages/workflow-compiler` — H3 profile, canonical hashing, validation
- `packages/comfy-client` — fake and authenticated HTTP/WebSocket contracts
- `packages/evaluator` — deterministic media checks
- `packages/telemetry` — trace context, redaction, bounded metrics, exporter
- `integrations/comfyui-videoops` — frontend-only ComfyUI bridge
- `infra/gpu-executor` — separate GPU-host runbook; no weights are stored here
- `infra/observability` — pinned local telemetry stack and dashboard

Exact ComfyUI, frontend, workflow-template, H3 source, model filename, and Pi
package pins are recorded in [`DEPENDENCIES.md`](DEPENDENCIES.md),
[`infra/gpu-executor/pin-manifest.json`](infra/gpu-executor/pin-manifest.json),
and
[`workflows/minimax-h3/compatibility-manifest.json`](workflows/minimax-h3/compatibility-manifest.json).

## Security and limitations

The system implements authentication, idempotency, tenant/project scope checks,
private executor route separation, exact iframe bridge origins and nonces,
payload-free telemetry, bounded metric labels, redacted problem details,
authorized range delivery, and human confirmation for budget-spending retries or
operator actions. These are implementation boundaries, not a security
certification or a public-production readiness claim.

Known limitations are intentionally explicit:

- Real inference is not repeatable from here. Remote ComfyUI compatibility and
  one real H3 clip were exercised once, on a rented host that no longer exists;
  nothing in this repository provisions a GPU on demand.
- No H3 weights are bundled.
- Production billing, autoscaling, multitenancy, SLOs, and Kubernetes are not
  implemented.
- The pinned frontend exposes no supported queue-command override, so native
  queue controls are disabled and the public `Managed Run` action is used. No
  frontend internals are patched.
- The pinned frontend's topbar badge metadata is static, so live readiness,
  count, and budget values are shown in the Studio and bottom-panel status
  surfaces instead.

Dependency attribution, license status, and migration notes are in
[`DEPENDENCIES.md`](DEPENDENCIES.md) and [`CHANGELOG.md`](CHANGELOG.md). This
project is MIT licensed ([`LICENSE`](LICENSE)); ComfyUI, which it drives, is
GPL-3.0 and is not vendored or redistributed here.
