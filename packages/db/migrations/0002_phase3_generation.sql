-- Phase 3 generation metadata and durable queue fields.

ALTER TABLE generation_attempts
  ADD COLUMN correlation_id TEXT,
  ADD COLUMN trace_id TEXT,
  ADD COLUMN scenario TEXT,
  ADD COLUMN source_attempt_id UUID REFERENCES generation_attempts(id) ON DELETE RESTRICT,
  ADD COLUMN artifact_id UUID REFERENCES artifacts(id) ON DELETE RESTRICT;

UPDATE generation_attempts
SET correlation_id = 'legacy-' || id::text
WHERE correlation_id IS NULL;

ALTER TABLE generation_attempts
  ALTER COLUMN correlation_id SET NOT NULL;

ALTER TABLE evaluation_results
  ADD COLUMN evaluator_version TEXT NOT NULL DEFAULT 'phase-3-v1',
  ADD COLUMN checks JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE workflow_versions
  ADD CONSTRAINT workflow_versions_hash_unique UNIQUE (workflow_hash);

ALTER TABLE generation_attempts
  DROP CONSTRAINT IF EXISTS generation_attempts_idempotency_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS generation_attempts_idempotency_key_unique
  ON generation_attempts(tenant_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_attempt_unique
  ON artifacts(attempt_id);

CREATE UNIQUE INDEX IF NOT EXISTS generation_attempts_correlation_id_unique
  ON generation_attempts(tenant_id, correlation_id);

CREATE INDEX IF NOT EXISTS generation_attempts_queue_idx
  ON generation_attempts(status, lease_expires_at, queued_at, id);

CREATE INDEX IF NOT EXISTS generation_attempts_project_created_idx
  ON generation_attempts(project_id, created_at, id);

ALTER TABLE generation_attempts
  ADD CONSTRAINT generation_attempts_correlation_not_blank
    CHECK (length(btrim(correlation_id)) > 0),
  ADD CONSTRAINT generation_attempts_failure_message_bounded
    CHECK (failure_message IS NULL OR length(failure_message) <= 500);
