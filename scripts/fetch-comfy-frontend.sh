#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data_root="$repository_root/.data"
pin_manifest_path="$repository_root/infra/gpu-executor/pin-manifest.json"
frontend_root="$data_root/comfy-frontend"
frontend_dist="$frontend_root/dist"
template_root="$data_root/workflow-templates"
frontend_lock_path="$repository_root/infra/gpu-executor/frontend-build.lock.json"

record_lock=0
for argument in "$@"; do
  case "$argument" in
    --record-lock)
      record_lock=1
      ;;
    *)
      printf 'Unknown option: %s\n' "$argument" >&2
      exit 2
      ;;
  esac
done

die() {
  printf 'comfy frontend: %s\n' "$1" >&2
  exit 1
}

pin_value() {
  local pin_key="$1"
  PIN_MANIFEST_PATH="$pin_manifest_path" PIN_KEY="$pin_key" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const manifest = JSON.parse(readFileSync(process.env.PIN_MANIFEST_PATH, "utf8"));
    const value = process.env.PIN_KEY.split(".").reduce((current, key) => current?.[key], manifest);
    if (typeof value !== "string" || value.length === 0) process.exit(1);
    process.stdout.write(value);
  ' || die "pin-manifest.json has no string value for $pin_key"
}

frontend_repository="$(pin_value 'comfyuiFrontend.repository')"
frontend_ref="$(pin_value 'comfyuiFrontend.ref')"
template_repository="$(pin_value 'workflowTemplates.repository')"
template_ref="$(pin_value 'workflowTemplates.ref')"
template_path="$(pin_value 'workflowTemplates.h3T2vTemplate')"

node_version="$(node --version)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
[[ "$node_major" == "24" ]] || die "Node 24 is required by this repository; found $node_version. Activate the version in .nvmrc before retrying."

mkdir -p "$data_root"

ensure_frontend_checkout() {
  if [[ ! -d "$frontend_root/.git" ]]; then
    git clone --filter=blob:none --no-checkout --depth 1 \
      "$frontend_repository" "$frontend_root"
  else
    git -C "$frontend_root" remote get-url origin >/dev/null 2>&1 ||
      git -C "$frontend_root" remote add origin "$frontend_repository"
  fi
  git -C "$frontend_root" fetch --depth 1 --filter=blob:none origin "$frontend_ref"
  git -C "$frontend_root" checkout --detach "$frontend_ref"
  [[ "$(git -C "$frontend_root" rev-parse HEAD)" == "$frontend_ref" ]] ||
    die "frontend checkout did not resolve to $frontend_ref"
}

ensure_template_checkout() {
  if [[ ! -d "$template_root/.git" ]]; then
    mkdir -p "$template_root"
    git -C "$template_root" init -q
    git -C "$template_root" remote add origin "$template_repository"
  else
    git -C "$template_root" remote get-url origin >/dev/null 2>&1 ||
      git -C "$template_root" remote add origin "$template_repository"
  fi
  git -C "$template_root" fetch --depth 1 --filter=blob:none origin "$template_ref"
  git -C "$template_root" sparse-checkout init --no-cone
  git -C "$template_root" sparse-checkout set --no-cone "/$template_path"
  git -C "$template_root" checkout --detach "$template_ref"
  [[ "$(git -C "$template_root" rev-parse HEAD)" == "$template_ref" ]] ||
    die "workflow template checkout did not resolve to $template_ref"
  [[ -f "$template_root/$template_path" ]] ||
    die "pinned workflow template is missing: $template_path"
}

