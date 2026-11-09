-- 042 The Albania employment program behind /tax-advisory: who is in it, and their stories.
--
-- tax_program_participants answers ONE question on the page — how many consultants are in
-- the program right now — and the page shows that number only from ten upwards
-- (config/taxProgram.js ACTIVE_COUNT_FLOOR). A participant is active from `started_on` until
-- `ended_on` is set; ending is the operation, so the history of who was in it stays countable.
--
-- tax_program_stories are the "Real success stories". Unlike success_stories (editorial case
-- studies, which deliberately carry no pay figures), these exist to show before-and-after pay,
-- so the rules are about CONSENT:
--
--   * A story belongs to an account (`user_id` NOT NULL): somebody real, who can withdraw.
--   * It is shown only with `consent_given_at` set and `consent_withdrawn_at` NULL, and only
--     when published and not hidden. Withdrawing is a timestamp, not a delete, so "when did
--     they say no" keeps an answer; erasing the account deletes the row (AccountErasure PURGE).
--   * The name is NOT stored. The page derives "first name + initial" from the account at
--     read time, so a corrected name is corrected everywhere and an erased one is gone.
--   * Figures are minor units, the person's own, typed by an administrator from what they
--     agreed to publish. The monthly and yearly differences are derived at render.
--
-- DATETIME, never TIMESTAMP: see CLAUDE.md "Consent and immutable dates".

CREATE TABLE tax_program_participants (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  started_on  DATE         NOT NULL,
  ended_on    DATE         NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tax_program_participants_user (user_id),
  KEY idx_tax_program_participants_active (ended_on, started_on),
  CONSTRAINT fk_tax_program_participants_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_tax_program_participants_dates CHECK (ended_on IS NULL OR ended_on >= started_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tax_program_stories (
  id                    INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id               INT UNSIGNED NOT NULL,
  role                  VARCHAR(120) NOT NULL,
  country_code          CHAR(2)      NOT NULL,
  currency              CHAR(3)      NOT NULL DEFAULT 'EUR',
  gross_before_minor    INT UNSIGNED NOT NULL,
  net_before_minor      INT UNSIGNED NOT NULL,
  gross_after_minor     INT UNSIGNED NOT NULL,
  net_after_minor       INT UNSIGNED NOT NULL,
  quote                 VARCHAR(600) NOT NULL,
  consent_given_at      DATETIME     NULL,
  consent_withdrawn_at  DATETIME     NULL,
  published_at          DATETIME     NULL,
  hidden_at             DATETIME     NULL,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tax_program_stories_user (user_id),
  KEY idx_tax_program_stories_live (published_at, hidden_at),
  CONSTRAINT fk_tax_program_stories_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_tax_program_stories_net CHECK (net_before_minor <= gross_before_minor AND net_after_minor <= gross_after_minor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
