#!/usr/bin/env bash
set -euo pipefail

# Scenario 2 of 3 -- your own Linux GPU box.
#
# Installs the pinned executor beside this repository, points VideoOps at it on
# loopback, and starts the stack. Docker is available here, so `pnpm dev` runs
# the control plane exactly as it does in fake mode; the executor is the only
# thing that changes.
#
# Needs a CUDA 13-capable driver, >=32 GB VRAM, >=64 GB host RAM (ComfyUI
# offloads the 32B text encoder there between nodes), and ~120 GB of disk.

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
setup_label="setup (local GPU)"
# shellcheck source=scripts/setup/lib.sh
. "$repository_root/scripts/setup/lib.sh"

comfy_root="${COMFY_ROOT:-$HOME/comfyui-h3}"
cd "$repository_root"

[[ "$(uname -s)" == "Linux" ]] ||
  die "the pinned executor needs a CUDA Linux host; on macOS use scripts/setup/local.sh instead"
command -v nvidia-smi >/dev/null || die "no nvidia-smi on PATH; this host has no usable GPU"

step "Toolchain"
ensure_node_and_pnpm
pnpm install --frozen-lockfile

step "Executor"
COMFY_ROOT="$comfy_root" "$repository_root/scripts/setup/comfy-executor.sh" --start

step "Pointing VideoOps at it"
[[ -f .env ]] || cp .env.example .env
set_env_value .env COMFY_MODE remote
set_env_value .env COMFY_BASE_URL http://127.0.0.1:8188
set_env_value .env COMFY_WS_URL ws://127.0.0.1:8188/ws
set_env_value .env COMFY_FRONTEND_URL http://127.0.0.1:8188
printf '    COMFY_MODE=remote against 127.0.0.1:8188\n'

step "Verify before submitting anything"
cat <<'GUIDE_EOF'
    curl http://127.0.0.1:3000/v1/executor -H "authorization: Bearer dev-token"
    COMFY_LIVE_TEST=1 COMFY_MODE=remote pnpm test:comfy-live

    Then open http://127.0.0.1:8188, load the H3 template, and use Managed Run.
GUIDE_EOF

step "Starting the stack (Ctrl-C to stop)"
exec pnpm dev
