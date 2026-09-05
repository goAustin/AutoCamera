import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkDatabaseReady,
  createDatabasePool,
  runMigrations,
} from './index.js';

// Phase 7D, step 4: migration 0009 drops `storyboard_proposals` and
// `shots.storyboard_proposal_id`. This file is the "verify the migration
// applies cleanly both to a database that has been through Phase 7C and to
// an empty one" requirement from `74-PHASE-7D-REMOVE-BRIEF-FIRST.md`.
//
// Neither test mutates the real `migrations/` directory (no renaming files
// out of the way) -- migration 0000-0008's SQL is read and applied directly
// so a "Phase 7C database" can be simulated without disturbing the shared
// migration set that other tests and `runMigrations` itself rely on.

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const controlPool = createDatabasePool(databaseUrl);
const databaseAvailable = await checkDatabaseReady(controlPool);
const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

async function applyMigrationsThrough(
  pool: ReturnType<typeof createDatabasePool>,
  lastMigrationId: string,
): Promise<void> {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file <= `${lastMigrationId}.sql`)
    .sort();
  for (const file of files) {
    const sql = await readFile(`${migrationsDir}${file}`, 'utf8');
    await pool.query(sql);
  }
}

describe.skipIf(!databaseAvailable)('migration 0009', () => {
  it('converts a real non-implicit shot to implicit rather than dropping it, on a Phase 7C database', async () => {
    const schemaName = `h3_m9_a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await controlPool.query(`CREATE SCHEMA "${schemaName}"`);
    const pool = createDatabasePool(databaseUrl, { searchPath: schemaName });
    try {
      // Simulate "a database that has been through Phase 7C": apply every
      // migration through 0008, but not 0009 yet.
      await applyMigrationsThrough(
        pool,
        '0008_phase7_pin_separate_from_acceptance',
      );

      // Seed exactly the kind of row 0009 must not silently destroy: a real
      // storyboard-materialized (non-implicit) shot tied to an approved
      // proposal, exactly as `approveStoryboardInTransaction` used to write
      // before this checkpoint removed it.
      await pool.query(`
        INSERT INTO tenants (id, name, created_at)
        VALUES ('00000000-0000-7000-8000-000000000099', 'Migration test tenant', now())
      `);
      await pool.query(`
        INSERT INTO video_projects (
          id, tenant_id, title, brief, status, target_duration_seconds,
          budget_microusd, spent_microusd, version, created_at, updated_at
        ) VALUES (
          '00000000-0000-7000-8000-000000000098',
          '00000000-0000-7000-8000-000000000099',
          'Phase 7C project', 'A pre-existing brief.', 'ready_for_generation', 5,
          25000000, 0, 1, now(), now()
        )
      `);
      await pool.query(`
        INSERT INTO storyboard_proposals (
          id, project_id, revision, status, shot_definitions,
          total_duration_seconds, duration_tolerance_seconds, objective,
          assumptions, risks, version, created_at, updated_at
        ) VALUES (
          '00000000-0000-7000-8000-000000000097',
          '00000000-0000-7000-8000-000000000098',
          1, 'approved', '[]'::jsonb, 5, 0.05, 'Phase 7C objective',
          '[]'::jsonb, '[]'::jsonb, 1, now(), now()
        )
      `);
      await pool.query(`
        INSERT INTO shots (
          id, project_id, storyboard_proposal_id, ordinal, purpose, prompt,
          duration_seconds, mode, quality_tier, status, version, implicit,
          created_at, updated_at
        ) VALUES (
          '00000000-0000-7000-8000-000000000096',
          '00000000-0000-7000-8000-000000000098',
          '00000000-0000-7000-8000-000000000097',
          1, 'Establish the hook', 'A prompt.', 2, 't2v', 'preview',
          'approved_for_generation', 1, FALSE, now(), now()
        )
      `);

      // The pre-drop assertion the checkpoint requires.
      const preDrop = await pool.query<{ count: string }>(
        'SELECT count(*) FROM shots WHERE implicit = FALSE',
      );
      expect(Number(preDrop.rows[0]?.count)).toBe(1);

      // `runMigrations` sees 0000-0008 already applied to this schema (their
      // rows exist, but the tracking table does not yet) -- create the
      // tracking table it expects and back-fill it, then let it apply only
      // the one migration that is actually new: 0009.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS h3_schema_migrations (
          migration_id TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const alreadyApplied = (await readdir(migrationsDir))
        .filter(
          (file) =>
            file.endsWith('.sql') &&
            file <= '0008_phase7_pin_separate_from_acceptance.sql',
        )
        .map((file) => file.replace(/\.sql$/, ''));
      for (const migrationId of alreadyApplied) {
        await pool.query(
          'INSERT INTO h3_schema_migrations (migration_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [migrationId],
        );
      }
      await runMigrations(pool);

      const postDrop = await pool.query<{ implicit: boolean }>(
        'SELECT implicit FROM shots WHERE id = $1',
        ['00000000-0000-7000-8000-000000000096'],
      );
      expect(postDrop.rows).toHaveLength(1);
      expect(postDrop.rows[0]?.implicit).toBe(true);

      const table = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = 'storyboard_proposals'`,
        [schemaName],
      );
      expect(table.rows).toHaveLength(0);

      const column = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'shots'
           AND column_name = 'storyboard_proposal_id'`,
        [schemaName],
      );
      expect(column.rows).toHaveLength(0);

      const constraint = await pool.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
         WHERE connamespace = $1::regnamespace
           AND conname = 'shots_implicit_proposal_consistent'`,
        [schemaName],
      );
      expect(constraint.rows).toHaveLength(0);
    } finally {
      await pool.end();
      await controlPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    }
  });

  it('applies cleanly to an empty database (0000 through 0009 in one pass)', async () => {
    const schemaName = `h3_m9_b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await controlPool.query(`CREATE SCHEMA "${schemaName}"`);
    const pool = createDatabasePool(databaseUrl, { searchPath: schemaName });
    try {
      await runMigrations(pool);
      const applied = await pool.query<{ migration_id: string }>(
        'SELECT migration_id FROM h3_schema_migrations ORDER BY migration_id',
      );
      expect(applied.rows.map((row) => row.migration_id)).toContain(
        '0009_phase7d_remove_storyboard',
      );

      const table = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = 'storyboard_proposals'`,
        [schemaName],
      );
      expect(table.rows).toHaveLength(0);

      const column = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'shots'
           AND column_name = 'storyboard_proposal_id'`,
        [schemaName],
      );
      expect(column.rows).toHaveLength(0);

      // Re-running is idempotent: already-applied migrations are skipped.
      await runMigrations(pool);
    } finally {
      await pool.end();
      await controlPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    }
  });
});
