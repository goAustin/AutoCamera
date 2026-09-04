-- Phase 7A follow-up: pinning and acceptance are different decisions and must
-- not share a column.
--
-- `accepted_attempt_id` means "a human approved this attempt after it passed
-- evaluation"; project completion counts it. Pinning only marks which attempt
-- of a run is the keeper, has no preconditions, and is reversible. While pin
-- wrote `accepted_attempt_id`, pinning a queued or failed run counted toward
-- project completion, and unpinning could leave a shot `accepted` with no
-- accepted attempt, which `assertShot` then rejects forever.

ALTER TABLE shots
  ADD COLUMN pinned_attempt_id UUID REFERENCES generation_attempts(id) ON DELETE RESTRICT;

-- An accepted shot is also pinned to the attempt that was accepted, which
-- preserves the pin state that existing rows already express.
UPDATE shots SET pinned_attempt_id = accepted_attempt_id
WHERE accepted_attempt_id IS NOT NULL;

-- An accepted shot must still identify its accepted attempt.
ALTER TABLE shots
  ADD CONSTRAINT shots_accepted_requires_attempt
    CHECK (status <> 'accepted' OR accepted_attempt_id IS NOT NULL);
