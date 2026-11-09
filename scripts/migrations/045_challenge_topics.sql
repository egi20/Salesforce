-- 045 Topic challenges beside the daily mix.
--
-- One attempt per person per day becomes one attempt per person per day PER CHALLENGE: the
-- unique key moves from (user_id, challenge_date) to (user_id, challenge_date, challenge).
-- It is still the whole anti-cheat design (see 018): the insert is attempted and a
-- duplicate is a no-op, so a second submission of the same challenge is never a better
-- score.
--
-- Every existing row is an attempt at the single daily set, which is the mix and keeps the
-- slug 'daily'. The column gets that value for the backfill and then loses its default, so
-- a later insert that forgets to say which challenge it graded fails instead of being
-- silently recorded as the mix.

ALTER TABLE challenge_attempts
  ADD COLUMN challenge VARCHAR(40) NOT NULL DEFAULT 'daily' AFTER challenge_date;

ALTER TABLE challenge_attempts
  ALTER COLUMN challenge DROP DEFAULT;

ALTER TABLE challenge_attempts
  ADD UNIQUE KEY uq_challenge_attempt_day_challenge (user_id, challenge_date, challenge),
  DROP INDEX uq_challenge_attempt_day,
  ADD KEY idx_challenge_attempts_day_challenge (challenge_date, challenge, score);
