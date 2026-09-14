import baseConfig from './vitest.config.js';

export default {
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.data/comfy-frontend/**'],
    // Vitest's 10s hook / 5s test defaults are sized for in-memory work. These
    // files each open a real pool and call `runMigrations`, which takes a
    // database-wide advisory lock on purpose, so on a cold database every
    // worker's setup queues behind every other one's. A developer machine
    // hides it -- the database was migrated days ago and each pass is a no-op
    // -- while CI provisions an empty PostgreSQL every run and pays the full
    // serialized cost. The suite finishes in about four seconds; this is
    // headroom for the cold case, not permission to be slow.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
};
