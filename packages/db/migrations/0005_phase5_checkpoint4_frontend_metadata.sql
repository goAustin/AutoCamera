-- Phase 5 Checkpoint 4: retain the provenance of the pinned Comfy frontend
-- that produced an immutable workflow revision.

ALTER TABLE workflow_revisions
  ADD COLUMN frontend_version TEXT,
  ADD COLUMN frontend_commit TEXT,
  ADD CONSTRAINT workflow_revisions_frontend_version_bounded
    CHECK (
      frontend_version IS NULL
      OR length(btrim(frontend_version)) BETWEEN 1 AND 128
    ),
  ADD CONSTRAINT workflow_revisions_frontend_commit_bounded
    CHECK (
      frontend_commit IS NULL
      OR length(btrim(frontend_commit)) BETWEEN 1 AND 128
    );
