-- 042 Admin test cases in the database, with their results per run.
--
-- Migration 028 kept the cases in `config/adminTests.js` and only the results here, and
-- argued that a list of endpoints an administrator can edit through a form is a probe
-- with an admin's network position. That argument still holds, and the shape below is
-- what answers it rather than a reason to keep the list out of the database:
--
--   * The BUILT-IN suite is still code. `builtin_key` names its entry in
--     config/adminTests.js, and "Rebuild suite" replaces those rows from the code — so the
--     cases that guard the site have an author, a diff and a review exactly as before.
--   * A CUSTOM case (`builtin_key` NULL) is added by a superadmin, and every one of them —
--     built-in or not — passes `caseSafetyProblems()` before it is stored and again before
--     it runs: a relative path on this site, never another host, and a write only when the
--     CSRF layer refuses it before any handler runs.
--
-- Custom cases survive a rebuild. Only rows with a `builtin_key` are replaced, and a
-- built-in removed from the code is deleted here; nothing a person added is touched.
--
-- `admin_test_runs` (028) is left exactly as it was and is no longer written. Its rows name
-- a test by "category::name" against a suite that has since changed, so they cannot be
-- mapped onto these rows without guessing, and a migration that guesses at history is
-- worse than one that keeps it.

CREATE TABLE admin_test_cases (
  id                    INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The entry's key in config/adminTests.js; NULL for a case somebody added. UNIQUE so a
  -- rebuild is an upsert and can never leave two rows for one built-in. NULLs do not
  -- collide in a MySQL unique index, so custom cases are free to share the column.
  builtin_key           VARCHAR(190) NULL DEFAULT NULL,

  name                  VARCHAR(190) NOT NULL,
  description           VARCHAR(500) NULL DEFAULT NULL,
  category              VARCHAR(120) NOT NULL,
  test_type             ENUM('api', 'page', 'form') NOT NULL DEFAULT 'page',

  -- No PUT, PATCH or DELETE: nothing this panel sends may change data, and a POST is only
  -- ever a refused one (see caseSafetyProblems).
  method                ENUM('GET', 'POST') NOT NULL DEFAULT 'GET',
  endpoint              VARCHAR(300) NOT NULL,
  -- Only the request headers named in ALLOWED_HEADERS are honoured; anything else stored
  -- here is dropped by the runner, so a case cannot carry a cookie or a CSRF token.
  headers               JSON         NULL DEFAULT NULL,
  -- There is no `body` column, although the reference has one. The only POST a case may
  -- send is one the CSRF layer refuses before a handler runs, so a body would either be
  -- ignored or — on the day that layer failed open — be a real write. An empty POST is the
  -- one that fails validation either way.

  -- One code ("200") or a comma list ("200,404"), the same choice the reference offers.
  expected_status       VARCHAR(60)  NOT NULL DEFAULT '200',
  expected_contains     JSON         NULL DEFAULT NULL,
  expected_not_contains JSON         NULL DEFAULT NULL,
  -- The Location a redirect must name: exactly, or followed by `?` or `#`.
  expected_redirect     VARCHAR(300) NULL DEFAULT NULL,

  timeout_ms            INT UNSIGNED NOT NULL DEFAULT 10000,
  enabled               TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order            INT          NOT NULL DEFAULT 0,

  -- NULL runs as a visitor. Otherwise the QA account for that role, signed in through the
  -- real login form. There is no 'superadmin': the QA admin is a plain admin, always.
  auth_role             ENUM('consultant', 'company', 'recruiter', 'admin') NULL DEFAULT NULL,

  created_by            INT UNSIGNED NULL DEFAULT NULL,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Set explicitly by the writer; no ON UPDATE (see "Consent and immutable dates").
  updated_at            DATETIME     NULL DEFAULT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_test_cases_builtin (builtin_key),
  KEY idx_admin_test_cases_category (category, sort_order),
  CONSTRAINT fk_admin_test_cases_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per case per run. The case's name, category, method and endpoint are COPIED
-- here, and the link to the case is SET NULL on delete: a run is a record of what was
-- checked on a date, and deleting a case afterwards must not rewrite what that run said.
-- The reference cascades its results away with the case.
CREATE TABLE admin_test_results (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id           CHAR(36)     NOT NULL,
  test_case_id     INT UNSIGNED NULL DEFAULT NULL,

  category         VARCHAR(120) NOT NULL,
  name             VARCHAR(190) NOT NULL,
  method           VARCHAR(8)   NOT NULL,
  endpoint         VARCHAR(300) NOT NULL,
  auth_role        VARCHAR(20)  NULL DEFAULT NULL,
  expected_status  VARCHAR(60)  NOT NULL,

  -- 'skipped' is its own outcome, never a pass: a signed-in case with no QA password, or
  -- one whose role could not sign in, is recorded as not having been checked at all.
  outcome          ENUM('passed', 'failed', 'skipped') NOT NULL,
  status_code      SMALLINT UNSIGNED NULL DEFAULT NULL,
  duration_ms      INT UNSIGNED NOT NULL DEFAULT 0,
  -- The visible text of a FAILED response, short. Kept only for failures: a passing page's
  -- excerpt answers nothing, and an admin page's text is somebody's data.
  response_excerpt VARCHAR(600)  NULL DEFAULT NULL,
  error_message    VARCHAR(1000) NULL DEFAULT NULL,

  run_by           INT UNSIGNED NULL DEFAULT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_admin_test_results_run (run_id, id),
  KEY idx_admin_test_results_case (test_case_id, id),
  CONSTRAINT fk_admin_test_results_case FOREIGN KEY (test_case_id) REFERENCES admin_test_cases (id) ON DELETE SET NULL,
  CONSTRAINT fk_admin_test_results_user FOREIGN KEY (run_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Where an error-log row came from. A failed self-test is recorded as 'self_test' so it can
-- be told apart from an exception the server raised, filtered on, and deleted by filter once
-- fixed — and because it is written directly rather than through the error handler, the
-- CSRF-scanner suppression never sees it and cannot hide it.
ALTER TABLE error_logs
  ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'server' AFTER id;
