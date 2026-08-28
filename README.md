# H3 VideoOps

Status: **Phase 2 implementation in progress** — the domain model, PostgreSQL migration, deterministic storyboard planner, project API, transactional events/outbox, authentication, and idempotency foundations are implemented. The PostgreSQL acceptance gate remains pending until the documented local prerequisites are installed.

H3 VideoOps is a local, durable AI-video operations demo. PostgreSQL is the business-state authority, while the ComfyUI and planning integrations remain deterministic and offline until the later MVP phases.

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

`pnpm dev` starts the pinned PostgreSQL container, applies the domain migration, and starts the API, fake ComfyUI, and Vite web shell. No cloud account, LLM key, GPU, or paid service is required for this phase.

There is no selected project license yet; license selection remains pending.

## Current endpoints

- API live health: `http://127.0.0.1:3000/health/live`
- API database readiness: `http://127.0.0.1:3000/health/ready`
- Fake ComfyUI health: `http://127.0.0.1:8188/health`
- Fake ComfyUI object information: `http://127.0.0.1:8188/object_info`
- Web shell: `http://127.0.0.1:5173`
- OpenAPI JSON and Swagger UI: `http://127.0.0.1:3000/documentation/json` and `http://127.0.0.1:3000/documentation`

The `/v1/*` API requires `Authorization: Bearer <DEV_AUTH_TOKEN>`. Every mutation also requires an `Idempotency-Key` header. The available Phase 2 project endpoints are documented in the generated OpenAPI contract.

See `docs/PHASE-1-PREREQUISITES.md` for the recorded prerequisite audit and exact retry requirements.
