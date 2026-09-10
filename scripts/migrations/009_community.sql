-- 009 Community: posts, replies, votes and the points ledger.
--
-- One `posts` table with a `kind` discriminator rather than separate tables per type.
-- Articles, questions, discussions and wins differ in how they are PRESENTED and in which
-- affordances they carry (only a question can be solved, only a win is celebrated), not in
-- what they store. Four near-identical tables would mean four of every query, and the feed
-- would need a UNION that no index can serve well.

CREATE TABLE post_categories (
  id          SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug        VARCHAR(64)  NOT NULL,
  name        VARCHAR(120) NOT NULL,
  description VARCHAR(255) NULL DEFAULT NULL,

  -- Mirrors a cloud family from config/cloudFamilies.js where one applies, so the
  -- community tree and the job taxonomy stay the same vocabulary. NULL for the
  -- cross-cutting categories (careers, certification, the platform itself).
  family_slug VARCHAR(64)  NULL DEFAULT NULL,

  icon        VARCHAR(64)  NOT NULL DEFAULT 'bi-chat-square-text',
  sort_order  SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_post_categories_slug (slug),
  KEY idx_post_categories_order (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE posts (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_id  SMALLINT UNSIGNED NOT NULL,
  author_user_id INT UNSIGNED NOT NULL,

  kind         ENUM('article','question','discussion','win') NOT NULL DEFAULT 'discussion',
  title        VARCHAR(200) NOT NULL,
  slug         VARCHAR(240) NOT NULL,
  body         MEDIUMTEXT   NOT NULL,

  -- Denormalised counters. Every one of them is maintained in the same transaction as the
  -- row it counts, so a list view never has to aggregate to render.
  view_count   INT UNSIGNED NOT NULL DEFAULT 0,
  reply_count  INT UNSIGNED NOT NULL DEFAULT 0,
  vote_score   INT          NOT NULL DEFAULT 0,

  -- Only meaningful for a question. Enforced in the model, not by the schema, because
  -- MySQL cannot express "this column is only valid when kind = 'question'".
  is_solved    TINYINT(1)   NOT NULL DEFAULT 0,
  solution_reply_id INT UNSIGNED NULL DEFAULT NULL,

  is_pinned    TINYINT(1)   NOT NULL DEFAULT 0,
  is_locked    TINYINT(1)   NOT NULL DEFAULT 0,

  last_activity_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_posts_slug (slug),
  KEY idx_posts_feed (last_activity_at),
  KEY idx_posts_kind (kind, last_activity_at),
  KEY idx_posts_category (category_id, last_activity_at),
  KEY idx_posts_author (author_user_id, created_at),
  FULLTEXT KEY ft_posts_search (title, body),
  CONSTRAINT fk_posts_category FOREIGN KEY (category_id) REFERENCES post_categories (id),
  CONSTRAINT fk_posts_author FOREIGN KEY (author_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE post_replies (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  post_id     INT UNSIGNED NOT NULL,
  author_user_id INT UNSIGNED NOT NULL,

  -- One level of nesting only. Deeper threads are harder to read than they are useful,
  -- and unbounded recursion turns a page render into an unpredictable number of queries.
  parent_reply_id INT UNSIGNED NULL DEFAULT NULL,

  body        MEDIUMTEXT   NOT NULL,
  vote_score  INT          NOT NULL DEFAULT 0,
  is_solution TINYINT(1)   NOT NULL DEFAULT 0,

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_replies_post (post_id, created_at),
  KEY idx_replies_parent (parent_reply_id),
  KEY idx_replies_author (author_user_id),
  CONSTRAINT fk_replies_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
  CONSTRAINT fk_replies_author FOREIGN KEY (author_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_replies_parent FOREIGN KEY (parent_reply_id) REFERENCES post_replies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One vote per person per thing. The unique key is what makes a vote idempotent and makes
-- "un-vote" a delete rather than a second row that has to be reconciled later.
CREATE TABLE post_votes (
  user_id     INT UNSIGNED NOT NULL,
  target_type ENUM('post','reply') NOT NULL,
  target_id   INT UNSIGNED NOT NULL,
  value       TINYINT      NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (user_id, target_type, target_id),
  KEY idx_votes_target (target_type, target_id),
  CONSTRAINT fk_votes_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only points ledger.
--
-- A single `points` total on the user row would be unauditable: nobody could answer "where
-- did these come from", and a double-award could never be found or undone. The ledger is
-- the record; the total is a SUM over it.
--
-- `dedupe_key` is what makes an award idempotent — the same event can never pay twice,
-- however many times its emitter runs.
CREATE TABLE points_ledger (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  reason     VARCHAR(64)  NOT NULL,
  points     SMALLINT     NOT NULL,
  dedupe_key VARCHAR(190) NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_points_dedupe (dedupe_key),
  KEY idx_points_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
