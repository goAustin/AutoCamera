# Shared helpers for the three setup entry points. Sourced, never executed.
#
# comfy-executor.sh and gpu-rented.sh deliberately do not source this and carry
# their own copies. Both have to work standing alone: the first gets copied to a
# GPU host by itself, and the second runs on a bare container before this
# repository has been cloned, so it needs die() long before lib.sh exists.

die() {
  printf '%s: %s\n' "${setup_label:-setup}" "$1" >&2
  exit 1
}

step() {
  printf '\n==> %s\n' "$1"
}

# Node 24 is an engines constraint in package.json, and pnpm is pinned by
# packageManager. Activating the pinned pnpm here is what keeps a fresh clone
# from resolving a different lockfile format.
ensure_node_and_pnpm() {
  command -v node >/dev/null || die "Node 24 is required; see .nvmrc"
  local node_major
  node_major="$(node --version)"
  node_major="${node_major#v}"
  node_major="${node_major%%.*}"
  [[ "$node_major" == "24" ]] ||
    die "Node 24 is required by this repository; found $(node --version)"
  local pinned_pnpm
  pinned_pnpm="$(node -p "require('$repository_root/package.json').packageManager")"
  corepack enable >/dev/null 2>&1 || true
  corepack prepare "$pinned_pnpm" --activate >/dev/null 2>&1 ||
    die "could not activate $pinned_pnpm through corepack"
}

# Replace the line in place when the key is already set, append it otherwise, so
# re-running a setup script does not leave a .env with the same key twice --
# where the last one silently wins.
set_env_value() {
  python3 - "$1" "$2" "$3" <<'PYTHON_EOF'
import io, os, sys

path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
lines = io.open(path, encoding="utf-8").read().splitlines() if os.path.exists(path) else []
replacement = f"{key}={value}"
for index, existing in enumerate(lines):
    if existing.startswith(f"{key}="):
        lines[index] = replacement
        break
else:
    lines.append(replacement)
io.open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PYTHON_EOF
}
