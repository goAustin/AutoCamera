# Dependency, license, and source-pin record

This is the Phase 6 `v0.1.0-mvp` dependency record. Package versions are
exact in `package.json` and `pnpm-lock.yaml`; source repositories are not
cloned into this checkout unless explicitly listed as a small bridge fixture.

## Runtime and package manager

| Item | Exact version | License / attribution |
|---|---:|---|
| Node.js | `24.x` (repository engine `>=24.0.0 <25.0.0`) | Node.js MIT; retain the Node.js notice when redistributing it |
| pnpm | `9.15.0` | pnpm MIT |
| TypeScript | `7.0.2` | Apache-2.0 |
| Biome | `2.5.11` | MIT; formatter/linter is a development dependency |
| Vitest | `4.1.11` | MIT; development/test dependency |
| Playwright | `1.62.1` | Apache-2.0; browser binaries are not committed |

## Major application dependencies

| Dependency | Exact version | License / attribution |
|---|---:|---|
| Fastify | `5.12.1` | MIT |
| Zod | `4.4.3` | MIT |
| React / React DOM | `19.2.8` | MIT; React attribution applies to redistributed builds |
| React Router DOM | `7.18.2` | MIT |
| TanStack Query | `5.102.8` | MIT |
| Vite | `8.2.2` | MIT |
| Drizzle ORM | `0.45.2` | Apache-2.0 |
| node-postgres (`pg`) | `8.23.0` | MIT |
| OpenTelemetry API | `1.9.1` | Apache-2.0 |
| Pi package: `@earendil-works/pi-agent-core` | `0.84.4` | Upstream package license/notice must accompany any redistribution |
| `@earendil-works/pi-ai` | `0.84.4` | Upstream package license/notice must accompany any redistribution |

The lockfile is the authority for transitive packages. This release does not
add a license-scanning dependency solely for appearance; dependency and secret
checks use the existing package manager and repository scripts.

## ComfyUI and MiniMax H3 source pins

| Source | Exact ref | Role and evidence boundary |
|---|---|---|
| ComfyUI backend (`Comfy-Org/ComfyUI`) | `8a33128f2f8c5585c57486c07de481241e70a39c` | Separate backend checkout; live contract only |
| ComfyUI frontend (`Comfy-Org/ComfyUI_frontend`) | `3697a1bc3ba7f6b98a1ead888721f7676b536eb5` | Separate frontend checkout; editor only |
| `Comfy-Org/workflow_templates` | `d3b4a9e89573162b005961865164c18c8ae2206b` | Official H3 T2V template source; **MIT**, retain its notice with `workflows/minimax-h3/` |
| `MiniMax-AI/MiniMax-H3` | `d21241f0a4b3acbb34c97dae47fa417b7065e438` | Inference source; no code or weights bundled |

The profile's model filenames are recorded in
`workflows/minimax-h3/compatibility-manifest.json` and
`infra/gpu-executor/pin-manifest.json`. Publisher checksums are intentionally
not invented; a GPU deployment must record supplied checksums separately.
The bridge under `integrations/comfyui-videoops` is frontend-only and registers
no execution nodes.

## Observability pins

| Image | Exact tag |
|---|---|
| OpenTelemetry Collector Contrib | `otel/opentelemetry-collector-contrib:0.136.0` |
| Tempo | `grafana/tempo:2.8.2` |
| Prometheus | `prom/prometheus:v3.5.0` |
| Grafana | `grafana/grafana:12.1.1` |

These services are optional and are stopped by name; ordinary shutdown does
not remove PostgreSQL or artifact data.

## License status

The H3 VideoOps project itself is **MIT licensed** ([`LICENSE`](LICENSE)). That
covers the code in this repository and nothing else: no third-party source or
model weights are relicensed by it.

MIT is chosen against a GPL-3.0 neighbour deliberately. Both the ComfyUI backend
and its frontend are GPL-3.0, and neither is vendored here — the pins above name
external repositories, and `scripts/fetch-comfy-frontend.sh` fetches into the
ignored `.data/` tree at build time. Copyleft attaches on distributing the
covered work or a derivative of it, and this repository distributes neither: the
control plane reaches ComfyUI over HTTP and WebSocket, and the bridge under
`integrations/comfyui-videoops` ships no ComfyUI code, imports no ComfyUI Python
module, and registers no execution nodes. Installing that bridge into a GPL-3.0
ComfyUI remains the installer's own combination, which MIT terms do not obstruct.

Copying ComfyUI source into the bridge, or shipping a fork of the frontend,
would change this: that directory would then be a derivative work and would have
to carry GPL-3.0.

`workflows/minimax-h3/api.json` and `editor.json` derive from the official
`Comfy-Org/workflow_templates` H3 template, which is **MIT** — verified
2026-09-14 against that repository, not assumed from ComfyUI's own GPL-3.0.
Comfy-Org licenses the two separately: the engine is copyleft, the templates
meant to be reused are not. Those two files therefore carry compatible terms,
and so does the offline fixture that compiles from `api.json`. MIT is not
attribution-free: retain Comfy-Org's copyright and permission notice alongside
them in any redistribution that includes a substantial portion of the template.
