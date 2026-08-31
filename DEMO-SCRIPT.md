# Five-minute H3 VideoOps demo

Evidence level for this walkthrough: **Offline fake**. It demonstrates durable
VideoOps behavior with the deterministic protocol-compatible fake executor. It
does not demonstrate a live ComfyUI deployment or real MiniMax H3 inference.

## Mandatory offline fake walkthrough

Start from the repository root with Node 24, pnpm 9.15.0, PostgreSQL, and
`ffmpeg`/`ffprobe` available:

```sh
cp .env.example .env             # set only a local DEV_AUTH_TOKEN
pnpm install --frozen-lockfile
pnpm demo:seed
pnpm dev
```

Open `http://127.0.0.1:5173`, enter the local development token, and use the
following talk track. The seeded `demo-project` is a draft and can be reused;
the seed command is idempotent.

1. **Ownership diagram.** Project Studio is the authenticated shell. Pi plans
   from typed VideoOps callbacks. ComfyUI edits and executes graphs. VideoOps
   owns durable policy, queue, monitoring, artifacts, evaluation, and review.
   MiniMax H3 owns inference only when a compatible GPU deployment exists.
2. **Create.** Show the project list/readiness page and create a project with a
   brief, target duration, and budget. This is the `project.create` trace root.
3. **Plan.** Click **Plan with Pi**. The structured proposal has three shots,
   visual/camera/audio direction, acceptance criteria, and bounded asset IDs.
   No raw Pi response is exposed to the browser or telemetry.
4. **Approve.** Click **Approve storyboard**. Approval is a durable human
   decision and changes the project/shot state without an implicit generation.
5. **Edit one shot.** Select Shot 01. In fake mode, the bounded deterministic
   H3 panel is labeled `SIMULATED`; it stands in for the mounted ComfyUI editor.
   Change a safe preview parameter if desired.
6. **Save and validate.** Click **Create revision & validate**. Show the
   editor graph/API graph bridge result, immutable Revision 1, profile
   `minimax-h3-t2va-preview`, execution hash, and `validated` status. The API
   graph, not queue-time synthesis, is the managed execution input.
7. **Generate managed.** Click **Generate managed**, confirm the budget
   reservation, and point out that the browser calls VideoOps. The browser does
   not call private ComfyUI `POST /prompt`; only the worker can do that.
8. **Queue and reconciliation.** Show the attempt moving through queue/lease,
   fake Comfy submission, progress, history reconciliation, artifact ingest,
   and evaluation. Refresh the page to show REST reconstruction after the SSE
   stream is gone.
9. **Playback and review.** Play the authorized artifact. Show the technical
   evaluation checks and cost estimate, then click **Accept passing attempt**.
   Rejection requires a reason code; acceptance is a human review decision.
10. **Recovery branch.** For a quick retryable failure demonstration, use the existing
    browser E2E scenario or create an attempt with the test-only
    `execution-failure` fixture. Show `COMFY_EXECUTION_FAILED`, then use
    **Retry with confirmation**. The retry is a new derived attempt; the
    terminal source attempt is unchanged. Alternatively set Width to 950 and
    show the invalid-workflow correction details without creating an attempt.
11. **Operator boundary.** Trigger an executor-unavailable or failed-attempt
    domain event in the test fixture. Pi writes a durable bounded recommendation
    such as `EXECUTOR_UNAVAILABLE`; the user must explicitly apply or dismiss
    it. Pi never receives a database handle or direct ComfyUI access.
12. **Trace/dashboard.** Copy the `x-trace-id` response header or the trace
    shown in an error notice. With observability enabled, search it in Tempo;
    inspect `/metrics` or the provisioned Grafana dashboard for status,
    validation, queue, evaluation, recommendation, and SSE panels.
13. **Limitations.** Say plainly: the current evidence is offline fake; no real
    H3 clip was generated; remote ComfyUI compatibility and the real H3 GPU
    smoke are deferred to Phase 8; fake output is not a quality, latency,
    throughput, or cost benchmark.

Capture the deterministic evidence set with:

```sh
pnpm demo:screenshots
```

The capture suite stores only optimized UI screenshots under
`assets/screenshots/` and uses the isolated fake-mode E2E environment.

## Optional live ComfyUI contract walkthrough

This variant is separate from the mandatory demo and requires the complete
ComfyUI checkout, bridge, gateway policy, and exact pins in
[`infra/gpu-executor/README.md`](infra/gpu-executor/README.md). It does not
require H3 weights for the contract portion, and it must not be described as a
real H3 generation run.

1. Deploy the backend commit, frontend commit, official workflow-template
   commit, and bridge from the pin manifest on a private host.
2. Configure `COMFY_MODE=remote` and the worker-only private URLs in the
   deployment environment. Keep the bearer token out of the browser route.
3. Open the exact authenticated `/comfy/` editor route from Project Studio and
   verify nonce/origin bridge readiness.
4. Export one dual graph (`editorGraph` plus `apiGraph`), save a draft, create
   and validate a revision, and verify that the browser gateway denies
   `POST /prompt`, queue mutation, and interrupt.
5. Run the opt-in contract command and record pass/skip separately:

```sh
COMFY_LIVE_TEST=1 COMFY_MODE=remote pnpm test:comfy-live
```

The live contract proves only backend/frontend/protocol compatibility. A real
H3 evidence record additionally needs the model filenames, GPU/CUDA/PyTorch
runtime, parameters, measured duration, media evaluation, and date. That
separate H3 smoke is intentionally deferred to Phase 8.

## Safe reset

After the demo, review the printed target and explicitly reset only the named
demo project:

```sh
pnpm demo:reset -- --force
```

The reset refuses empty/root/home/workspace or unresolved artifact paths and
preserves unrelated projects, artifacts, model directories, and remote output.
