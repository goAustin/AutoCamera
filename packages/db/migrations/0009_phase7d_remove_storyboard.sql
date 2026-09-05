-- Phase 7D: remove the brief-first product. Storyboard proposals are gone;
-- every surviving shot is created implicitly, directly off a run submission.
--
-- Order matters: 0006 added `shots_implicit_proposal_consistent`, a CHECK
-- constraint that references `storyboard_proposal_id`, so it must be dropped
-- before the column it references. The same constraint would also reject the
-- conversion below (it requires implicit = TRUE to pair with a NULL
-- storyboard_proposal_id), so the constraint goes first, unconditionally.

ALTER TABLE shots
  DROP CONSTRAINT IF EXISTS shots_implicit_proposal_consistent;

-- A non-implicit shot only ever existed because a storyboard proposal was
-- approved. That mechanism is gone, but the shot itself, its attempts, and
-- every domain event about it remain part of the durable record. Convert
-- rather than silently drop: this is a no-op on a database that has no
-- storyboard-materialized shots (every project-studio.spec.ts-era shot was
-- already superseded by graph-first runs), and preserves the row on one that
-- does.
UPDATE shots SET implicit = TRUE WHERE implicit = FALSE;

ALTER TABLE shots
  DROP COLUMN storyboard_proposal_id;

DROP TABLE storyboard_proposals;
