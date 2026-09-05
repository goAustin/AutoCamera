import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseUsdToMicrousd } from '../packages/domain/src/index.ts';
import {
  closeDatabase,
  createDatabasePool,
  createPostgresStore,
  runMigrations,
} from '../packages/db/src/index.ts';
import { getApiConfig } from '../packages/config/src/index.ts';
import {
  DEV_TENANT_ID,
  ProjectApplicationService,
} from '../apps/api/src/application.ts';
import {
  artifactPath,
  assertDevelopmentDatabase,
  assertSafeArtifactRoot,
  redactedDatabaseTarget,
} from './demo-safety.ts';

export const DEMO_PROJECT_TITLE = '[Demo] Product story control room';
export const DEMO_PROJECT_BRIEF =
  'A calm product story showing how a small team turns an idea into a reviewable video preview.';
export const DEMO_TRACE_ID = '00000000000000000000000000000006';
const DEMO_IDEMPOTENCY_KEY = 'demo-seed-project-v1';

function loadLocalEnvironment(): void {
  try {
    for (const line of readFileSync(
      resolve(process.cwd(), '.env'),
      'utf8',
    ).split('\n')) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const [, name, rawValue] = match;
      if (!name || rawValue === undefined || process.env[name] !== undefined) {
        continue;
      }
      process.env[name] = rawValue.replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    // The config defaults are sufficient for a test database; .env is optional.
  }
}

async function seed(): Promise<void> {
  const config = getApiConfig({
    ...process.env,
    DEV_AUTH_TOKEN: process.env.DEV_AUTH_TOKEN ?? 'demo-local-token',
  });
  const pool = createDatabasePool(config.databaseUrl);
  try {
    await runMigrations(pool);
    const existing = await pool.query<{ id: string }>(
      'SELECT id FROM video_projects WHERE tenant_id = $1 AND title = $2 LIMIT 1',
      [DEV_TENANT_ID, DEMO_PROJECT_TITLE],
    );
    if (existing.rows[0]) {
      console.log(
        'Demo project already exists (alias demo-project); no changes made.',
      );
      return;
    }
    const store = createPostgresStore(pool);
    const service = new ProjectApplicationService({
      store,
      tenantId: DEV_TENANT_ID,
      defaultBudgetMicrousd: parseUsdToMicrousd('25.00'),
    });
    const project = await service.createProject({
      title: DEMO_PROJECT_TITLE,
      brief: DEMO_PROJECT_BRIEF,
      targetDurationSeconds: 15,
      budgetMicrousd: parseUsdToMicrousd('25.00'),
      traceId: DEMO_TRACE_ID,
    });
    console.log(
      `Seeded deterministic demo alias demo-project (${project.status}); submit a graph through POST /v1/runs to generate.`,
    );
  } finally {
    await closeDatabase(pool);
  }
}

