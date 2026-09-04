-- Phase 7A follow-up: graph-first runs create one implicit shot each, so a
-- project's shot count is no longer bounded by the three-shot storyboard.
-- Storyboard proposals are still validated as exactly ordinals 1, 2, 3 in the
-- domain layer; only the durable shot range is widened here.
-- `shots_project_ordinal_unique` is retained so ordinals stay dense per project.

ALTER TABLE shots
  DROP CONSTRAINT IF EXISTS shots_ordinal_range;

ALTER TABLE shots
  ADD CONSTRAINT shots_ordinal_positive CHECK (ordinal >= 1);
