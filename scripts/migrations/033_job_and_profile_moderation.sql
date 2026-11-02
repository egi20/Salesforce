-- 033 An administrator can take a consultant profile out of the directory, and a job advert
-- off the board (ported from SAP Hub's migrations 025 and 026).
--
-- Until now the only way to remove an inappropriate profile or advert from a public list was
-- to deactivate the whole account, which also ends its applications, its messages and its
-- community standing. That is a sledgehammer for a headline somebody should not have
-- written, and an administrator faced with only that choice makes the wrong one or none.
--
-- SEPARATE COLUMNS from the owner's own switches, and that separation is the whole point.
-- `consultant_profiles.is_public` is the member's, and `jobs.status` is the advertiser's;
-- each moves them freely. If a moderator wrote to those columns the owner would undo the
-- decision by pressing Publish or Reopen — which is not a moderation action, it is a
-- suggestion. The same shape as `hidden_at` on `posts`: the owner owns one column, a
-- moderator another, and the public lists require both to be clear.
--
-- Hidden, never deleted. The applications made to an advert, their audit events and the
-- conversations anchored to it belong to other people, and they stay. `models/Moderation.js`
-- is the only writer; `moderation_events.subject_type` is a VARCHAR here, so it learns the
-- two new subjects without a schema change.
--
-- DATETIME, never TIMESTAMP: see CLAUDE.md on `explicit_defaults_for_timestamp`.
ALTER TABLE consultant_profiles
  ADD COLUMN admin_hidden_at         DATETIME     NULL DEFAULT NULL AFTER is_public,
  ADD COLUMN admin_hidden_reason     VARCHAR(200) NULL DEFAULT NULL AFTER admin_hidden_at,
  ADD COLUMN admin_hidden_by_user_id INT UNSIGNED NULL DEFAULT NULL AFTER admin_hidden_reason,
  ADD CONSTRAINT fk_consultant_profiles_hidden_by
    FOREIGN KEY (admin_hidden_by_user_id) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE jobs
  ADD COLUMN admin_hidden_at         DATETIME     NULL DEFAULT NULL AFTER status,
  ADD COLUMN admin_hidden_reason     VARCHAR(200) NULL DEFAULT NULL AFTER admin_hidden_at,
  ADD COLUMN admin_hidden_by_user_id INT UNSIGNED NULL DEFAULT NULL AFTER admin_hidden_reason,
  ADD CONSTRAINT fk_jobs_hidden_by
    FOREIGN KEY (admin_hidden_by_user_id) REFERENCES users (id) ON DELETE SET NULL;
