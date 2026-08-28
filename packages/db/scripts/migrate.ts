import {
  createDatabasePool,
  closeDatabase,
  runMigrations,
} from '../src/index.ts';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const pool = createDatabasePool(databaseUrl);

try {
  await runMigrations(pool);
  console.log('Database migrations are up to date.');
} finally {
  await closeDatabase(pool);
}
