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

  it('declares the Phase 3 generation, artifact, and evaluation durability contract', () => {
    const sql = readFileSync(
      join(migrationsDirectory, '0002_phase3_generation.sql'),
      'utf8',
    );
    expect(sql).toContain('ADD COLUMN correlation_id TEXT');
    expect(sql).toContain('ADD COLUMN source_attempt_id UUID');
    expect(sql).toContain('ADD COLUMN artifact_id UUID');
    expect(sql).toContain('workflow_versions_hash_unique');
    expect(sql).toContain('generation_attempts_idempotency_key_unique');
    expect(sql).toContain('artifacts_attempt_unique');
    expect(sql).toContain('generation_attempts_queue_idx');
    expect(sql).toContain('generation_attempts_failure_message_bounded');
  });

  it('declares the Phase 4 agent-run and storyboard metadata contract', () => {
    const sql = readFileSync(
      join(migrationsDirectory, '0003_phase4_agent.sql'),
      'utf8',
    );
    for (const column of [
      'run_id',
      'session_id',
      'objective',
      'provider',
      'model',
      'total_tokens',
      'provider_cost_microusd',
      'agent_run_id',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain("'timed_out'");
    expect(sql).toContain('agent_runs_tenant_run_id_unique');
    expect(sql).toContain('storyboard_proposals_assumptions_array');
  });

  it('declares the Phase 5 Checkpoint 1 persistence and recovery contract', () => {
    const sql = readFileSync(
      join(migrationsDirectory, '0004_phase5_project_studio.sql'),
      'utf8',
    );
    for (const table of [
      'workflow_drafts',
      'workflow_revisions',
      'operational_recommendations',
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }
    for (const column of [
      'visual_description',
      'camera_direction',
      'audio_direction',
      'dialogue',
      'acceptance_criteria',
      'required_asset_ids',
      'workflow_revision_id',
      'parent_revision_id',
      'execution_hash',
      'validation_errors_json',
      'trigger_event_id',
      'proposed_action_type',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain("proposal.status = 'approved'");
    expect(sql).toContain("definition.value->>'ordinal' = s.ordinal::text");
    expect(sql).toContain('workflow_revisions_immutable_trigger');
    expect(sql).toContain('workflow_revisions_profile_hash_scope_unique');
    expect(sql).toContain('operational_recommendations_event_code_unique');
    expect(sql).toContain("'needs_attention'");
    expect(sql).toContain("'retryable'");
  });
});