run_lock_tool() {
  FRONTEND_LOCK_MODE="$1" \
    FRONTEND_LOCK_PATH="$frontend_lock_path" \
    FRONTEND_DIST_PATH="$frontend_dist" \
    FRONTEND_REPOSITORY="$frontend_repository" \
    FRONTEND_REF="$frontend_ref" \
    FRONTEND_NODE_VERSION="$node_version" \
    FRONTEND_PNPM_VERSION="$frontend_pnpm_version" \
    FRONTEND_BUILD_COMMAND="$build_command" \
    FRONTEND_TEMPLATE_REPOSITORY="$template_repository" \
    FRONTEND_TEMPLATE_REF="$template_ref" \
    FRONTEND_TEMPLATE_PATH="$template_path" \
    FRONTEND_TEMPLATE_ROOT="$template_root" \
    node --input-type=module - <<'NODE'
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const env = process.env;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = {};
let totalBytes = 0;

async function walk(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, path);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unsupported dist entry: ${path}`);
    const bytes = await readFile(path);
    const relativePath = relative(root, path).split('\\').join('/');
    files[relativePath] = sha256(bytes);
    totalBytes += bytes.byteLength;
  }
}

await walk(env.FRONTEND_DIST_PATH);
const treeInput = Object.entries(files)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, hash]) => `${path}\0${hash}\n`)
  .join('');
const treeSha256 = sha256(Buffer.from(treeInput, 'utf8'));
const templateBytes = await readFile(join(env.FRONTEND_TEMPLATE_ROOT, env.FRONTEND_TEMPLATE_PATH));
const templateSha256 = sha256(templateBytes);

if (env.FRONTEND_LOCK_MODE === 'verify') {
  const lock = JSON.parse(await readFile(env.FRONTEND_LOCK_PATH, 'utf8'));
  const failures = [];
  const expected = {
    repository: env.FRONTEND_REPOSITORY,
    commit: env.FRONTEND_REF,
    nodeVersion: env.FRONTEND_NODE_VERSION,
    pnpmVersion: env.FRONTEND_PNPM_VERSION,
    fileCount: Object.keys(files).length,
    totalBytes,
    treeSha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (lock[key] !== value) failures.push(`${key} expected ${value} got ${lock[key]}`);
  }
  if (lock.template?.repository !== env.FRONTEND_TEMPLATE_REPOSITORY) failures.push('template.repository mismatch');
  if (lock.template?.commit !== env.FRONTEND_TEMPLATE_REF) failures.push('template.commit mismatch');
  if (lock.template?.path !== env.FRONTEND_TEMPLATE_PATH) failures.push('template.path mismatch');
  if (lock.template?.sha256 !== templateSha256) failures.push('template.sha256 mismatch');
  const lockedFiles = lock.files ?? {};
  const actualPaths = Object.keys(files).sort();
  const lockedPaths = Object.keys(lockedFiles).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(lockedPaths)) failures.push('dist file list mismatch');
  for (const path of actualPaths) {
    if (lockedFiles[path] !== files[path]) failures.push(`dist hash mismatch: ${path}`);
  }
  if (failures.length > 0) throw new Error(`frontend build lock verification failed:\n${failures.join('\n')}`);
  console.log(`Verified ${actualPaths.length} frontend files (${totalBytes} bytes), tree sha256 ${treeSha256}`);
  process.exit(0);
}

const lock = {
  lockVersion: 1,
  repository: env.FRONTEND_REPOSITORY,
  commit: env.FRONTEND_REF,
  nodeVersion: env.FRONTEND_NODE_VERSION,
  pnpmVersion: env.FRONTEND_PNPM_VERSION,
  buildCommand: env.FRONTEND_BUILD_COMMAND,
  distPath: '.data/comfy-frontend/dist',
  fileCount: Object.keys(files).length,
  totalBytes,
  treeSha256,
  template: {
    repository: env.FRONTEND_TEMPLATE_REPOSITORY,
    commit: env.FRONTEND_TEMPLATE_REF,
    path: env.FRONTEND_TEMPLATE_PATH,
    sha256: templateSha256,
  },
  files,
};
await writeFile(env.FRONTEND_LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
console.log(`Recorded frontend build lock at ${env.FRONTEND_LOCK_PATH}`);
console.log(`Frontend tree sha256: ${treeSha256}`);
NODE
}

ensure_frontend_checkout
ensure_template_checkout

frontend_pnpm_version="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const packageJson = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const value = packageJson.packageManager;
  if (typeof value !== "string" || !value.startsWith("pnpm@")) process.exit(1);
  process.stdout.write(value.slice("pnpm@".length));
' "$frontend_root/package.json")" || die "pinned frontend package.json has no pnpm packageManager"
[[ "$frontend_pnpm_version" == "11.13.1" ]] ||
  die "pinned frontend requires pnpm@11.13.1; found pnpm@$frontend_pnpm_version"

build_command="FRONTEND_COMMIT_HASH=$frontend_ref DISTRIBUTION=localhost npm_config_engine_strict=false corepack pnpm@$frontend_pnpm_version typecheck && FRONTEND_COMMIT_HASH=$frontend_ref DISTRIBUTION=localhost npm_config_engine_strict=false corepack pnpm@$frontend_pnpm_version exec vite build --config vite.config.mts"

if [[ -f "$frontend_lock_path" && -d "$frontend_dist" && "$record_lock" == 0 ]]; then
  if run_lock_tool verify; then
    printf 'comfy frontend: pinned build already present and verified\n'
    exit 0
  fi
  printf 'comfy frontend: existing build does not match the pinned lock; rebuilding\n'
fi

if [[ ! -f "$frontend_lock_path" && "$record_lock" == 0 ]]; then
  die "frontend-build.lock.json is absent; run 'pnpm comfy:frontend --record-lock' once to create the tracked lock"
fi

(
  cd "$frontend_root"
  FRONTEND_COMMIT_HASH="$frontend_ref" DISTRIBUTION=localhost npm_config_engine_strict=false \
    corepack "pnpm@$frontend_pnpm_version" install --frozen-lockfile --ignore-scripts
  FRONTEND_COMMIT_HASH="$frontend_ref" DISTRIBUTION=localhost npm_config_engine_strict=false \
    corepack "pnpm@$frontend_pnpm_version" typecheck
  FRONTEND_COMMIT_HASH="$frontend_ref" DISTRIBUTION=localhost npm_config_engine_strict=false \
    corepack "pnpm@$frontend_pnpm_version" exec vite build --config vite.config.mts
)

if [[ "$record_lock" == 1 ]]; then
  run_lock_tool record
else
  run_lock_tool verify
fi

printf 'comfy frontend: source and build remain under %s (ignored)\n' "$data_root"
