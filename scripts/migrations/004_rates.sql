-- 004 Day rate index.
--
-- PRIVACY FLOOR (carried over verbatim): no aggregate derived from fewer than
-- config.rates.minSampleSize DISTINCT PEOPLE may ever be published. The count is of
-- people, not submissions, which is why `user_id` is stored on every row and why the
-- unique key below keeps one submission per person per role per period. Aggregation
-- keeps the count while nulling the values, so the UI can honestly say "not enough
-- data" instead of rendering a misleading point.

CREATE TABLE rate_submissions (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED NOT NULL,

  role            VARCHAR(64)  NOT NULL,
  seniority       ENUM('junior','mid','senior','lead') NOT NULL,
  engagement_type ENUM('contract','permanent') NOT NULL DEFAULT 'contract',
  work_mode       ENUM('remote','hybrid','onsite') NOT NULL DEFAULT 'remote',
  country         CHAR(2)      NOT NULL,

  -- Day rate for contract, annual salary for permanent. Always normalised to
  -- `amount_eur` at submission time so aggregates never mix currencies.
  amount          DECIMAL(10,2) NOT NULL,
  currency        CHAR(3)      NOT NULL DEFAULT 'EUR',
  amount_eur      DECIMAL(10,2) NOT NULL,

  -- YYYY-MM bucket the submission counts towards.
  period          CHAR(7)      NOT NULL,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_rate_submission (user_id, role, seniority, engagement_type, period),
  KEY idx_rates_bucket (role, seniority, engagement_type, country, period),
  KEY idx_rates_period (period),
  CONSTRAINT fk_rate_submissions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
