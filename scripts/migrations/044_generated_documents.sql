-- 044 A log of the CVs and rate cards a consultant generated — the log, never the files.
--
-- Generated documents are made fresh on every download and never stored (CLAUDE.md,
-- "Generated documents"): a stored copy is the stale one somebody eventually sends. What
-- "My documents" shows under "Recently generated" is therefore only WHAT was made and WHEN,
-- and "Generate again" makes a new one from today's profile with the same choices.
--
-- `sections` keeps the optional sections that were ticked, so "Generate again" reproduces the
-- choice. `application_id` is set when the CV was made for an application; it goes NULL if
-- that application is ever removed, and the row simply stops saying who it was for.
--
-- Personal: in the erasure PURGE and the data export, like every list a person owns.

CREATE TABLE generated_documents (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id        INT UNSIGNED NOT NULL,
  kind           ENUM('cv','rate_card','cv_rate_card') NOT NULL,
  sections       VARCHAR(255) NULL DEFAULT NULL,
  application_id INT UNSIGNED NULL DEFAULT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_generated_documents_user (user_id, created_at),
  CONSTRAINT fk_generated_documents_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_generated_documents_application FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
