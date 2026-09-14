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
pnpm dev                         # starts PostgreSQL, API, worker, fake ComfyUI, Studio
pnpm demo:seed                   # second shell; needs the database the launcher started
```

Open `http://127.0.0.1:5173`, enter the local development token, click **Enter
Project Studio**, and land on **Run history** — the standalone run view at `/`,
which is what you get when no ComfyUI origin is present. The seeded
`demo-project` is a draft and can be reused; the seed command is idempotent.

There is no planner, storyboard, or per-shot screen to walk through: a run is
one managed `POST /v1/runs` carrying a graph, and everything below is what
happens to it afterwards.

1. **Ownership diagram.** ComfyUI is the entry point and owns graph editing.
   VideoOps owns durable policy, queue, monitoring, artifacts, evaluation, and
   review. Pi supplies bounded operational recommendations from typed VideoOps
   callbacks. MiniMax H3 owns inference only, when a compatible GPU deployment
   exists.
2. **Create a run.** A run enters exactly one way — a single managed
   `POST /v1/runs` carrying `projectId`, `editorGraph`, and `apiGraph`, with an
   `Idempotency-Key`. The browser calls VideoOps; it does not call private
   ComfyUI `POST /prompt`, and only the worker can. Submit the shipped graph
   against the seeded project to produce a run, or use step 10's ComfyUI-first
   path to produce one from the canvas:

   ```sh
   PROJECT_ID=$(curl -sS http://127.0.0.1:3000/v1/projects \
     -H "authorization: Bearer $DEV_AUTH_TOKEN" \
     | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).projects.find(p=>p.title.startsWith('[Demo]')).id))")

   curl -sS -X POST http://127.0.0.1:3000/v1/runs \
     -H "authorization: Bearer $DEV_AUTH_TOKEN" \
     -H 'content-type: application/json' \
     -H "idempotency-key: demo-$(date +%s)" \
     -d "{\"projectId\":\"$PROJECT_ID\",
          \"editorGraph\":$(cat workflows/minimax-h3/editor.json),
          \"apiGraph\":$(cat workflows/minimax-h3/api.json)}"
   ```

3. **Immutable revision.** Point out what the response records: the graph is
   hashed server-side into an immutable revision, validated against the H3
   profile, and pinned to the executor capability fingerprint observed at
   submit time. The API graph is the execution input — not something
   re-synthesised at queue time.
4. **Run history.** The new run appears in the list with its short ID and
   status. Select it: the detail panel shows the full run ID, the attempt
   status, and the **Trace ID**. This list is the whole project surface; there
   is no separate completion screen.
5. **Queue and reconciliation.** Show the attempt moving through queue/lease,
   fake Comfy submission, progress, history reconciliation, artifact ingest,
   and evaluation. Refresh the page to show REST reconstruction after the SSE
   stream is gone. The fake executor resolves in roughly 350 ms, so say this
   rather than expecting to catch it mid-flight.
6. **Playback and review.** Play the authorized artifact in the attempt card.
   Show the technical evaluation reading **Passed** while the attempt is still
   **Awaiting Review**, then click **Accept passing attempt** — evaluation is
   deterministic and automatic; acceptance is a human decision. Rejection
   requires a reason code.
7. **Recovery branch.** For a retryable failure, create an attempt with the
   fake-mode `execution-failure` scenario
   (`POST /v1/shots/:shotId/attempts` with `{"scenario":"execution-failure"}`;
   `timeout`, `uncertain-submission`, and `duplicate-events` are the other
   fixtures). Show **Failed** with `COMFY_EXECUTION_FAILED`, click **Retry with
   confirmation**, and read the **Spend budget on a derived retry?** dialog
   aloud before confirming. The retry is a new derived attempt; the terminal
   source attempt is unchanged. A real GPU cannot be asked to fail on cue,
   which is why the fake executor exists.
8. **Operator boundary.** The `timeout` scenario produces a durable bounded
   recommendation card on the same project. Click **Apply recommendation** and
   show the **Apply a budget-spending recommendation?** confirmation: Pi
   proposes, a human applies or dismisses. Pi never receives a database handle,
   shell, or direct ComfyUI access, and the finding is also emitted as a
   `recommendation.created` domain event — and to `NOTIFY_WEBHOOK_URL` when one
   is configured — so it reaches an operator who is not watching the panel.
9. **What monitoring cost.** `GET /v1/projects/:projectId/cost` returns budget,
   spent, remaining, and `inferenceCostMicrousd` — what monitoring this project
   has cost, kept separate from attempt spend, which alone governs budget
   admission. `POST /v1/projects/:projectId/digest` with `{ "sinceIso": … }`
   summarises a window of the same read-only tools in one bounded paragraph and
   records its own cost.
10. **ComfyUI-first entry.** This is the real front door and needs the pinned
    frontend build first:

    ```sh
    pnpm comfy:frontend
    ```

    Open `http://127.0.0.1:8188`, load the H3 template, and show: the native
    **Queue** control and its mode menu disabled, the **Managed Run** button in
    the action bar, and the VideoOps sidebar tab mounting the Studio-origin
    iframe. **Managed Run** exports both graph forms through public
    `app.graphToPrompt()` and produces exactly one `POST /v1/runs`. The bearer
    token never enters the ComfyUI origin, the ComfyUI page cannot read the
    iframe document, and a hand-written `fetch('/prompt', …)` from the console
    returns 405 — locally from the fake shell, and on a deployed host from the
    Caddy gateway, which denies queue mutation below the frontend rather than
    relying on a disabled button. Without the build, the fake shell returns an
    actionable 503 and this step is skipped.
11. **Trace/dashboard.** Copy the `x-trace-id` response header or the trace
    shown in an error notice. With observability enabled, search it in Tempo;
    inspect `/metrics` or the provisioned Grafana dashboard for status,
    validation, queue, evaluation, recommendation, and SSE panels.
12. **Limitations.** Say plainly: everything in this walkthrough is fake
    output. Exactly one real H3 clip exists in this project's history — one
    managed run on a rented RTX 5090 on 2026-09-13, recorded in
    `EVIDENCE-MANIFEST.md` and not published here — on a host that no longer
    exists. Nothing provisions a GPU on demand, Phase 8's gate is still open,
    and fake output is not a quality, latency, throughput, or cost benchmark.

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
runtime, parameters, media evaluation, and date. Both have now been done once,
on 2026-09-13 on a rented RTX 5090: the contract command passed on its first
ever run, and one managed run produced an accepted attempt at the profile
defaults. The full record is in [`EVIDENCE-MANIFEST.md`](EVIDENCE-MANIFEST.md).
Neither is reproducible from this repository without standing a host up again,
so this walkthrough stays offline fake, and a live run must be described as what
it was — one clip, on hardware that no longer exists.

## Safe reset

After the demo, review the printed target and explicitly reset only the named
demo project:

```sh
pnpm demo:reset -- --force
```

The reset refuses empty/root/home/workspace or unresolved artifact paths and
preserves unrelated projects, artifacts, model directories, and remote output.
