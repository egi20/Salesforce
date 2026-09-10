-- 011 AI usage accounting.
--
-- One row per model call, written AFTER the call returns, carrying the token counts the
-- API itself reported and the cost derived from them.
--
-- This table is not analytics. It is the ledger the spend circuit-breaker reads: without
-- it, "have we spent too much this month" has no answer and the only cap on a public,
-- paid endpoint is a rate limiter, which bounds requests per address and therefore bounds
-- nothing in aggregate.
--
-- Tokens come from the response, never from a local estimate. A character-count guess is
-- wrong in both directions — it ignores the cached system prompt and the tokeniser — and
-- a budget built on a guess cuts off at a number nobody can reconcile with the invoice.
--
-- `user_id` is nullable and ON DELETE SET NULL on purpose: the assistant answers
-- anonymous visitors, and a closed account must not erase the spend it caused.

CREATE TABLE ai_usage (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Which feature spent the money. One value today ('assistant'); named rather than
  -- assumed so a second AI feature does not need a schema change to be told apart.
  feature        VARCHAR(40)  NOT NULL,
  model          VARCHAR(80)  NOT NULL,

  user_id        INT UNSIGNED NULL DEFAULT NULL,

  input_tokens   INT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens  INT UNSIGNED NOT NULL DEFAULT 0,

  -- DECIMAL, not FLOAT: this column is summed to decide whether to stop spending, and a
  -- binary float accumulates error over tens of thousands of rows. Six decimal places
  -- because a single cheap exchange costs a fraction of a cent.
  cost_usd       DECIMAL(12,6) NOT NULL DEFAULT 0,

  -- Whether the call succeeded. A failed call can still have consumed input tokens, so
  -- it belongs in the ledger rather than being dropped.
  outcome        ENUM('ok','error') NOT NULL DEFAULT 'ok',

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The two aggregates the circuit-breaker runs, and nothing else: month-to-date total,
  -- and month-to-date for one user.
  KEY idx_ai_usage_month (created_at),
  KEY idx_ai_usage_user_month (user_id, created_at),
  CONSTRAINT fk_ai_usage_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
