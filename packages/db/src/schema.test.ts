import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

describe('Phase 2 migration contract', () => {
  it('declares every required table and operational constraint', () => {
    const sql = readFileSync(
      join(migrationsDirectory, '0001_phase2_domain.sql'),
      'utf8',
    );
    for (const table of [
      'tenants',
      'video_projects',
      'storyboard_proposals',
      'shots',
      'generation_attempts',
      'workflow_versions',
      'artifacts',
      'evaluation_results',
      'agent_runs',
      'domain_events',
      'outbox_events',
      'idempotency_records',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain('UNIQUE (project_id, ordinal)');
    expect(sql).toContain('generation_attempts_comfy_prompt_id_unique');
    expect(sql).toContain('generation_attempts_one_accepted_per_shot');
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).toContain('requested_width INTEGER NOT NULL');
    expect(sql).toContain('CONSTRAINT generation_attempts_steps_positive');
    expect(sql).toContain('CONSTRAINT video_projects_budget_non_negative');
    expect(sql).toContain('CONSTRAINT video_projects_version_positive');
  });
});
