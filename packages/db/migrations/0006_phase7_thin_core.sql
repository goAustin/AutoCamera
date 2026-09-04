-- Phase 7A: graph-first runs keep the existing shot grouping key and make
-- budget/review policy data optional annotations rather than gates.

ALTER TABLE shots
  ALTER COLUMN storyboard_proposal_id DROP NOT NULL;

ALTER TABLE video_projects
  ALTER COLUMN budget_microusd DROP NOT NULL;

ALTER TABLE generation_attempts
  ADD COLUMN review_decision TEXT,
  ADD COLUMN review_note TEXT,
  ADD COLUMN review_author TEXT,
  ADD COLUMN reviewed_at TIMESTAMPTZ,
  ADD CONSTRAINT generation_attempts_review_decision_check
    CHECK (review_decision IS NULL OR review_decision IN ('accepted', 'rejected')),
  ADD CONSTRAINT generation_attempts_review_note_bounded
    CHECK (review_note IS NULL OR length(review_note) <= 2000),
  ADD CONSTRAINT generation_attempts_review_author_bounded
    CHECK (review_author IS NULL OR length(btrim(review_author)) BETWEEN 1 AND 200),
  ADD CONSTRAINT generation_attempts_review_complete
    CHECK (
      (review_decision IS NULL AND reviewed_at IS NULL)
      OR (review_decision IS NOT NULL AND reviewed_at IS NOT NULL)
    );

ALTER TABLE video_projects
  ADD COLUMN auto_created BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE shots
  ADD COLUMN implicit BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE shots
  ADD CONSTRAINT shots_implicit_proposal_consistent
    CHECK (
      (implicit = FALSE AND storyboard_proposal_id IS NOT NULL)
      OR (implicit = TRUE AND storyboard_proposal_id IS NULL)
    );

-- Review is an annotation and remains writable after a lifecycle attempt has
-- become terminal. All execution and lifecycle columns remain immutable.
CREATE OR REPLACE FUNCTION h3_generation_attempt_terminal_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('accepted', 'rejected', 'failed', 'timed_out', 'cancelled')
    AND (
      NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.shot_id IS DISTINCT FROM OLD.shot_id
      OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.seed IS DISTINCT FROM OLD.seed
      OR NEW.steps IS DISTINCT FROM OLD.steps
      OR NEW.requested_width IS DISTINCT FROM OLD.requested_width
      OR NEW.requested_height IS DISTINCT FROM OLD.requested_height
      OR NEW.requested_duration_seconds IS DISTINCT FROM OLD.requested_duration_seconds
      OR NEW.workflow_version_id IS DISTINCT FROM OLD.workflow_version_id
      OR NEW.workflow_revision_id IS DISTINCT FROM OLD.workflow_revision_id
      OR NEW.workflow_hash IS DISTINCT FROM OLD.workflow_hash
      OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
      OR NEW.trace_id IS DISTINCT FROM OLD.trace_id
      OR NEW.scenario IS DISTINCT FROM OLD.scenario
      OR NEW.comfy_prompt_id IS DISTINCT FROM OLD.comfy_prompt_id
      OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
      OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
      OR NEW.queued_at IS DISTINCT FROM OLD.queued_at
      OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
      OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
      OR NEW.compute_seconds IS DISTINCT FROM OLD.compute_seconds
      OR NEW.estimated_cost_microusd IS DISTINCT FROM OLD.estimated_cost_microusd
      OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
      OR NEW.failure_message IS DISTINCT FROM OLD.failure_message
      OR NEW.source_attempt_id IS DISTINCT FROM OLD.source_attempt_id
      OR NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
    RAISE EXCEPTION 'terminal generation attempts are immutable except for review annotations'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
