import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = process.cwd();

const aliases = {
  '@h3/agent-tools': resolve(root, 'packages/agent-tools/src/index.ts'),
  '@h3/comfy-client': resolve(root, 'packages/comfy-client/src/index.ts'),
  '@h3/config': resolve(root, 'packages/config/src/index.ts'),
  '@h3/db': resolve(root, 'packages/db/src/index.ts'),
  '@h3/domain': resolve(root, 'packages/domain/src/index.ts'),
  '@h3/evaluator': resolve(root, 'packages/evaluator/src/index.ts'),
  '@h3/object-store': resolve(root, 'packages/object-store/src/index.ts'),
  '@h3/telemetry': resolve(root, 'packages/telemetry/src/index.ts'),
  '@h3/test-support': resolve(root, 'packages/test-support/src/index.ts'),
  '@h3/workflow-compiler': resolve(
    root,
    'packages/workflow-compiler/src/index.ts',
  ),
};

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: [
      '**/*.integration.test.ts',
      '**/node_modules/**',
      '**/dist/**',
      '.data/comfy-frontend/**',
    ],
  },
});
