# H3 VideoOps

Status: **Phase 5 local implementation in progress.** The repository includes an authenticated Project Studio shell, durable PostgreSQL-backed project/storyboard/shot state, workflow drafts and immutable revisions, managed generation attempts, deterministic fake ComfyUI execution, media evaluation and review, and Pi planning/operator recommendations. Real GPU-backed MiniMax H3 execution and the live ComfyUI acceptance gate are not part of the default local stack.

H3 VideoOps is a local, durable AI-video operations demo. PostgreSQL is the business-state authority, while the default generation path is deterministic and GPU-free.

## Ownership boundary

| Component | Responsibility |
|---|---|
| Project Studio | Authenticated React shell for project creation, storyboard planning and approval, shot workflows, generation status, review, and operator actions. |
| VideoOps API and workers | Own projects, approvals, idempotency, budgets, workflow revisions, attempts, leases, recovery, artifacts, evaluation, events, and review policy. |
| ComfyUI | `apps/fake-comfy` provides a deterministic protocol-compatible local service. A complete pinned ComfyUI/H3 executor remains an external deployment concern. |
| Pi | The application consumes the pinned `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` packages for deterministic planning and bounded operator recommendations. Pi does not call ComfyUI directly. |
| MiniMax H3 | Inference only. Model weights and GPU execution are not bundled in this repository. |

## Local setup

Requirements: Node.js 24 LTS, Corepack with pnpm 9.15.0, a Compose-compatible runtime, and `ffmpeg`/`ffprobe`.

```sh
nvm install 24
nvm use 24
corepack enable
corepack prepare pnpm@9.15.0 --activate
cp .env.example .env
pnpm install --frozen-lockfile
pnpm prerequisites
```

Replace the placeholder `DEV_AUTH_TOKEN` in `.env` with a local development token. Configuration errors and logs do not print the token.

## Run and verify

```sh
pnpm check
pnpm dev
```

`pnpm check` runs formatting, linting, strict TypeScript checks, tests, and the production build. `pnpm dev` audits prerequisites, prepares the media fixture, starts PostgreSQL, applies migrations, builds the workspace, and starts the API/generation workers, deterministic fake ComfyUI service, and Vite shell.

The local stack requires no cloud account, model download, GPU, paid provider, or LLM key.

## Local endpoints

- Project Studio: `http://127.0.0.1:5173`
- API live/readiness: `http://127.0.0.1:3000/health/live` and `http://127.0.0.1:3000/health/ready`
- OpenAPI UI: `http://127.0.0.1:3000/documentation`
- Fake ComfyUI: `http://127.0.0.1:8188/health` and `http://127.0.0.1:8188/object_info`

Every `/v1/*` request requires `Authorization: Bearer <DEV_AUTH_TOKEN>`. Every mutation also requires an `Idempotency-Key` header.

## Project workflow

1. Enter the development token in Project Studio.
2. Create a project and run the deterministic Pi planner.
3. Review and approve the three-shot storyboard.
4. Select a shot and edit its bounded fake workflow panel.
5. Save and validate an immutable workflow revision.
6. Confirm **Generate managed** to queue a durable attempt.
7. Inspect progress, the authorized artifact, technical evaluation, and review controls.

The API persists workflow hashes, attempt history, event timelines, artifact metadata, and bounded operator recommendations. The browser never receives private executor credentials or sends the VideoOps bearer token to ComfyUI.

## Repository layout

- `apps/api` — Fastify API and durable generation/operations workers
- `apps/web` — React/Vite Project Studio
- `apps/fake-comfy` — deterministic ComfyUI protocol simulator
- `packages/db` — PostgreSQL schema, migrations, and repositories
- `packages/workflow-compiler` — pinned MiniMax H3 profile, workflow validation, and canonical hashing
- `packages/comfy-client` — ComfyUI client contract and fake adapter
- `packages/evaluator` — deterministic media checks
- `packages/agent-tools` — scoped tools for Pi planning and operations
- `workflows/minimax-h3` — tracked H3 editor/API workflow fixtures and compatibility manifest

The current H3 compatibility profile and source pins are recorded in [`workflows/minimax-h3/compatibility-manifest.json`](workflows/minimax-h3/compatibility-manifest.json).

No project license has been selected yet.
