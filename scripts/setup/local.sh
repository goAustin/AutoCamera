#!/usr/bin/env bash
set -euo pipefail

# Scenario 1 of 3 -- this machine, no GPU.
#
# The bundled simulator stands in for ComfyUI, so the entire control plane runs
# with no GPU, no account and no spend. This is the mode to develop in, and the
# only mode that can test the recovery paths: a real GPU cannot be asked to drop
# a WebSocket or return a duplicate event on demand.
#
# It is a thin wrapper by design. `pnpm dev` already writes .env, starts
# PostgreSQL, migrates, builds and launches everything; what this adds is the
# two commands a fresh clone needs first.

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
setup_label="setup (local)"
# shellcheck source=scripts/setup/lib.sh
. "$repository_root/scripts/setup/lib.sh"

cd "$repository_root"

step "Toolchain"
ensure_node_and_pnpm
printf '    node %s, pnpm %s\n' "$(node --version)" "$(pnpm --version)"

step "Dependencies"
pnpm install --frozen-lockfile

step "Starting the stack (Ctrl-C to stop)"
printf '    Studio will be at http://127.0.0.1:5173 -- the token is dev-token\n'
exec pnpm dev
