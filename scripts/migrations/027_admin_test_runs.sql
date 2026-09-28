-- 027 Admin test runs: the RESULTS of the automated-testing panel, never the test cases.
--
-- The test cases themselves stay in `config/adminTests.js`. This codebase's own rule for
-- catalogue data applies exactly here: "roles, cloud modules, phase percentages, day rates
-- and prices stay in config/*.js under version control, where a change has an author, a
-- diff and a review" (see Settings in CLAUDE.md). A list of endpoints and the status codes
-- they should answer with is the same kind of thing — an admin who could add an arbitrary
-- "test" through a web form could just as easily use it to probe internal routes, and
-- either way it is a change with no diff and no review.
--
-- What genuinely IS operational data is the outcome of running the suite: it changes every
-- time someone clicks Run, and the point of keeping it is the history — "was this endpoint
-- broken at 3am and fixed by 9" is a question only past runs can answer. `run_batch` groups
-- every row from one click of Run into one unit, so "the last run" and "how many passed"
-- are a WHERE clause, not a guess from whichever rows happen to be newest.
--
-- `test_key` is derived from the config entry (category + name), not the config's own
-- identity, because config/adminTests.js has no numeric id for a run to reference — the
-- suite is an array, and array position is not a stable identifier across edits.

CREATE TABLE admin_test_runs (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Groups every row from one click of "Run" (or "Run" on one category). Not a foreign
  -- key to anything — there is no separate "batches" table, because the batch IS the set
  -- of rows sharing this value.
  run_batch       CHAR(36)     NOT NULL,

  test_key        VARCHAR(190) NOT NULL,
  category        VARCHAR(120) NOT NULL,
  name            VARCHAR(190) NOT NULL,
  method          VARCHAR(8)   NOT NULL,
  endpoint        VARCHAR(300) NOT NULL,

  expected_status SMALLINT UNSIGNED NOT NULL,
  actual_status   SMALLINT UNSIGNED NULL DEFAULT NULL,
  passed          TINYINT(1)   NOT NULL,
  -- Set only when the request itself failed (connection refused, timeout) rather than
  -- answering with an unexpected status — a distinct failure mode worth telling apart from
  -- "the endpoint answered wrong".
  error           VARCHAR(300) NULL DEFAULT NULL,
  duration_ms     INT UNSIGNED NOT NULL,

  run_by          INT UNSIGNED NULL DEFAULT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_test_runs_batch (run_batch),
  KEY idx_test_runs_key (test_key, created_at),
  CONSTRAINT fk_test_runs_user FOREIGN KEY (run_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
