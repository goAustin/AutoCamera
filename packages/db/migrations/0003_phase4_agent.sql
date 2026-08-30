-- Phase 4 Pi planning-agent run and structured storyboard metadata.

ALTER TABLE agent_runs
  ADD COLUMN run_id TEXT,
  ADD COLUMN session_id TEXT,
  ADD COLUMN objective TEXT,
  ADD COLUMN provider TEXT,
  ADD COLUMN model TEXT,
  ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN provider_cost_microusd BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN updated_at TIMESTAMPTZ;

UPDATE agent_runs
SET run_id = id::text,
    session_id = id::text,
    objective = 'Legacy agent run',
    provider = 'legacy',
    model = 'legacy',
    updated_at = started_at
WHERE run_id IS NULL;

UPDATE agent_runs
SET status = CASE
  WHEN status = 'running' THEN 'running'
  WHEN status IN ('succeeded', 'completed', 'success') THEN 'succeeded'
  WHEN status IN ('aborted', 'cancelled') THEN 'aborted'
  WHEN status IN ('timed_out', 'timeout') THEN 'timed_out'
  ELSE 'failed'
END
WHERE status NOT IN ('running', 'succeeded', 'failed', 'aborted', 'timed_out');

ALTER TABLE agent_runs
  ALTER COLUMN run_id SET NOT NULL,
  ALTER COLUMN session_id SET NOT NULL,
  ALTER COLUMN objective SET NOT NULL,
  ALTER COLUMN provider SET NOT NULL,
  ALTER COLUMN model SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_status_check,
  ADD CONSTRAINT agent_runs_status_check CHECK (
    status IN ('running', 'succeeded', 'failed', 'aborted', 'timed_out')
  ),
  ADD CONSTRAINT agent_runs_objective_not_blank CHECK (length(btrim(objective)) > 0),
  ADD CONSTRAINT agent_runs_provider_not_blank CHECK (length(btrim(provider)) > 0),
  ADD CONSTRAINT agent_runs_model_not_blank CHECK (length(btrim(model)) > 0),
  ADD CONSTRAINT agent_runs_total_tokens_non_negative CHECK (total_tokens >= 0),
  ADD CONSTRAINT agent_runs_cache_read_tokens_non_negative CHECK (cache_read_tokens >= 0),
  ADD CONSTRAINT agent_runs_cache_write_tokens_non_negative CHECK (cache_write_tokens >= 0),
  ADD CONSTRAINT agent_runs_provider_cost_non_negative CHECK (provider_cost_microusd >= 0),
  ADD CONSTRAINT agent_runs_version_positive CHECK (version > 0);

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_tenant_run_id_unique
  ON agent_runs(tenant_id, run_id);

CREATE INDEX IF NOT EXISTS agent_runs_project_started_idx
  ON agent_runs(tenant_id, project_id, started_at, id);

ALTER TABLE storyboard_proposals
  ADD COLUMN objective TEXT,
  ADD COLUMN assumptions JSONB,
  ADD COLUMN risks JSONB,
  ADD COLUMN agent_run_id UUID REFERENCES agent_runs(id) ON DELETE RESTRICT;

UPDATE storyboard_proposals
SET objective = 'Legacy storyboard proposal',
    assumptions = '[]'::jsonb,
    risks = '[]'::jsonb
WHERE objective IS NULL;

ALTER TABLE storyboard_proposals
  ALTER COLUMN objective SET NOT NULL,
  ALTER COLUMN assumptions SET NOT NULL,
  ALTER COLUMN risks SET NOT NULL,
  ADD CONSTRAINT storyboard_proposals_objective_not_blank
    CHECK (length(btrim(objective)) > 0),
  ADD CONSTRAINT storyboard_proposals_assumptions_array
    CHECK (jsonb_typeof(assumptions) = 'array'),
  ADD CONSTRAINT storyboard_proposals_risks_array
    CHECK (jsonb_typeof(risks) = 'array');
