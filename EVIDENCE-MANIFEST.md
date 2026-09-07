# Release provenance

This file records where every published capture came from, what it does and does
not demonstrate, and how it was reviewed for secrets. It exists so that no image
in this repository has to be taken on trust.

Current evidence level: **Offline fake**. Every capture below was produced by
the deterministic fake executor under `COMFY_MODE=fake`. No GPU, model weights,
or real H3 inference is involved in any of them, and none may be read as
evidence of H3 output quality, throughput, or cost.

The named deterministic project alias is `demo-project`. No capture contains a
bearer token, a private executor credential, or a model path.

Captures are regenerated only on request. The specs that produce them write to
the ignored `test-results/screenshots/` tree unless `CAPTURE_EVIDENCE=1` is set,
so an ordinary `pnpm test:e2e` cannot overwrite anything published here. The
capture commands below set it where it is needed.

The offline set is captured from `StandaloneRunPage`, the durable run view
mounted at `/` with no ComfyUI origin present. The ComfyUI-sidebar half of the
same run view has its own captures in the inversion set below
(`comfy-frontend/05-videoops-managed-run.png`); the offline set does not
duplicate it.

## Offline screenshot set

| Filename | Capture command | Evidence level | Fixture/project alias | Secret review |
|---|---|---|---|---|
| `assets/screenshots/01-run-history.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/02-artifact-review.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/03-run-accepted.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/04-recoverable-failure.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/05-retry-derived.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/06-finding-apply-confirmation.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/07-run-history-complete.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/09-grafana-dashboard.png` | `pnpm exec playwright screenshot --wait-for-timeout 8000 --full-page http://127.0.0.1:3001/d/h3-videoops-phase6/... assets/screenshots/09-grafana-dashboard.png` | `offline-fake` | `demo-project` | visually reviewed; no private URLs, tokens, or model paths |

The screenshot suite captures the run history list, artifact playback with a
passed technical evaluation, human acceptance, a recoverable infrastructure
failure with its human-in-the-loop retry confirmation, a derived retry's own
passed review, an operator finding with its apply confirmation, and the final
history list showing every run status the walkthrough produced. It hides the
development-token field before capture and does not include browser storage,
cookies, private URLs, or model paths. `COMFY_MODE=fake` drives every attempt;
no GPU, model weights, or real H3 inference is involved.

## Pinned ComfyUI editor shell set

This is a separate shell-compatibility set captured by the `@comfy-frontend`
spec after `pnpm comfy:frontend` has created the ignored
`.data/comfy-frontend/dist`. It proves that the pinned frontend loads the
captured node catalogue, opens the pinned H3 template, and exports both graph
forms through `app.graphToPrompt()`.

The export is asserted by the spec but deliberately not captured.
`graphToPrompt()` is a pure read with no visual effect, so an image of it would
be the same picture as `02-h3-template-open.png` — which is exactly what a
former `03-graph-to-prompt.png` turned out to be. Each capture below is
size-checked after it is written, because an editor that never rendered still
produces a valid PNG and would otherwise be published unnoticed.

The fake executor provides the protocol; no GPU, model weights, or real H3
inference is involved. The evidence level therefore remains **Offline fake**.

| Filename | Capture command | Evidence level | What is shown | Secret review |
|---|---|---|---|---|
| `assets/screenshots/comfy-frontend/01-editor-loaded.png` | `CAPTURE_EVIDENCE=1 pnpm test:e2e e2e/comfy-frontend.spec.ts` (`@comfy-frontend`) | `offline-fake` | Pinned ComfyUI editor shell loaded | captured locally; no tokens, private URLs, or model paths |
| `assets/screenshots/comfy-frontend/02-h3-template-open.png` | `CAPTURE_EVIDENCE=1 pnpm test:e2e e2e/comfy-frontend.spec.ts` (`@comfy-frontend`) | `offline-fake` | Pinned MiniMax H3 workflow template open in the graph | captured locally; no tokens, private URLs, or model paths |

The tagged set is intentionally skipped with a printed remediation reason when
the ignored build is absent. The offline run-view walkthrough above and the
observability capture remain separate release evidence, still generated by
`apps/web`; this editor set does not replace them or upgrade the evidence
level to H3/GPU evidence.

## ComfyUI-first inversion evidence

This set is captured by
`pnpm test:e2e e2e/comfy-inversion.spec.ts` after the pinned frontend build is
present. It starts at the fake ComfyUI graph canvas, opens the VideoOps sidebar
iframe, loads the H3 template, exports both public graph forms, and creates a
managed run through Studio. The screenshot set contains no VideoOps bearer
token or private executor credential; the test also asserts that the ComfyUI
origin cannot read the Studio iframe document.

| Filename | Capture command | Evidence level | What is shown | Secret review |
|---|---|---|---|---|
| `assets/screenshots/comfy-frontend/04-videoops-sidebar.png` | `CAPTURE_EVIDENCE=1 pnpm test:e2e e2e/comfy-inversion.spec.ts` | `offline-fake` | ComfyUI graph canvas with the Studio-origin VideoOps sidebar, H3 empty state, and managed-mode badge | Playwright asserts Comfy storage/global credential absence, cross-origin protection, and credential-free iframe URL |
| `assets/screenshots/comfy-frontend/05-videoops-managed-run.png` | `CAPTURE_EVIDENCE=1 pnpm test:e2e e2e/comfy-inversion.spec.ts` | `offline-fake` | One validated managed run in the sidebar with progress/evaluation and revision controls | same token-isolation assertions; no direct executor submission |

Recorded gate values: `storageHasCredential: false`,
`globalsHaveCredential: false`, `crossOriginProtected: true`, browser
`POST /prompt: 405`, and exactly one `POST /v1/runs` for the loaded H3 graph.
The pinned frontend ref is
`3697a1bc3ba7f6b98a1ead888721f7676b536eb5`.

## Optional observability evidence

The dashboard is provisioned as `h3-videoops-phase6` in Grafana. It is not
evidence of remote ComfyUI or H3 inference. The local dashboard capture is
`assets/screenshots/09-grafana-dashboard.png`; start the named services to
reproduce it:

```sh
pnpm observability:up
# inspect http://127.0.0.1:3001, dashboard h3-videoops-phase6
pnpm observability:down
```

The dashboard config and exact image pins are validated by
`pnpm observability:config`. Dashboard availability is not evidence of remote
ComfyUI or H3 inference.

## Pin evidence

| Evidence | Pin manifest |
|---|---|
| ComfyUI backend/frontend, official template, H3 source, bridge, model filenames | `infra/gpu-executor/pin-manifest.json` |
| H3 profile and required API/editor node classes | `workflows/minimax-h3/compatibility-manifest.json` |
| OTel Collector, Tempo, Prometheus, Grafana | `infra/observability/pin-manifest.json` |

The optional live contract command is
`COMFY_LIVE_TEST=1 COMFY_MODE=remote pnpm test:comfy-live`. In this environment
it is recorded as **SKIP** because no configured pinned remote executor exists.
No real H3 clip was generated.