async function reset(force: boolean): Promise<void> {
  const config = getApiConfig({
    ...process.env,
    DEV_AUTH_TOKEN: process.env.DEV_AUTH_TOKEN ?? 'demo-local-token',
  });
  const artifactRoot = assertSafeArtifactRoot(config.artifactRoot);
  assertDevelopmentDatabase(config.databaseUrl);
  console.log(
    `Reset target database: ${redactedDatabaseTarget(config.databaseUrl)}`,
  );
  console.log(`Reset target tenant: ${DEV_TENANT_ID}`);
  console.log(`Reset target artifact root: ${artifactRoot}`);
  if (!force) {
    throw new Error('Reset refused: pass --force after reviewing the target.');
  }

  const pool = createDatabasePool(config.databaseUrl);
  let artifactKeys: string[] = [];
  try {
    await runMigrations(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const projectResult = await client.query<{ id: string }>(
        'SELECT id FROM video_projects WHERE tenant_id = $1 AND title = $2 FOR UPDATE',
        [DEV_TENANT_ID, DEMO_PROJECT_TITLE],
      );
      const projectId = projectResult.rows[0]?.id;
      if (!projectId) {
        await client.query('ROLLBACK');
        console.log('Demo project is already absent; no changes made.');
        return;
      }

      await client.query(
        `CREATE TEMP TABLE h3_demo_workflow_versions ON COMMIT DROP AS
         SELECT DISTINCT workflow_version_id
         FROM generation_attempts
         WHERE tenant_id = $1 AND project_id = $2 AND workflow_version_id IS NOT NULL`,
        [DEV_TENANT_ID, projectId],
      );
      const artifacts = await client.query<{ object_key: string }>(
        'SELECT object_key FROM artifacts WHERE tenant_id = $1 AND project_id = $2',
        [DEV_TENANT_ID, projectId],
      );
      artifactKeys = artifacts.rows.map((row) => row.object_key);

      await client.query(
        'UPDATE shots SET accepted_attempt_id = NULL WHERE project_id = $1',
        [projectId],
      );
      await client.query(
        'DELETE FROM operational_recommendations WHERE tenant_id = $1 AND project_id = $2',
        [DEV_TENANT_ID, projectId],
      );
      await client.query(
        'DELETE FROM evaluation_results WHERE tenant_id = $1 AND project_id = $2',
        [DEV_TENANT_ID, projectId],
      );
      await client.query(
        'DELETE FROM artifacts WHERE tenant_id = $1 AND project_id = $2',
        [DEV_TENANT_ID, projectId],
      );
      await client.query(
        'DELETE FROM generation_attempts WHERE tenant_id = $1 AND project_id = $2',
        [DEV_TENANT_ID, projectId],
      );
      await client.query(
        'UPDATE workflow_drafts SET base_revision_id = NULL WHERE tenant_id = $1 AND project_id = $2',
        [DEV_TENANT_ID, projectId],
      );
      await client.query(
        'DELETE FROM workflow_drafts WHERE tenant_id = $1 AND project_id = $2',
        [DEV_TENANT_ID, projectId],
      );
      await client.query(
        'UPDATE workflow_revisions SET parent_revision_id = NULL WHERE tenant_id = $1 AND project_id = $2',
        [DEV_TENANT_ID, projectId],
      );
      await client.query(
        'DELETE FROM workflow_revisions WHERE tenant_id = $1 AND project_id = $2',
        [DEV_TENANT_ID, projectId],
      );
      await client.query('DELETE FROM shots WHERE project_id = $1', [
        projectId,
      ]);
      await client.query(
        'DELETE FROM agent_runs WHERE tenant_id = $1 AND project_id = $2',
        [DEV_TENANT_ID, projectId],
      );
      await client.query(
        `DELETE FROM outbox_events
         WHERE event_id IN (
           SELECT id FROM domain_events WHERE tenant_id = $1 AND project_id = $2
         )`,
        [DEV_TENANT_ID, projectId],
      );
      await client.query(
        'DELETE FROM domain_events WHERE tenant_id = $1 AND project_id = $2',
        [DEV_TENANT_ID, projectId],
      );
      await client.query(
        'DELETE FROM idempotency_records WHERE tenant_id = $1 AND idempotency_key = $2',
        [DEV_TENANT_ID, DEMO_IDEMPOTENCY_KEY],
      );
      await client.query(
        'DELETE FROM video_projects WHERE tenant_id = $1 AND id = $2',
        [DEV_TENANT_ID, projectId],
      );
      await client.query(
        `DELETE FROM workflow_versions AS versions
         USING h3_demo_workflow_versions AS demo
         WHERE versions.id = demo.workflow_version_id
           AND NOT EXISTS (
             SELECT 1 FROM generation_attempts AS attempts
             WHERE attempts.workflow_version_id = versions.id
           )`,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await closeDatabase(pool);
  }

  for (const objectKey of artifactKeys) {
    await rm(artifactPath(artifactRoot, objectKey), { force: true });
  }
  console.log(
    `Reset demo-project only; unrelated projects and non-demo artifacts were preserved (${artifactKeys.length} artifact object(s) removed).`,
  );
}

loadLocalEnvironment();
const [command, ...args] = process.argv.slice(2);
if (command === 'seed') {
  await seed();
} else if (command === 'reset') {
  await reset(args.includes('--force'));
} else {
  console.error('Usage: pnpm demo:seed | pnpm demo:reset -- --force');
  process.exitCode = 2;
}
