# H3 VideoOps

Status: **bootstrap in progress** — Phase 1 creates the runnable local monorepo and health-check skeleton. Business entities, generation behavior, Pi integration, and the browser workflow are intentionally not implemented yet.

H3 VideoOps is planned as a local, durable AI-video operations demo. PostgreSQL will be the business-state authority, while the ComfyUI and planning integrations will remain deterministic and offline until the later MVP phases.

## Local setup

The bootstrap requires Node.js 24 LTS, Corepack with pnpm 9.15.0, a Compose-compatible runtime, and `ffmpeg`/`ffprobe`.

```sh
nvm install 24
nvm use 24
corepack enable
corepack prepare pnpm@9.15.0 --activate
brew install --cask docker
brew install ffmpeg
cp .env.example .env
pnpm install --frozen-lockfile
pnpm prerequisites
```

Replace the placeholder `DEV_AUTH_TOKEN` in `.env` with a local development token. The token is never printed by configuration errors, logs, or the prerequisite audit.

## Bootstrap commands

```sh
pnpm check
pnpm dev
```

`pnpm dev` starts the pinned PostgreSQL container, applies the placeholder migration, and starts the API, fake ComfyUI, and Vite web shell. No cloud account, LLM key, GPU, or paid service is required for this phase.

There is no selected project license yet; license selection remains pending.

## Current endpoints

- API live health: `http://127.0.0.1:3000/health/live`
- API database readiness: `http://127.0.0.1:3000/health/ready`
- Fake ComfyUI health: `http://127.0.0.1:8188/health`
- Fake ComfyUI object information: `http://127.0.0.1:8188/object_info`
- Web shell: `http://127.0.0.1:5173`

See `docs/PHASE-1-PREREQUISITES.md` for the recorded prerequisite audit and exact retry requirements.
