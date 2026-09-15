#!/usr/bin/env bash
set -euo pipefail

# Installs the pinned ComfyUI executor and the MiniMax H3 weights outside this
# repository, then installs the frontend-only VideoOps bridge into it.
#
# This is the half of the system that owns inference and nothing else, and it is
# identical whether the GPU is yours or rented by the hour -- which is why both
# GPU setup scripts call this rather than repeating it.
#
# Every pin, URL and checksum is read from infra/gpu-executor/pin-manifest.json.
# Nothing is hardcoded here, so bumping a pin is a manifest edit, not a rewrite.
# Downloads are verified against the manifest sha256 and skipped when already
# correct, so re-running this after an interruption costs nothing.

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pin_manifest_path="$repository_root/infra/gpu-executor/pin-manifest.json"
comfy_root="${COMFY_ROOT:-$HOME/comfyui-h3}"
torch_index_url="${TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu130}"
start_executor=0
skip_models=0

die() {
  printf 'comfy executor: %s\n' "$1" >&2
  exit 1
}

step() {
  printf '\n==> %s\n' "$1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --start) start_executor=1; shift ;;
    --skip-models) skip_models=1; shift ;;
    --comfy-root) comfy_root="${2:?--comfy-root needs a path}"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] ||
  die "the pinned executor needs a CUDA Linux host; Apple Silicon cannot run it. Use COMFY_MODE=fake locally instead."
command -v python3 >/dev/null || die "python3 is required"
command -v git >/dev/null || die "git is required"
command -v curl >/dev/null || die "curl is required"
[[ -f "$pin_manifest_path" ]] || die "no pin manifest at $pin_manifest_path"

pin_value() {
  python3 -c '
import json, sys
value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    value = value[key]
print(value)
' "$pin_manifest_path" "$1" 2>/dev/null || die "pin-manifest.json has no value for $1"
}

comfy_repository="$(pin_value 'comfyui.repository')"
comfy_ref="$(pin_value 'comfyui.ref')"

# ---------------------------------------------------------------- ComfyUI ----
step "ComfyUI at $comfy_ref"
if [[ ! -d "$comfy_root/.git" ]]; then
  git clone --quiet "$comfy_repository" "$comfy_root"
fi
git -C "$comfy_root" fetch --quiet origin "$comfy_ref" 2>/dev/null || true
git -C "$comfy_root" checkout --quiet --detach "$comfy_ref"
[[ "$(git -C "$comfy_root" rev-parse HEAD)" == "$comfy_ref" ]] ||
  die "checkout did not resolve to the pinned ref $comfy_ref"
printf '    %s\n' "$(git -C "$comfy_root" rev-parse HEAD)"

# ------------------------------------------------------- Python environment --
step "Python environment and torch"
if [[ ! -x "$comfy_root/.venv/bin/python" ]]; then
  python3 -m venv --system-site-packages "$comfy_root/.venv"
fi
"$comfy_root/.venv/bin/python" -m pip install --quiet --upgrade pip
"$comfy_root/.venv/bin/pip" install --quiet -r "$comfy_root/requirements.txt" \
  --extra-index-url "$torch_index_url"
"$comfy_root/.venv/bin/python" - <<'PYTHON_EOF'
import torch
print(f"    torch {torch.__version__} / cuda {torch.version.cuda}")
if not torch.cuda.is_available():
    raise SystemExit("    no CUDA device visible to torch -- the executor cannot generate here")
print(f"    device {torch.cuda.get_device_name(0)} capability {torch.cuda.get_device_capability(0)}")
PYTHON_EOF

# ------------------------------------------------------------------ models ---
verify_file() {
  local path="$1" want_bytes="$2" want_sha="$3" got_bytes got_sha
  [[ -f "$path" ]] || return 1
  got_bytes="$(stat -c %s "$path" 2>/dev/null || stat -f %z "$path")"
  [[ "$got_bytes" == "$want_bytes" ]] || return 1
  got_sha="$(sha256sum "$path" | cut -d' ' -f1)"
  [[ "$got_sha" == "$want_sha" ]]
}

fetch_model() {
  local role="$1" path="$2" url="$3" bytes="$4" sha="$5"
  local dest="$comfy_root/$path"
  if verify_file "$dest" "$bytes" "$sha"; then
    printf '    %-15s present and verified\n' "$role"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  if ! curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o "$dest" "$url"; then
    printf '    %-15s DOWNLOAD FAILED\n' "$role" >&2
    return 1
  fi
  if ! verify_file "$dest" "$bytes" "$sha"; then
    printf '    %-15s CHECKSUM MISMATCH -- the bytes are not the pinned file\n' "$role" >&2
    return 1
  fi
  printf '    %-15s downloaded and verified\n' "$role"
}

if [[ "$skip_models" == "0" ]]; then
  step "Model files (~44 GB, verified against the manifest)"
  mkdir -p "$comfy_root"/input "$comfy_root"/output
  declare -a model_pids=()
  while IFS=$'\t' read -r role path url bytes sha _optional; do
    [[ -n "$role" ]] || continue
    fetch_model "$role" "$path" "$url" "$bytes" "$sha" &
    model_pids+=("$!")
  done < <(python3 -c '
import json, sys
manifest = json.load(open(sys.argv[1]))
sources = manifest.get("modelSources", {})
for role, path in manifest["models"].items():
    source = sources.get(role)
    if not isinstance(source, dict):
        continue
    print("\t".join([role, path, source["url"], str(source["bytes"]), source["sha256"],
                     "1" if source.get("optional") else "0"]))
' "$pin_manifest_path")

  model_failures=0
  for index in "${!model_pids[@]}"; do
    wait "${model_pids[$index]}" || model_failures=$((model_failures + 1))
  done
  [[ "$model_failures" == "0" ]] ||
    die "$model_failures model file(s) failed to download or verify; nothing was started"
fi

# ------------------------------------------------------------------ bridge ---
step "VideoOps bridge (frontend-only, registers no execution nodes)"
bridge_source="$repository_root/integrations/comfyui-videoops"
bridge_target="$comfy_root/custom_nodes/comfyui-videoops"
install -d "$bridge_target/web"
install -m 0644 "$bridge_source/__init__.py" "$bridge_target/__init__.py"
for bridge_file in bridge-contract.js bridge-runtime.js videoops.js; do
  install -m 0644 "$bridge_source/web/$bridge_file" "$bridge_target/web/$bridge_file"
done
printf '    installed into %s\n' "$bridge_target"

# ------------------------------------------------------------------- start ---
if [[ "$start_executor" == "1" ]]; then
  step "Starting ComfyUI on loopback"
  # Loopback only, and never published: the worker reaches it without crossing a
  # network, which is what keeps the private-route invariant true by construction.
  nohup "$comfy_root/.venv/bin/python" "$comfy_root/main.py" \
    --listen 127.0.0.1 --port 8188 --disable-auto-launch \
    >"$comfy_root/comfyui.log" 2>&1 &
  printf '%s' "$!" >"$comfy_root/comfyui.pid"
  for _ in $(seq 1 180); do
    if curl -fsS http://127.0.0.1:8188/system_stats >/dev/null 2>&1; then
      printf '    serving on 127.0.0.1:8188 (log: %s)\n' "$comfy_root/comfyui.log"
      exit 0
    fi
    sleep 2
  done
  die "ComfyUI did not answer on 127.0.0.1:8188 within six minutes; see $comfy_root/comfyui.log"
fi

step "Executor installed at $comfy_root"
printf '    start it with: %s/.venv/bin/python %s/main.py --listen 127.0.0.1 --port 8188\n' \
  "$comfy_root" "$comfy_root"
