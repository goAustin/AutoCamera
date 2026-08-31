import { spawn } from 'node:child_process';
import {
  checkDatabaseReady,
  closeDatabase,
  createDatabasePool,
  runMigrations,
} from '../packages/db/src/index.ts';

function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal ? 1 : 1));
    });
  });
}

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const schemaName = `h3_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const playwrightArgs = process.argv.slice(2);
const controlPool = createDatabasePool(databaseUrl);
const databaseReady = await checkDatabaseReady(controlPool);
if (!databaseReady) {
  await closeDatabase(controlPool);
  throw new Error('PostgreSQL is required for the browser E2E journey.');
}

await controlPool.query(`CREATE SCHEMA "${schemaName}"`);
const isolatedPool = createDatabasePool(databaseUrl, {
  searchPath: schemaName,
});

try {
  await runMigrations(isolatedPool);
  const isolatedDatabaseUrl = new URL(databaseUrl);
  isolatedDatabaseUrl.searchParams.set(
    'options',
    `-c search_path=${schemaName},public`,
  );
  process.env.DATABASE_URL = isolatedDatabaseUrl.toString();

  const fixtureResult = await run('pnpm', ['media:fixture']);
  process.exitCode =
    fixtureResult !== 0
      ? fixtureResult
      : await run('pnpm', [
          'exec',
          'playwright',
          'test',
          '--config',
          'playwright.config.ts',
          ...playwrightArgs,
        ]);
} finally {
  await closeDatabase(isolatedPool);
  await controlPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
  await closeDatabase(controlPool);
}
