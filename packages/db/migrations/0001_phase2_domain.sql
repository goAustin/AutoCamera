-- Phase 2 durable domain, workflow, event, outbox, and idempotency schema.

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT tenants_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE TABLE IF NOT EXISTS video_projects (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL,
  target_duration_seconds NUMERIC(12, 3) NOT NULL,
  budget_microusd BIGINT NOT NULL,
  spent_microusd BIGINT NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT video_projects_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT video_projects_brief_not_blank CHECK (length(btrim(brief)) > 0),
  CONSTRAINT video_projects_status_check CHECK (
    status IN (
      'draft',
      'planning',
      'awaiting_storyboard_approval',
      'ready_for_generation',
      'generating',
      'awaiting_final_review',
      'failed',
      'cancelled',
      'completed'
    )
  ),
  CONSTRAINT video_projects_duration_positive CHECK (target_duration_seconds > 0),
  CONSTRAINT video_projects_budget_non_negative CHECK (budget_microusd >= 0),
  CONSTRAINT video_projects_spent_non_negative CHECK (spent_microusd >= 0),
  CONSTRAINT video_projects_version_positive CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS storyboard_proposals (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES video_projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  shot_definitions JSONB NOT NULL,
  total_duration_seconds NUMERIC(12, 3) NOT NULL,
  duration_tolerance_seconds NUMERIC(12, 3) NOT NULL DEFAULT 0.05,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT storyboard_proposals_revision_positive CHECK (revision > 0),
  CONSTRAINT storyboard_proposals_status_check CHECK (
    status IN ('proposed', 'approved', 'superseded')
  ),
  CONSTRAINT storyboard_proposals_duration_positive CHECK (total_duration_seconds > 0),
  CONSTRAINT storyboard_proposals_tolerance_non_negative CHECK (duration_tolerance_seconds >= 0),
  CONSTRAINT storyboard_proposals_version_positive CHECK (version > 0),
  CONSTRAINT storyboard_proposals_project_revision_unique UNIQUE (project_id, revision)
);

CREATE UNIQUE INDEX IF NOT EXISTS storyboard_proposals_one_approved_per_project
  ON storyboard_proposals(project_id)
  WHERE status = 'approved';

CREATE TABLE IF NOT EXISTS shots (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES video_projects(id) ON DELETE RESTRICT,
  storyboard_proposal_id UUID NOT NULL REFERENCES storyboard_proposals(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  prompt TEXT NOT NULL,
  duration_seconds NUMERIC(12, 3) NOT NULL,
  mode TEXT NOT NULL DEFAULT 't2v',
  quality_tier TEXT NOT NULL DEFAULT 'preview',
  status TEXT NOT NULL,
  accepted_attempt_id UUID,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT shots_ordinal_range CHECK (ordinal BETWEEN 1 AND 3),
  CONSTRAINT shots_project_ordinal_unique UNIQUE (project_id, ordinal),
  CONSTRAINT shots_purpose_not_blank CHECK (length(btrim(purpose)) > 0),
  CONSTRAINT shots_prompt_not_blank CHECK (length(btrim(prompt)) > 0),
  CONSTRAINT shots_duration_positive CHECK (duration_seconds > 0),
  CONSTRAINT shots_mode_check CHECK (mode = 't2v'),
  CONSTRAINT shots_quality_tier_check CHECK (quality_tier = 'preview'),
  CONSTRAINT shots_status_check CHECK (
    status IN (
      'draft',
      'approved_for_generation',
      'queued',
      'generating',
      'awaiting_review',
      'accepted',
      'rejected',
      'failed',
      'cancelled'
    )
  ),
  CONSTRAINT shots_version_positive CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id UUID PRIMARY KEY,
  version TEXT NOT NULL,
  workflow_hash TEXT NOT NULL,
  workflow_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT workflow_versions_version_not_blank CHECK (length(btrim(version)) > 0),
  CONSTRAINT workflow_versions_hash_not_blank CHECK (length(btrim(workflow_hash)) > 0),
  CONSTRAINT workflow_versions_version_hash_unique UNIQUE (version, workflow_hash)
);

CREATE TABLE IF NOT EXISTS generation_attempts (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES video_projects(id) ON DELETE RESTRICT,
  shot_id UUID NOT NULL REFERENCES shots(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  seed BIGINT NOT NULL,
  steps INTEGER NOT NULL,
  requested_width INTEGER NOT NULL,
  requested_height INTEGER NOT NULL,
  requested_duration_seconds NUMERIC(12, 3) NOT NULL,
  workflow_version_id UUID REFERENCES workflow_versions(id) ON DELETE RESTRICT,
  workflow_hash TEXT NOT NULL,
  comfy_prompt_id TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  queued_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  compute_seconds NUMERIC(12, 3),
  estimated_cost_microusd BIGINT NOT NULL DEFAULT 0,
  failure_code TEXT,
  failure_message TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT generation_attempts_status_check CHECK (
    status IN (
      'queued',
      'claimed',
      'submitting',
      'submitted',
      'running',
      'generated',
      'evaluating',
      'awaiting_review',
      'accepted',
      'rejected',
      'failed',
      'timed_out',
      'cancelled'
    )
  ),
  CONSTRAINT generation_attempts_steps_positive CHECK (steps > 0),
  CONSTRAINT generation_attempts_width_positive CHECK (requested_width > 0),
  CONSTRAINT generation_attempts_height_positive CHECK (requested_height > 0),
  CONSTRAINT generation_attempts_duration_positive CHECK (requested_duration_seconds > 0),
  CONSTRAINT generation_attempts_cost_non_negative CHECK (estimated_cost_microusd >= 0),
  CONSTRAINT generation_attempts_version_positive CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS generation_attempts_comfy_prompt_id_unique
  ON generation_attempts(comfy_prompt_id)
  WHERE comfy_prompt_id IS NOT NULL;

ALTER TABLE shots
  ADD CONSTRAINT shots_accepted_attempt_fk
  FOREIGN KEY (accepted_attempt_id) REFERENCES generation_attempts(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS generation_attempts_one_accepted_per_shot
  ON generation_attempts(shot_id)
  WHERE status = 'accepted';

CREATE TABLE IF NOT EXISTS artifacts (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES video_projects(id) ON DELETE RESTRICT,
  shot_id UUID NOT NULL REFERENCES shots(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES generation_attempts(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT artifacts_object_key_not_blank CHECK (length(btrim(object_key)) > 0),
  CONSTRAINT artifacts_mime_type_not_blank CHECK (length(btrim(mime_type)) > 0),
  CONSTRAINT artifacts_byte_size_positive CHECK (byte_size > 0),
  CONSTRAINT artifacts_sha256_hex CHECK (sha256 ~ '^[0-9a-fA-F]{64}$')
);

CREATE TABLE IF NOT EXISTS evaluation_results (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES video_projects(id) ON DELETE RESTRICT,
  shot_id UUID NOT NULL REFERENCES shots(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES generation_attempts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  details JSONB NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT evaluation_results_status_check CHECK (status IN ('passed', 'failed')),
  CONSTRAINT evaluation_results_attempt_unique UNIQUE (attempt_id)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES video_projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  failure_code TEXT,
  CONSTRAINT agent_runs_status_not_blank CHECK (length(btrim(status)) > 0),
  CONSTRAINT agent_runs_tool_calls_non_negative CHECK (tool_calls >= 0),
  CONSTRAINT agent_runs_input_tokens_non_negative CHECK (input_tokens >= 0),
  CONSTRAINT agent_runs_output_tokens_non_negative CHECK (output_tokens >= 0)
);

CREATE TABLE IF NOT EXISTS domain_events (
  id UUID PRIMARY KEY,
  event_sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  producer TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id UUID REFERENCES video_projects(id) ON DELETE RESTRICT,
  shot_id UUID REFERENCES shots(id) ON DELETE RESTRICT,
  attempt_id UUID REFERENCES generation_attempts(id) ON DELETE RESTRICT,
  prompt_id TEXT,
  trace_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT domain_events_type_not_blank CHECK (length(btrim(type)) > 0),
  CONSTRAINT domain_events_version_positive CHECK (version > 0),
  CONSTRAINT domain_events_producer_not_blank CHECK (length(btrim(producer)) > 0)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE REFERENCES domain_events(id) ON DELETE RESTRICT,
  available_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  CONSTRAINT outbox_events_attempt_count_non_negative CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS outbox_events_pending_idx
  ON outbox_events(available_at, id)
  WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS idempotency_records (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, idempotency_key),
  CONSTRAINT idempotency_records_key_not_blank CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT idempotency_records_operation_not_blank CHECK (length(btrim(operation)) > 0),
  CONSTRAINT idempotency_records_hash_hex CHECK (request_hash ~ '^[0-9a-fA-F]{64}$'),
  CONSTRAINT idempotency_records_response_status_valid CHECK (
    response_status IS NULL OR response_status BETWEEN 100 AND 599
  ),
  CONSTRAINT idempotency_records_completion_consistent CHECK (
    (response_status IS NULL AND response_body IS NULL AND completed_at IS NULL)
    OR (response_status IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL)
  )
);
