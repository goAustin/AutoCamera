-- Phase 5 Checkpoint 1: structured shot persistence, managed workflow
-- lineage, recoverable states, and durable operator recommendations.
-- This migration is forward-only. Migrations 0000 through 0003 are not edited.

CREATE OR REPLACE FUNCTION h3_is_bounded_string_array(
  value JSONB,
  max_items INTEGER,
  max_item_length INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item JSONB;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'array' THEN
    RETURN FALSE;
  END IF;
  IF jsonb_array_length(value) > max_items THEN
    RETURN FALSE;
  END IF;
  FOR item IN SELECT element FROM jsonb_array_elements(value) AS elements(element) LOOP
    IF jsonb_typeof(item) <> 'string'
      OR length(btrim(item #>> '{}')) = 0
      OR length(item #>> '{}') > max_item_length THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION h3_is_bounded_evidence_references(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item JSONB;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'array' THEN
    RETURN FALSE;
  END IF;
  IF jsonb_array_length(value) > 32 THEN
    RETURN FALSE;
  END IF;
  FOR item IN SELECT element FROM jsonb_array_elements(value) AS elements(element) LOOP
    IF jsonb_typeof(item) <> 'object'
      OR jsonb_typeof(item->'type') <> 'string'
      OR jsonb_typeof(item->'resourceId') <> 'string'
      OR length(btrim(item->>'type')) = 0
      OR length(item->>'type') > 64
      OR length(btrim(item->>'resourceId')) = 0
      OR length(item->>'resourceId') > 200 THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

ALTER TABLE video_projects
  DROP CONSTRAINT IF EXISTS video_projects_status_check;

ALTER TABLE video_projects
  ADD CONSTRAINT video_projects_status_check CHECK (
    status IN (
      'draft',
      'planning',
      'awaiting_storyboard_approval',
      'ready_for_generation',
      'generating',
      'needs_attention',
      'awaiting_final_review',
      'failed',
      'cancelled',
      'completed'
    )
  );

ALTER TABLE shots
  DROP CONSTRAINT IF EXISTS shots_status_check;

ALTER TABLE shots
  ADD CONSTRAINT shots_status_check CHECK (
    status IN (
      'draft',
      'approved_for_generation',
      'queued',
      'generating',
      'retryable',
      'awaiting_review',
      'accepted',
      'rejected',
      'failed',
      'cancelled'
    )
  );

ALTER TABLE shots
  ADD COLUMN visual_description TEXT,
  ADD COLUMN camera_direction TEXT,
  ADD COLUMN audio_direction TEXT,
  ADD COLUMN dialogue TEXT,
  ADD COLUMN acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN required_asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Phase 4 stores the structured values in the approved proposal JSON. Copy the
-- element with the same ordinal into the durable shot columns. Missing legacy
-- optional values stay NULL; missing arrays use their empty defaults.
UPDATE shots AS s
SET visual_description = definition.value->>'visualDescription',
    camera_direction = definition.value->>'cameraDirection',
    audio_direction = definition.value->>'audioDirection',
    dialogue = definition.value->>'dialogue',
    acceptance_criteria = CASE
      WHEN jsonb_typeof(definition.value->'acceptanceCriteria') = 'array'
        THEN definition.value->'acceptanceCriteria'
      ELSE '[]'::jsonb
    END,
    required_asset_ids = CASE
      WHEN jsonb_typeof(definition.value->'requiredAssetIds') = 'array'
        THEN definition.value->'requiredAssetIds'
      ELSE '[]'::jsonb
    END
FROM storyboard_proposals AS proposal
CROSS JOIN LATERAL jsonb_array_elements(proposal.shot_definitions) AS definition(value)
WHERE proposal.id = s.storyboard_proposal_id
  AND proposal.project_id = s.project_id
  AND proposal.status = 'approved'
  AND definition.value->>'ordinal' = s.ordinal::text;

ALTER TABLE shots
  ADD CONSTRAINT shots_acceptance_criteria_bounded
    CHECK (h3_is_bounded_string_array(acceptance_criteria, 8, 280)),
  ADD CONSTRAINT shots_required_asset_ids_bounded
    CHECK (h3_is_bounded_string_array(required_asset_ids, 32, 200));

CREATE TABLE workflow_revisions (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES video_projects(id) ON DELETE RESTRICT,
  shot_id UUID NOT NULL REFERENCES shots(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL,
  parent_revision_id UUID REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  source TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  editor_graph_json JSONB NOT NULL,
  api_graph_json JSONB NOT NULL,
  execution_hash TEXT NOT NULL,
  execution_parameters_json JSONB NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'pending',
  validation_errors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  validated_at TIMESTAMPTZ,
  executor_fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT workflow_revisions_revision_number_positive
    CHECK (revision_number > 0),
  CONSTRAINT workflow_revisions_profile_id_bounded
    CHECK (length(btrim(profile_id)) BETWEEN 1 AND 128),
  CONSTRAINT workflow_revisions_profile_version_bounded
    CHECK (length(btrim(profile_version)) BETWEEN 1 AND 64),
  CONSTRAINT workflow_revisions_source_check
    CHECK (source IN ('comfy_editor', 'official_template', 'system')),
  CONSTRAINT workflow_revisions_author_type_bounded
    CHECK (length(btrim(author_type)) BETWEEN 1 AND 64),
  CONSTRAINT workflow_revisions_author_id_bounded
    CHECK (length(btrim(author_id)) BETWEEN 1 AND 200),
  CONSTRAINT workflow_revisions_editor_graph_object
    CHECK (jsonb_typeof(editor_graph_json) = 'object'),
  CONSTRAINT workflow_revisions_api_graph_object
    CHECK (jsonb_typeof(api_graph_json) = 'object'),
  CONSTRAINT workflow_revisions_execution_hash_sha256
    CHECK (execution_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workflow_revisions_execution_parameters_object
    CHECK (jsonb_typeof(execution_parameters_json) = 'object'),
  CONSTRAINT workflow_revisions_validation_status_check
    CHECK (validation_status IN ('pending', 'validated', 'invalid')),
  CONSTRAINT workflow_revisions_validation_errors_array
    CHECK (jsonb_typeof(validation_errors_json) = 'array'),
  CONSTRAINT workflow_revisions_json_size_bounded
    CHECK (
      pg_column_size(editor_graph_json) <= 1048576
      AND pg_column_size(api_graph_json) <= 1048576
      AND pg_column_size(execution_parameters_json) <= 262144
      AND pg_column_size(validation_errors_json) <= 131072
    ),
  CONSTRAINT workflow_revisions_profile_hash_scope_unique
    UNIQUE (shot_id, revision_number)
);

CREATE INDEX workflow_revisions_project_created_idx
  ON workflow_revisions(tenant_id, project_id, shot_id, revision_number DESC);

CREATE TABLE workflow_drafts (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES video_projects(id) ON DELETE RESTRICT,
  shot_id UUID NOT NULL REFERENCES shots(id) ON DELETE RESTRICT,
  base_revision_id UUID REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  editor_graph_json JSONB NOT NULL,
  last_api_graph_json JSONB,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT workflow_drafts_profile_id_bounded
    CHECK (length(btrim(profile_id)) BETWEEN 1 AND 128),
  CONSTRAINT workflow_drafts_profile_version_bounded
    CHECK (length(btrim(profile_version)) BETWEEN 1 AND 64),
  CONSTRAINT workflow_drafts_editor_graph_object
    CHECK (jsonb_typeof(editor_graph_json) = 'object'),
  CONSTRAINT workflow_drafts_last_api_graph_object
    CHECK (last_api_graph_json IS NULL OR jsonb_typeof(last_api_graph_json) = 'object'),
  CONSTRAINT workflow_drafts_author_type_bounded
    CHECK (length(btrim(author_type)) BETWEEN 1 AND 64),
  CONSTRAINT workflow_drafts_author_id_bounded
    CHECK (length(btrim(author_id)) BETWEEN 1 AND 200),
  CONSTRAINT workflow_drafts_version_positive
    CHECK (version > 0),
  CONSTRAINT workflow_drafts_json_size_bounded
    CHECK (
      pg_column_size(editor_graph_json) <= 1048576
      AND (
        last_api_graph_json IS NULL
        OR pg_column_size(last_api_graph_json) <= 1048576
      )
    ),
  CONSTRAINT workflow_drafts_one_current_per_shot
    UNIQUE (tenant_id, project_id, shot_id)
);

CREATE INDEX workflow_drafts_project_shot_idx
  ON workflow_drafts(tenant_id, project_id, shot_id);

ALTER TABLE generation_attempts
  ADD COLUMN workflow_revision_id UUID
    REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT generation_attempts_workflow_reference_exclusive
    CHECK (workflow_revision_id IS NULL OR workflow_version_id IS NULL);

CREATE INDEX generation_attempts_workflow_revision_idx
  ON generation_attempts(tenant_id, workflow_revision_id)
  WHERE workflow_revision_id IS NOT NULL;

CREATE TABLE operational_recommendations (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES video_projects(id) ON DELETE RESTRICT,
  shot_id UUID REFERENCES shots(id) ON DELETE RESTRICT,
  attempt_id UUID REFERENCES generation_attempts(id) ON DELETE RESTRICT,
  trigger_event_id UUID NOT NULL REFERENCES domain_events(id) ON DELETE RESTRICT,
  pi_agent_run_id UUID REFERENCES agent_runs(id) ON DELETE RESTRICT,
  severity TEXT NOT NULL,
  recommendation_code TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence_references_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposed_action_type TEXT NOT NULL,
  proposed_resource_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT operational_recommendations_severity_check
    CHECK (severity IN ('info', 'warning', 'critical')),
  CONSTRAINT operational_recommendations_code_bounded
    CHECK (recommendation_code ~ '^[A-Z0-9][A-Z0-9_.-]{0,63}$'),
  CONSTRAINT operational_recommendations_title_bounded
    CHECK (length(btrim(title)) BETWEEN 1 AND 240),
  CONSTRAINT operational_recommendations_detail_bounded
    CHECK (length(btrim(detail)) BETWEEN 1 AND 2000),
  CONSTRAINT operational_recommendations_evidence_bounded
    CHECK (h3_is_bounded_evidence_references(evidence_references_json)),
  CONSTRAINT operational_recommendations_action_check
    CHECK (
      proposed_action_type IN (
        'retry_attempt',
        'open_workflow_revision',
        'wait_for_executor',
        'request_human_review',
        'no_action'
      )
    ),
  CONSTRAINT operational_recommendations_resource_ids_bounded
    CHECK (h3_is_bounded_string_array(proposed_resource_ids_json, 32, 200)),
  CONSTRAINT operational_recommendations_status_check
    CHECK (status IN ('pending', 'applied', 'dismissed', 'expired')),
  CONSTRAINT operational_recommendations_version_positive
    CHECK (version > 0),
  CONSTRAINT operational_recommendations_json_size_bounded
    CHECK (
      pg_column_size(evidence_references_json) <= 131072
      AND pg_column_size(proposed_resource_ids_json) <= 131072
    ),
  CONSTRAINT operational_recommendations_event_code_unique
    UNIQUE (trigger_event_id, recommendation_code)
);

CREATE INDEX operational_recommendations_project_status_idx
  ON operational_recommendations(tenant_id, project_id, status, created_at);

CREATE OR REPLACE FUNCTION h3_validate_workflow_draft_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  shot_project_id UUID;
  project_tenant_id UUID;
  parent_tenant_id UUID;
  parent_project_id UUID;
  parent_shot_id UUID;
BEGIN
  SELECT p.tenant_id, s.project_id
  INTO project_tenant_id, shot_project_id
  FROM video_projects AS p
  JOIN shots AS s ON s.project_id = p.id
  WHERE p.id = NEW.project_id
    AND s.id = NEW.shot_id;

  IF project_tenant_id IS NULL
    OR project_tenant_id IS DISTINCT FROM NEW.tenant_id
    OR shot_project_id IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'workflow resource scope does not match tenant, project, and shot'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.base_revision_id IS NOT NULL THEN
    SELECT tenant_id, project_id, shot_id
    INTO parent_tenant_id, parent_project_id, parent_shot_id
    FROM workflow_revisions
    WHERE id = NEW.base_revision_id;
    IF parent_tenant_id IS NULL
      OR parent_tenant_id IS DISTINCT FROM NEW.tenant_id
      OR parent_project_id IS DISTINCT FROM NEW.project_id
      OR parent_shot_id IS DISTINCT FROM NEW.shot_id THEN
      RAISE EXCEPTION 'workflow draft base revision is outside its shot scope'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION h3_validate_workflow_revision_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  shot_project_id UUID;
  project_tenant_id UUID;
  parent_tenant_id UUID;
  parent_project_id UUID;
  parent_shot_id UUID;
BEGIN
  SELECT p.tenant_id, s.project_id
  INTO project_tenant_id, shot_project_id
  FROM video_projects AS p
  JOIN shots AS s ON s.project_id = p.id
  WHERE p.id = NEW.project_id
    AND s.id = NEW.shot_id;

  IF project_tenant_id IS NULL
    OR project_tenant_id IS DISTINCT FROM NEW.tenant_id
    OR shot_project_id IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'workflow resource scope does not match tenant, project, and shot'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_revision_id IS NOT NULL THEN
    SELECT tenant_id, project_id, shot_id
    INTO parent_tenant_id, parent_project_id, parent_shot_id
    FROM workflow_revisions
    WHERE id = NEW.parent_revision_id;
    IF parent_tenant_id IS NULL
      OR parent_tenant_id IS DISTINCT FROM NEW.tenant_id
      OR parent_project_id IS DISTINCT FROM NEW.project_id
      OR parent_shot_id IS DISTINCT FROM NEW.shot_id THEN
      RAISE EXCEPTION 'workflow revision parent is outside its shot scope'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_drafts_scope_trigger
  BEFORE INSERT OR UPDATE ON workflow_drafts
  FOR EACH ROW EXECUTE FUNCTION h3_validate_workflow_draft_scope();

CREATE TRIGGER workflow_revisions_scope_trigger
  BEFORE INSERT OR UPDATE ON workflow_revisions
  FOR EACH ROW EXECUTE FUNCTION h3_validate_workflow_revision_scope();

CREATE OR REPLACE FUNCTION h3_workflow_revision_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.shot_id IS DISTINCT FROM OLD.shot_id
    OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
    OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id
    OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
    OR NEW.profile_version IS DISTINCT FROM OLD.profile_version
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.author_type IS DISTINCT FROM OLD.author_type
    OR NEW.author_id IS DISTINCT FROM OLD.author_id
    OR NEW.editor_graph_json IS DISTINCT FROM OLD.editor_graph_json
    OR NEW.api_graph_json IS DISTINCT FROM OLD.api_graph_json
    OR NEW.execution_hash IS DISTINCT FROM OLD.execution_hash
    OR NEW.execution_parameters_json IS DISTINCT FROM OLD.execution_parameters_json
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'workflow revisions are immutable except for validation metadata'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_revisions_immutable_trigger
  BEFORE UPDATE ON workflow_revisions
  FOR EACH ROW EXECUTE FUNCTION h3_workflow_revision_immutable_guard();

CREATE OR REPLACE FUNCTION h3_validate_managed_attempt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  revision_tenant_id UUID;
  revision_project_id UUID;
  revision_shot_id UUID;
  revision_status TEXT;
  revision_hash TEXT;
BEGIN
  IF NEW.workflow_revision_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.workflow_version_id IS NOT NULL THEN
    RAISE EXCEPTION 'managed attempts cannot reference a legacy workflow version'
      USING ERRCODE = '23514';
  END IF;

  SELECT tenant_id, project_id, shot_id, validation_status, execution_hash
  INTO revision_tenant_id, revision_project_id, revision_shot_id,
       revision_status, revision_hash
  FROM workflow_revisions
  WHERE id = NEW.workflow_revision_id;

  IF revision_tenant_id IS NULL
    OR revision_tenant_id IS DISTINCT FROM NEW.tenant_id
    OR revision_project_id IS DISTINCT FROM NEW.project_id
    OR revision_shot_id IS DISTINCT FROM NEW.shot_id THEN
    RAISE EXCEPTION 'managed attempt workflow revision is outside its scope'
      USING ERRCODE = '23514';
  END IF;
  IF revision_status <> 'validated' THEN
    RAISE EXCEPTION 'managed attempts require a validated workflow revision'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.workflow_hash IS DISTINCT FROM revision_hash THEN
    RAISE EXCEPTION 'managed attempt workflow hash must match its revision'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.workflow_revision_id IS NOT NULL AND (
    NEW.workflow_revision_id IS DISTINCT FROM OLD.workflow_revision_id
    OR NEW.seed IS DISTINCT FROM OLD.seed
    OR NEW.steps IS DISTINCT FROM OLD.steps
    OR NEW.requested_width IS DISTINCT FROM OLD.requested_width
    OR NEW.requested_height IS DISTINCT FROM OLD.requested_height
    OR NEW.requested_duration_seconds IS DISTINCT FROM OLD.requested_duration_seconds
    OR NEW.workflow_hash IS DISTINCT FROM OLD.workflow_hash
  ) THEN
    RAISE EXCEPTION 'managed attempt execution data is immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER generation_attempts_managed_revision_trigger
  BEFORE INSERT OR UPDATE ON generation_attempts
  FOR EACH ROW EXECUTE FUNCTION h3_validate_managed_attempt();

CREATE OR REPLACE FUNCTION h3_generation_attempt_terminal_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('accepted', 'rejected', 'failed', 'timed_out', 'cancelled') THEN
    RAISE EXCEPTION 'terminal generation attempts are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER generation_attempts_terminal_immutable_trigger
  BEFORE UPDATE ON generation_attempts
  FOR EACH ROW EXECUTE FUNCTION h3_generation_attempt_terminal_guard();

CREATE OR REPLACE FUNCTION h3_validate_recommendation_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  project_tenant_id UUID;
  shot_project_id UUID;
  attempt_tenant_id UUID;
  attempt_project_id UUID;
  attempt_shot_id UUID;
  event_tenant_id UUID;
  event_project_id UUID;
  event_shot_id UUID;
  event_attempt_id UUID;
  run_tenant_id UUID;
  run_project_id UUID;
BEGIN
  SELECT tenant_id INTO project_tenant_id
  FROM video_projects WHERE id = NEW.project_id;
  IF project_tenant_id IS NULL OR project_tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'recommendation project is outside its tenant scope'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.shot_id IS NOT NULL THEN
    SELECT project_id INTO shot_project_id FROM shots WHERE id = NEW.shot_id;
    IF shot_project_id IS NULL OR shot_project_id IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'recommendation shot is outside its project scope'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.attempt_id IS NOT NULL THEN
    SELECT tenant_id, project_id, shot_id
    INTO attempt_tenant_id, attempt_project_id, attempt_shot_id
    FROM generation_attempts WHERE id = NEW.attempt_id;
    IF attempt_tenant_id IS NULL
      OR attempt_tenant_id IS DISTINCT FROM NEW.tenant_id
      OR attempt_project_id IS DISTINCT FROM NEW.project_id
      OR (NEW.shot_id IS NOT NULL AND attempt_shot_id IS DISTINCT FROM NEW.shot_id) THEN
      RAISE EXCEPTION 'recommendation attempt is outside its resource scope'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT tenant_id, project_id, shot_id, attempt_id
  INTO event_tenant_id, event_project_id, event_shot_id, event_attempt_id
  FROM domain_events WHERE id = NEW.trigger_event_id;
  IF event_tenant_id IS NULL
    OR event_tenant_id IS DISTINCT FROM NEW.tenant_id
    OR event_project_id IS DISTINCT FROM NEW.project_id
    OR (NEW.shot_id IS NOT NULL AND event_shot_id IS DISTINCT FROM NEW.shot_id)
    OR (NEW.attempt_id IS NOT NULL AND event_attempt_id IS DISTINCT FROM NEW.attempt_id) THEN
    RAISE EXCEPTION 'recommendation trigger event is outside its resource scope'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.pi_agent_run_id IS NOT NULL THEN
    SELECT tenant_id, project_id
    INTO run_tenant_id, run_project_id
    FROM agent_runs WHERE id = NEW.pi_agent_run_id;
    IF run_tenant_id IS NULL
      OR run_tenant_id IS DISTINCT FROM NEW.tenant_id
      OR run_project_id IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'recommendation Pi run is outside its project scope'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER operational_recommendations_scope_trigger
  BEFORE INSERT OR UPDATE ON operational_recommendations
  FOR EACH ROW EXECUTE FUNCTION h3_validate_recommendation_scope();
