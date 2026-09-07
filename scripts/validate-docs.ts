import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());

async function exists(relativePath: string): Promise<boolean> {
  try {
    await access(resolve(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function requiredText(relativePath: string): Promise<string> {
  if (!(await exists(relativePath))) {
    throw new Error(`Documentation file is missing: ${relativePath}`);
  }
  return readFile(resolve(root, relativePath), 'utf8');
}

const readme = await requiredText('README.md');
const architecture = await requiredText('ARCHITECTURE.md');
const demo = await requiredText('DEMO-SCRIPT.md');
const evidence = await requiredText('EVIDENCE-MANIFEST.md');
const dependencies = await requiredText('DEPENDENCIES.md');
const status = await requiredText('STATUS.md');
const changelog = await requiredText('CHANGELOG.md');

// Phase-completion phrases are deliberately absent. They went stale the moment
// the next checkpoint landed, and the README is a user-facing document rather
// than a checkpoint ledger. Phase status lives in STATUS.md; capture provenance
// lives in EVIDENCE-MANIFEST.md.
for (const phrase of [
  'Offline fake',
  'Phase 8',
  'Project Studio',
  'ComfyUI',
  'VideoOps',
  'MiniMax H3',
  'Pi',
  'pnpm demo:seed',
  'pnpm comfy:frontend',
  '@comfy-frontend',
  'pnpm test:e2e',
  'pnpm observability:up',
  'pnpm security:scan',
  'ComfyUI-first',
  'token isolation',
]) {
  if (!readme.includes(phrase)) {
    throw new Error(`README is missing required release language: ${phrase}`);
  }
}

for (const phrase of [
  'browser',
  'private',
  'POST /prompt',
  'immutable',
  'artifact',
  'human approval',
]) {
  if (!architecture.toLowerCase().includes(phrase.toLowerCase())) {
    throw new Error(`Architecture document is missing: ${phrase}`);
  }
}

for (const phrase of [
  'Mandatory offline fake walkthrough',
  'Optional live ComfyUI contract walkthrough',
  'Generate managed',
  'retryable failure',
  'trace',
  'evidence level',
]) {
  if (!demo.toLowerCase().includes(phrase.toLowerCase())) {
    throw new Error(`Demo script is missing: ${phrase}`);
  }
}

for (const phrase of [
  'offline-fake',
  'capture command',
  'secret review',
  'demo-project',
  'h3-videoops-phase6',
  'pinned ComfyUI editor',
  'H3 inference',
  '@comfy-frontend',
]) {
  if (!evidence.toLowerCase().includes(phrase.toLowerCase())) {
    throw new Error(`Evidence manifest is missing: ${phrase}`);
  }
}

for (const phrase of [
  'ComfyUI backend',
  'ComfyUI frontend',
  'MiniMax H3',
  'Pi package',
  'License status',
  '0.84.4',
]) {
  if (!dependencies.includes(phrase)) {
    throw new Error(`Dependency evidence is missing: ${phrase}`);
  }
}

// 'Phase 6' was dropped for the same reason as the README's completed-phase
// phrases: requiring it forced the document to carry a historical section for a
// finished phase. 'Phase 8' stays because it names work that is still deferred.
for (const phrase of ['Phase 8', 'offline fake', 'live ComfyUI']) {
  if (!status.toLowerCase().includes(phrase.toLowerCase())) {
    throw new Error(`Status document is missing: ${phrase}`);
  }
}

if (!changelog.includes('v0.1.0-mvp')) {
  throw new Error('Changelog is missing the v0.1.0-mvp entry.');
}

// Every published capture must exist and be accounted for in the provenance
// manifest -- capture command, evidence level, and secret review. The README
// only has to cite the ones it actually displays; enumerating all of them there
// turned it into an evidence ledger rather than a description of the product.
const screenshotNames = [
  '01-run-history.png',
  '02-artifact-review.png',
  '03-run-accepted.png',
  '04-recoverable-failure.png',
  '05-retry-derived.png',
  '06-finding-apply-confirmation.png',
  '07-run-history-complete.png',
  '09-grafana-dashboard.png',
  'comfy-frontend/01-editor-loaded.png',
  'comfy-frontend/02-h3-template-open.png',
  'comfy-frontend/04-videoops-sidebar.png',
  'comfy-frontend/05-videoops-managed-run.png',
];
for (const name of screenshotNames) {
  const path = `assets/screenshots/${name}`;
  if (!(await exists(path))) throw new Error(`Screenshot is missing: ${path}`);
  if (!evidence.includes(name)) {
    throw new Error(
      `Evidence manifest does not account for screenshot: ${name}`,
    );
  }
}

const readmeScreenshotNames = [
  '01-run-history.png',
  'comfy-frontend/05-videoops-managed-run.png',
];
for (const name of readmeScreenshotNames) {
  if (!readme.includes(name)) {
    throw new Error(`README does not reference screenshot: ${name}`);
  }
}

if (readme.includes('Phase 5 local implementation in progress')) {
  throw new Error('README still contains bootstrap-era Phase 5 status.');
}

console.log(
  `PASS documentation: release docs, ${screenshotNames.length} captures accounted for in the provenance manifest, and status language validated.`,
);
