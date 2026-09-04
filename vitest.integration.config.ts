import baseConfig from './vitest.config.js';

export default {
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.data/comfy-frontend/**'],
  },
};
