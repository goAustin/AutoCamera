import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const generatedPaths = [
  'apps/api/dist',
  'apps/fake-comfy/dist',
  'apps/web/dist',
  'packages/domain/dist',
  'packages/db/dist',
  'packages/comfy-client/dist',
  'packages/workflow-compiler/dist',
  'packages/agent-tools/dist',
  'packages/evaluator/dist',
  'packages/object-store/dist',
  'packages/telemetry/dist',
  'packages/config/dist',
  'packages/test-support/dist',
  'apps/api/tsconfig.tsbuildinfo',
  'apps/fake-comfy/tsconfig.tsbuildinfo',
  'packages/domain/tsconfig.tsbuildinfo',
  'packages/db/tsconfig.tsbuildinfo',
  'packages/comfy-client/tsconfig.tsbuildinfo',
  'packages/workflow-compiler/tsconfig.tsbuildinfo',
  'packages/agent-tools/tsconfig.tsbuildinfo',
  'packages/evaluator/tsconfig.tsbuildinfo',
  'packages/object-store/tsconfig.tsbuildinfo',
  'packages/telemetry/tsconfig.tsbuildinfo',
  'packages/config/tsconfig.tsbuildinfo',
  'packages/test-support/tsconfig.tsbuildinfo',
  'coverage',
  'playwright-report',
  'test-results',
] as const;

for (const relativePath of generatedPaths) {
  await rm(resolve(process.cwd(), relativePath), {
    recursive: true,
    force: true,
  });
}

console.log(`Removed ${generatedPaths.length} generated output locations.`);
