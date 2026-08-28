import { Pool } from 'pg';

export function createDatabasePool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    application_name: 'h3-videoops-api',
  });
}

export async function checkDatabaseReady(
  pool: Pick<Pool, 'query'>,
): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query('BEGIN');

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS h3_schema_migrations (
        migration_id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(
      `INSERT INTO h3_schema_migrations (migration_id)
       VALUES ($1)
       ON CONFLICT (migration_id) DO NOTHING`,
      ['0000_bootstrap_placeholder'],
    );
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

export async function closeDatabase(pool: Pool): Promise<void> {
  await pool.end();
}

/**
 * Test teardown intentionally only closes connections in Phase 1. Business
 * tables and destructive test cleanup are introduced with the domain schema.
 */
export async function teardownTestDatabase(pool: Pool): Promise<void> {
  await closeDatabase(pool);
}
