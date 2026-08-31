# Phase 6 evidence manifest

Release evidence level: **Offline fake**. The named deterministic alias is
`demo-project`; the screenshots contain no raw project/shot/attempt UUIDs in
the surrounding documentation. The release commit is the commit containing
this manifest; its hash is reported by the handoff after commit creation.

## Offline screenshot set

| Filename | Capture command | Evidence level | Fixture/project alias | Secret review |
|---|---|---|---|---|
| `assets/screenshots/01-project-create.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/02-storyboard-approved.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/03-managed-workflow.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/04-revision-history.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/05-attempt-progress.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/06-artifact-review.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/07-timeline-recommendation.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/08-completed-project.png` | `pnpm demo:screenshots` | `offline-fake` | `demo-project` | automatically reviewed by capture assertions and `pnpm security:scan` |
| `assets/screenshots/09-grafana-dashboard.png` | `pnpm exec playwright screenshot --wait-for-timeout 8000 --full-page http://127.0.0.1:3001/d/h3-videoops-phase6/... assets/screenshots/09-grafana-dashboard.png` | `offline-fake` | `demo-project` | visually reviewed; no private URLs, tokens, or model paths |

The screenshot suite captures the project list/readiness page, proposal and
approval, selected-shot fake panel, revision validation, managed attempt,
artifact/evaluation review, event timeline/operator surface, and the supported
completion state. It hides the development-token field before capture and
does not include browser storage, cookies, private URLs, or model paths.

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
