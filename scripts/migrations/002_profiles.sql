-- 002 Consultant and company profiles.
--
-- BLOB STORAGE RULE: the application host's filesystem is ephemeral (wiped on every
-- deploy), so durable bytes live in MySQL. They live in a SEPARATE side table keyed by
-- the owner, never as a column on the profile itself: profile and talent-list queries
-- select whole rows, and inlining image bytes would drag megabytes through every list
-- query. The owning row stores only a pointer URL with a cache-busting ?v=<ts>.

CREATE TABLE consultant_profiles (
  user_id            INT UNSIGNED NOT NULL,
  headline           VARCHAR(200) NULL DEFAULT NULL,
  bio                TEXT         NULL,

  -- Stored as the taxonomy SLUG (config/roleTaxonomy.js), never the display label.
  primary_role       VARCHAR(64)  NULL DEFAULT NULL,
  seniority          ENUM('junior','mid','senior','lead') NULL DEFAULT NULL,
  years_experience   TINYINT UNSIGNED NULL DEFAULT NULL,

  country            CHAR(2)      NULL DEFAULT NULL,
  city               VARCHAR(120) NULL DEFAULT NULL,
  timezone           VARCHAR(64)  NULL DEFAULT NULL,
  work_mode          ENUM('remote','hybrid','onsite') NOT NULL DEFAULT 'remote',
  willing_to_travel  TINYINT(1)   NOT NULL DEFAULT 0,

  day_rate           DECIMAL(10,2) NULL DEFAULT NULL,
  currency           CHAR(3)      NOT NULL DEFAULT 'EUR',
  availability       ENUM('immediate','two_weeks','one_month','not_available') NOT NULL DEFAULT 'not_available',
  available_from     DATE         NULL DEFAULT NULL,

  linkedin_url       VARCHAR(255) NULL DEFAULT NULL,
  linkedin_verified  TINYINT(1)   NOT NULL DEFAULT 0,
  website_url        VARCHAR(255) NULL DEFAULT NULL,
  trailblazer_url    VARCHAR(255) NULL DEFAULT NULL,

  profile_picture    VARCHAR(255) NULL DEFAULT NULL,

  -- A profile is only listed publicly once its owner opts in AND it has enough
  -- substance to be worth showing. Both conditions are enforced in the model.
  is_public          TINYINT(1)   NOT NULL DEFAULT 0,
  completeness       TINYINT UNSIGNED NOT NULL DEFAULT 0,

  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (user_id),
  KEY idx_consultant_public_role (is_public, primary_role),
  KEY idx_consultant_country (country),
  KEY idx_consultant_availability (availability),
  CONSTRAINT fk_consultant_profiles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consultant_photos (
  user_id      INT UNSIGNED NOT NULL,
  content_type VARCHAR(64)  NOT NULL DEFAULT 'image/webp',
  bytes        MEDIUMBLOB   NOT NULL,
  byte_size    INT UNSIGNED NOT NULL,
  etag         CHAR(32)     NOT NULL,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_consultant_photos_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE skills (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug       VARCHAR(80)  NOT NULL,
  name       VARCHAR(120) NOT NULL,
  category   VARCHAR(80)  NULL DEFAULT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_skills_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consultant_skills (
  user_id  INT UNSIGNED NOT NULL,
  skill_id INT UNSIGNED NOT NULL,
  level    ENUM('familiar','proficient','expert') NOT NULL DEFAULT 'proficient',
  PRIMARY KEY (user_id, skill_id),
  KEY idx_consultant_skills_skill (skill_id),
  CONSTRAINT fk_consultant_skills_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_consultant_skills_skill FOREIGN KEY (skill_id) REFERENCES skills (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consultant_certifications (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      INT UNSIGNED NOT NULL,
  name         VARCHAR(180) NOT NULL,
  credential_id VARCHAR(120) NULL DEFAULT NULL,
  earned_on    DATE         NULL DEFAULT NULL,
  expires_on   DATE         NULL DEFAULT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_consultant_certification (user_id, name),
  CONSTRAINT fk_consultant_certifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consultant_work_experiences (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  company     VARCHAR(180) NOT NULL,
  title       VARCHAR(180) NOT NULL,
  started_on  DATE         NOT NULL,
  ended_on    DATE         NULL DEFAULT NULL,
  is_current  TINYINT(1)   NOT NULL DEFAULT 0,
  description TEXT         NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_work_user (user_id, started_on),
  CONSTRAINT fk_work_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consultant_projects (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  name        VARCHAR(200) NOT NULL,
  client      VARCHAR(180) NULL DEFAULT NULL,
  cloud       VARCHAR(64)  NULL DEFAULT NULL,
  role        VARCHAR(64)  NULL DEFAULT NULL,
  started_on  DATE         NULL DEFAULT NULL,
  ended_on    DATE         NULL DEFAULT NULL,
  description TEXT         NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_projects_user (user_id),
  CONSTRAINT fk_projects_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE company_profiles (
  user_id      INT UNSIGNED NOT NULL,
  company_name VARCHAR(200) NOT NULL,
  slug         VARCHAR(220) NOT NULL,
  tagline      VARCHAR(255) NULL DEFAULT NULL,
  about        TEXT         NULL,
  industry     VARCHAR(120) NULL DEFAULT NULL,
  company_size ENUM('1-10','11-50','51-200','201-1000','1000+') NULL DEFAULT NULL,
  company_type ENUM('end_customer','consulting_partner','isv','staffing') NOT NULL DEFAULT 'end_customer',
  website      VARCHAR(255) NULL DEFAULT NULL,
  linkedin_url VARCHAR(255) NULL DEFAULT NULL,
  country      CHAR(2)      NULL DEFAULT NULL,
  city         VARCHAR(120) NULL DEFAULT NULL,
  logo         VARCHAR(255) NULL DEFAULT NULL,
  is_public    TINYINT(1)   NOT NULL DEFAULT 1,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_company_slug (slug),
  KEY idx_company_public (is_public),
  CONSTRAINT fk_company_profiles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE company_logos (
  user_id      INT UNSIGNED NOT NULL,
  content_type VARCHAR(64)  NOT NULL DEFAULT 'image/webp',
  bytes        MEDIUMBLOB   NOT NULL,
  byte_size    INT UNSIGNED NOT NULL,
  etag         CHAR(32)     NOT NULL,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_company_logos_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
