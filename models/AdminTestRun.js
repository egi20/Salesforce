'use strict';

const { promisePool } = require('../config/database');

/**
 * Results of running the admin test suite. The test cases themselves live in
 * config/adminTests.js — this model only ever INSERTs the outcome of running them.
 */
class AdminTestRun {
  /** `rows` is an array of results for one batch — inserted together, never one at a time. */
  static async recordBatch(runBatch, runBy, rows) {
    if (rows.length === 0) return;
    const values = rows.map((r) => [
      runBatch,
      r.testKey,
      r.category,
      r.name,
      r.method,
      r.endpoint,
      r.expectedStatus,
      r.actualStatus,
      r.passed ? 1 : 0,
      r.error || null,
      r.durationMs,
      runBy
    ]);
    await promisePool.query(
      `INSERT INTO admin_test_runs
         (run_batch, test_key, category, name, method, endpoint, expected_status, actual_status,
          passed, error, duration_ms, run_by)
       VALUES ?`,
      [values]
    );
  }

  /** The most recent batch's summary — what the "Last Run" banner shows. */
  static async lastRun() {
    const [[latest]] = await promisePool.query(
      'SELECT run_batch, created_at FROM admin_test_runs ORDER BY id DESC LIMIT 1'
    );
    if (!latest) return null;

    const [[counts]] = await promisePool.query(
      'SELECT COUNT(*) AS total, SUM(passed) AS passedCount FROM admin_test_runs WHERE run_batch = ?',
      [latest.run_batch]
    );
    return {
      runBatch: latest.run_batch,
      ranAt: latest.created_at,
      total: counts.total,
      passed: Number(counts.passedCount)
    };
  }

  /** Total number of batches that have ever been run, for the "Total Runs" tile. */
  static async totalRuns() {
    const [[row]] = await promisePool.query(
      'SELECT COUNT(DISTINCT run_batch) AS total FROM admin_test_runs'
    );
    return row.total;
  }

  /** Every row from one batch, most recent status per test — what the list view highlights. */
  static async resultsFor(runBatch) {
    const [rows] = await promisePool.query(
      'SELECT test_key, passed, actual_status, error, duration_ms FROM admin_test_runs WHERE run_batch = ?',
      [runBatch]
    );
    const byKey = {};
    rows.forEach((r) => {
      byKey[r.test_key] = { passed: Boolean(r.passed), actualStatus: r.actual_status, error: r.error, durationMs: r.duration_ms };
    });
    return byKey;
  }

  /**
   * The recent runs, newest first, one row per batch — the history the overview links into.
   * "Was this endpoint broken at 3am and fixed by 9" is the question only past runs answer,
   * and until now the screen showed only the last one.
   */
  static async recent(limit = 20) {
    const [rows] = await promisePool.query(
      `SELECT t.run_batch, MIN(t.created_at) AS ran_at, COUNT(*) AS total, SUM(t.passed) AS passed,
              SUM(t.duration_ms) AS duration_ms, COUNT(DISTINCT t.category) AS categories,
              MAX(u.name) AS run_by_name
         FROM admin_test_runs t
         LEFT JOIN users u ON u.id = t.run_by
        GROUP BY t.run_batch
        ORDER BY MAX(t.id) DESC
        LIMIT ?`,
      [limit]
    );
    return rows.map((r) => ({ ...r, total: Number(r.total), passed: Number(r.passed), duration_ms: Number(r.duration_ms), categories: Number(r.categories) }));
  }

  /** One run in full: every row of the batch in the order it ran, or null. */
  static async batch(runBatch) {
    const [rows] = await promisePool.query(
      `SELECT t.*, u.name AS run_by_name
         FROM admin_test_runs t
         LEFT JOIN users u ON u.id = t.run_by
        WHERE t.run_batch = ?
        ORDER BY t.id`,
      [runBatch]
    );
    if (!rows.length) return null;
    return {
      runBatch,
      ranAt: rows[0].created_at,
      runByName: rows[0].run_by_name,
      total: rows.length,
      passed: rows.filter((r) => r.passed).length,
      durationMs: rows.reduce((n, r) => n + Number(r.duration_ms || 0), 0),
      results: rows
    };
  }
}

module.exports = AdminTestRun;
