-- 037 What the Build-your-profile spec adds on top of 036.
--
-- Languages move to the three levels the spec names (Basic / Fluent / Native): the four-step
-- scale from 036 asked consultants to tell "conversational" from "professional", which a
-- company reading the profile cannot act on anyway. Existing rows are mapped, not dropped.
--
-- Availability gains "busy": engaged right now but worth contacting. It is not the same as
-- "not available", and pressing it into one of the existing values would misstate somebody.
--
-- Projects and experience gain an explicit order, because the owner can now arrange them;
-- until now the order was whatever the dates implied.
--
-- consultant_documents holds a consultant's own uploaded CVs and cover letters. The BYTES are
-- in the database, never on the host disk (CLAUDE.md, Uploads), and are validated before they
-- are stored — see utils/documentUpload.js for what is refused and why.

ALTER TABLE consultant_languages
  MODIFY COLUMN level ENUM('basic','conversational','professional','fluent','native') NOT NULL DEFAULT 'fluent';
UPDATE consultant_languages SET level = 'fluent' WHERE level IN ('conversational', 'professional');
ALTER TABLE consultant_languages
  MODIFY COLUMN level ENUM('basic','fluent','native') NOT NULL DEFAULT 'fluent';

ALTER TABLE consultant_profiles
  MODIFY COLUMN availability ENUM('immediate','two_weeks','one_month','busy','not_available') NOT NULL DEFAULT 'not_available';

ALTER TABLE consultant_projects
  ADD COLUMN sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER user_id;

ALTER TABLE consultant_work_experiences
  ADD COLUMN sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER user_id;

CREATE TABLE consultant_documents (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      INT UNSIGNED NOT NULL,
  kind         ENUM('cv','cover_letter') NOT NULL,
  title        VARCHAR(120) NULL DEFAULT NULL,
  filename     VARCHAR(160) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  byte_size    INT UNSIGNED NOT NULL,
  bytes        MEDIUMBLOB   NOT NULL,
  is_default   TINYINT(1)   NOT NULL DEFAULT 0,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_consultant_documents_user (user_id, kind),
  CONSTRAINT fk_consultant_documents_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
