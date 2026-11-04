-- 036 The rest of a consultant's profile: what they work on, where, and in which languages.
--
-- Clouds covered is what the Consultant Hub promises companies can search by, and until now
-- a profile could only name one primary role. Languages, the countries someone will work in
-- and contract/permanent preference are what a hiring company asks first. Each list is its
-- own table rather than a JSON column, so it can be filtered with an index and erased by
-- user_id like every other piece of the dossier (models/AccountErasure.js PURGE).

ALTER TABLE consultant_profiles
  ADD COLUMN open_to_contract  TINYINT(1)        NOT NULL DEFAULT 1 AFTER availability,
  ADD COLUMN open_to_permanent TINYINT(1)        NOT NULL DEFAULT 0 AFTER open_to_contract,
  ADD COLUMN trailhead_rank    VARCHAR(40)       NULL DEFAULT NULL AFTER trailblazer_url,
  ADD COLUMN trailhead_badges  SMALLINT UNSIGNED NULL DEFAULT NULL AFTER trailhead_rank;

ALTER TABLE consultant_skills
  ADD COLUMN years TINYINT UNSIGNED NULL DEFAULT NULL AFTER level;

ALTER TABLE consultant_certifications
  ADD COLUMN credential_url VARCHAR(255) NULL DEFAULT NULL AFTER credential_id;

ALTER TABLE consultant_projects
  ADD COLUMN is_current TINYINT(1) NOT NULL DEFAULT 0 AFTER ended_on;

ALTER TABLE consultant_work_experiences
  ADD COLUMN location VARCHAR(120) NULL DEFAULT NULL AFTER title;

CREATE TABLE consultant_clouds (
  user_id INT UNSIGNED NOT NULL,
  -- A cloud FAMILY slug from config/cloudFamilies.js, validated by the model.
  family  VARCHAR(64)  NOT NULL,
  PRIMARY KEY (user_id, family),
  KEY idx_consultant_clouds_family (family),
  CONSTRAINT fk_consultant_clouds_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consultant_languages (
  user_id  INT UNSIGNED NOT NULL,
  language VARCHAR(60)  NOT NULL,
  level    ENUM('basic','conversational','professional','native') NOT NULL DEFAULT 'professional',
  PRIMARY KEY (user_id, language),
  CONSTRAINT fk_consultant_languages_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consultant_work_countries (
  user_id INT UNSIGNED NOT NULL,
  country CHAR(2)      NOT NULL,
  PRIMARY KEY (user_id, country),
  KEY idx_consultant_work_countries_country (country),
  CONSTRAINT fk_consultant_work_countries_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
