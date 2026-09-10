-- 012 Moderation.
--
-- The gap this closes: the community and the rate index both accept content from anyone
-- with an account, and until now there was no way to take any of it down. The only tool
-- available was DELETE, which loses the record of what was removed and why — exactly the
-- thing that has to survive when someone asks "why was my post taken down".
--
-- So content is HIDDEN, never deleted. Three things follow from that, and each is a
-- decision rather than an implementation detail:
--
--   1. Hiding is REVERSIBLE. A moderator acting on a bad report can undo it, and the
--      author's work is still there. Deleting is not a decision anyone should be able to
--      take in one click from a list view.
--   2. Hidden rows still exist, so counters, foreign keys and the points ledger stay
--      consistent. A reply that vanished from under `posts.reply_count` would leave the
--      denormalised counter permanently wrong.
--   3. Every action is written to an APPEND-ONLY log. Same reasoning as the points ledger
--      and the application events: "who did this, when, and why" must always have an
--      answer, and a moderation action that can be quietly undone leaves no answer at all.

ALTER TABLE posts
  ADD COLUMN hidden_at         DATETIME     NULL DEFAULT NULL AFTER is_locked,
  ADD COLUMN hidden_by_user_id INT UNSIGNED NULL DEFAULT NULL AFTER hidden_at,
  ADD COLUMN hidden_reason     VARCHAR(200) NULL DEFAULT NULL AFTER hidden_by_user_id,
  ADD CONSTRAINT fk_posts_hidden_by FOREIGN KEY (hidden_by_user_id) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE post_replies
  ADD COLUMN hidden_at         DATETIME     NULL DEFAULT NULL AFTER is_solution,
  ADD COLUMN hidden_by_user_id INT UNSIGNED NULL DEFAULT NULL AFTER hidden_at,
  ADD COLUMN hidden_reason     VARCHAR(200) NULL DEFAULT NULL AFTER hidden_by_user_id,
  ADD CONSTRAINT fk_replies_hidden_by FOREIGN KEY (hidden_by_user_id) REFERENCES users (id) ON DELETE SET NULL;

-- A voided rate submission.
--
-- This one is not about abuse so much as arithmetic: the rate index publishes percentiles,
-- and a single bad-faith or fat-fingered figure (a day rate typed as an annual salary, say)
-- moves them for everyone. Voiding excludes the row from every aggregate while leaving it
-- in place, so the unique key still stops the same person re-submitting for that period and
-- the contribution is still auditable.
--
-- It is NOT deleted, and it must NOT be edited into a "corrected" value: an aggregate whose
-- inputs an administrator can retype is an aggregate nobody should trust.
ALTER TABLE rate_submissions
  ADD COLUMN voided_at         DATETIME     NULL DEFAULT NULL AFTER period,
  ADD COLUMN voided_by_user_id INT UNSIGNED NULL DEFAULT NULL AFTER voided_at,
  ADD COLUMN void_reason       VARCHAR(200) NULL DEFAULT NULL AFTER voided_by_user_id,
  ADD CONSTRAINT fk_rate_submissions_voided_by FOREIGN KEY (voided_by_user_id) REFERENCES users (id) ON DELETE SET NULL;

-- Append-only. Rows are never updated and never deleted; an undo is another row.
CREATE TABLE moderation_events (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- What was acted on. Not a foreign key: the log has to outlive the thing it describes,
  -- and a CASCADE here would erase the record of moderating a post the moment its author's
  -- account was closed.
  subject_type   VARCHAR(32)  NOT NULL,
  subject_id     INT UNSIGNED NOT NULL,

  action         VARCHAR(32)  NOT NULL,

  -- Who did it. SET NULL rather than CASCADE for the same reason: a departed moderator
  -- must not take their decisions with them.
  actor_user_id  INT UNSIGNED NULL DEFAULT NULL,

  -- Whose content it was, so "everything ever done to this member" is one query.
  subject_user_id INT UNSIGNED NULL DEFAULT NULL,

  reason         VARCHAR(200) NULL DEFAULT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_moderation_subject (subject_type, subject_id, created_at),
  KEY idx_moderation_actor (actor_user_id, created_at),
  KEY idx_moderation_member (subject_user_id, created_at),
  KEY idx_moderation_recent (created_at),
  CONSTRAINT fk_moderation_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_moderation_member FOREIGN KEY (subject_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
