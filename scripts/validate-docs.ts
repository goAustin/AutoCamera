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
const resume = await requiredText('RESUME.md');
const changelog = await requiredText('CHANGELOG.md');

for (const phrase of [
  'Phase 7C complete',
  'Phase 7B complete',
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

for (const phrase of ['Phase 6', 'Phase 8', 'offline fake', 'live ComfyUI']) {
  if (!status.toLowerCase().includes(phrase.toLowerCase())) {
    throw new Error(`Status document is missing: ${phrase}`);
  }
}

if (!resume.includes('immutable workflow revisions')) {
  throw new Error('Resume bullets are missing the revision claim.');
}
if (!changelog.includes('v0.1.0-mvp')) {
  throw new Error('Changelog is missing the v0.1.0-mvp entry.');
}

const screenshotNames = [
  '01-project-create.png',
  '02-storyboard-approved.png',
  '03-managed-workflow.png',
  '04-revision-history.png',
  '05-attempt-progress.png',
  '06-artifact-review.png',
  '07-timeline-recommendation.png',
  '08-completed-project.png',
  '09-grafana-dashboard.png',
];
for (const name of screenshotNames) {
  const path = `assets/screenshots/${name}`;
  if (!(await exists(path))) throw new Error(`Screenshot is missing: ${path}`);
  if (!readme.includes(name)) {
    throw new Error(`README does not reference screenshot: ${name}`);
  }
}

const editorScreenshotNames = [
  'comfy-frontend/01-editor-loaded.png',
  'comfy-frontend/02-h3-template-open.png',
  'comfy-frontend/03-graph-to-prompt.png',
];
for (const name of editorScreenshotNames) {
  const path = `assets/screenshots/${name}`;
  if (!(await exists(path))) throw new Error(`Screenshot is missing: ${path}`);
  if (!readme.includes(name)) {
    throw new Error(`README does not reference screenshot: ${name}`);
  }
}

const inversionScreenshotNames = [
  'comfy-frontend/04-videoops-sidebar.png',
  'comfy-frontend/05-videoops-managed-run.png',
];
for (const name of inversionScreenshotNames) {
  const path = `assets/screenshots/${name}`;
  if (!(await exists(path))) throw new Error(`Screenshot is missing: ${path}`);
  if (!evidence.includes(name)) {
    throw new Error(`Evidence manifest does not reference screenshot: ${name}`);
  }
}

if (readme.includes('Phase 5 local implementation in progress')) {
  throw new Error('README still contains bootstrap-era Phase 5 status.');
}

console.log(
  `PASS documentation: release docs, ${screenshotNames.length} offline screenshots, ${editorScreenshotNames.length} editor screenshots, and status language validated.`,
);
