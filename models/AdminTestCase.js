'use strict';

const { promisePool, withTransaction } = require('../config/database');
const { normaliseCase, caseSafetyProblems, statusList } = require('../config/adminTests');

/*
 * The test cases the admin panel runs, and the results of running them.
 *
 * Rows with a `builtin_key` are the code-defined suite in config/adminTests.js, written only
 * by `rebuildBuiltins`. Rows without one were added by a superadmin through the form. Both
 * kinds pass `caseSafetyProblems()` before they are stored, and the runner checks again
 * before it sends anything, so a row edited behind the application's back is refused at the
 * last moment rather than trusted.
 *
 * JSON columns come back parsed from MySQL and as strings from MariaDB, so `fromRow` accepts
 * either — the same trap `nextSortOrder` hit with a numeric string.
 */
function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

function fromRow(row) {
  return {
    id: row.id,
    builtinKey: row.builtin_key,
    isBuiltin: Boolean(row.builtin_key),
    name: row.name,
    description: row.description,
    category: row.category,
    testType: row.test_type,
    method: row.method,
    endpoint: row.endpoint,
    headers: parseJson(row.headers),
    expectedStatus: statusList(row.expected_status),
    expectedContains: parseJson(row.expected_contains),
    expectedNotContains: parseJson(row.expected_not_contains),
    expectedRedirect: row.expected_redirect,
    timeoutMs: row.timeout_ms,
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order,
    authRole: row.auth_role,
    createdAt: row.created_at
  };
}

/** The column values for one normalised case, in INSERT order. */
function columnValues(c) {
  return [
    c.name,
    c.description || null,
    c.category,
    c.testType,
    c.method,
    c.endpoint,
    c.headers && Object.keys(c.headers).length ? JSON.stringify(c.headers) : null,
    c.expectedStatus.join(','),
    c.expectedContains && c.expectedContains.length ? JSON.stringify(c.expectedContains) : null,
    c.expectedNotContains && c.expectedNotContains.length ? JSON.stringify(c.expectedNotContains) : null,
    c.expectedRedirect || null,
    c.timeoutMs,
    c.authRole || null
  ];
}

function unsafe(problems) {
  const err = new Error(`That test case is not allowed: ${problems.join('; ')}`);
  err.code = 'TEST_CASE_UNSAFE';
  return err;
}

class AdminTestCase {
  /**
   * Every case, in the order the screen and the runner read them. Sorted in SQL: the list
   * query names its columns rather than `SELECT *`, so there is no wide row to filesort —
   * the reason the reference gave for sorting in Node.
   */
  static async list({ enabledOnly = false, category = null } = {}) {
    const where = [];
    const params = [];
    if (enabledOnly) where.push('enabled = 1');
    if (category) {
      where.push('category = ?');
      params.push(category);
    }
    const [rows] = await promisePool.query(
      `SELECT id, builtin_key, name, description, category, test_type, method, endpoint, headers,
              expected_status, expected_contains, expected_not_contains, expected_redirect,
              timeout_ms, enabled, sort_order, auth_role, created_at
         FROM admin_test_cases
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY (builtin_key IS NULL), sort_order, category, id`,
      params
    );
    return rows.map(fromRow);
  }

  static async categories() {
    const [rows] = await promisePool.query(
      'SELECT category, MIN(sort_order) AS first FROM admin_test_cases GROUP BY category ORDER BY MIN(builtin_key IS NULL), first, category'
    );
    return rows.map((r) => r.category);
  }

  static async findById(id) {
    const [rows] = await promisePool.query('SELECT * FROM admin_test_cases WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  static async statistics() {
    const [[row]] = await promisePool.query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(enabled = 1), 0) AS enabled,
              COALESCE(SUM(builtin_key IS NULL), 0) AS custom,
              COALESCE(SUM(auth_role IS NOT NULL AND enabled = 1), 0) AS signed_in,
              COUNT(DISTINCT category) AS categories,
              (SELECT COUNT(DISTINCT run_id) FROM admin_test_results) AS runs
         FROM admin_test_cases`
    );
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
  }

  /**
   * Replace the built-in rows with the suite in the code, and touch nothing else.
   *
   * The reference DROPs both tables and reseeds, which deletes every case a person added and
   * every result ever recorded. Here a built-in is upserted by its key (and switched back
   * ON, so a rebuild is also how a disabled built-in is restored), a built-in the code no
   * longer has is deleted, and custom rows are not read at all. Results keep their copy of
   * what was run; their link to a deleted case becomes NULL.
   */
  static async rebuildBuiltins(suite) {
    const cases = suite.map((raw) => normaliseCase(raw));
    cases.forEach((c) => {
      const problems = caseSafetyProblems(c);
      if (problems.length) throw unsafe(problems);
    });

    return withTransaction(async (conn) => {
      let order = 0;
      for (const c of cases) {
        order += 1;
        // eslint-disable-next-line no-await-in-loop
        await conn.query(
          `INSERT INTO admin_test_cases
             (name, description, category, test_type, method, endpoint, headers, expected_status,
              expected_contains, expected_not_contains, expected_redirect, timeout_ms, auth_role,
              builtin_key, sort_order, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE
             name = VALUES(name), description = VALUES(description), category = VALUES(category),
             test_type = VALUES(test_type), method = VALUES(method), endpoint = VALUES(endpoint),
             headers = VALUES(headers), expected_status = VALUES(expected_status),
             expected_contains = VALUES(expected_contains),
             expected_not_contains = VALUES(expected_not_contains),
             expected_redirect = VALUES(expected_redirect), timeout_ms = VALUES(timeout_ms),
             auth_role = VALUES(auth_role), sort_order = VALUES(sort_order), enabled = 1,
             updated_at = NOW()`,
          [...columnValues(c), c.key, order]
        );
      }
      const keys = cases.map((c) => c.key);
      const [removed] = await conn.query(
        'DELETE FROM admin_test_cases WHERE builtin_key IS NOT NULL AND builtin_key NOT IN (?)',
        [keys]
      );
      const [[custom]] = await conn.query('SELECT COUNT(*) AS n FROM admin_test_cases WHERE builtin_key IS NULL');
      return { builtins: cases.length, removed: removed.affectedRows, customKept: Number(custom.n) };
    });
  }

  /** A case a superadmin typed in. Refused, never repaired, when it fails the safety rule. */
  static async createCustom(input, createdBy) {
    const c = normaliseCase(input);
    const problems = caseSafetyProblems(c);
    if (problems.length) throw unsafe(problems);
    const [[last]] = await promisePool.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM admin_test_cases');
    const [result] = await promisePool.query(
      `INSERT INTO admin_test_cases
         (name, description, category, test_type, method, endpoint, headers, expected_status,
          expected_contains, expected_not_contains, expected_redirect, timeout_ms, auth_role,
          sort_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      // Number(): MariaDB returns COALESCE(MAX(..)) as a string, and "5" + 1 is "51".
      [...columnValues(c), Number(last.n) + 1, createdBy || null]
    );
    return result.insertId;
  }

  static async setEnabled(id, enabled) {
    const [result] = await promisePool.query(
      'UPDATE admin_test_cases SET enabled = ?, updated_at = NOW() WHERE id = ?',
      [enabled ? 1 : 0, id]
    );
    return result.affectedRows > 0;
  }

  static async remove(id) {
    const [result] = await promisePool.query('DELETE FROM admin_test_cases WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  /* ------------------------------------------------------------------ results */

  static async recordResults(runId, runBy, rows) {
    if (!rows.length) return;
    const values = rows.map((r) => [
      runId,
      r.testCaseId,
      r.category,
      r.name,
      r.method,
      r.endpoint,
      r.authRole || null,
      r.expectedStatus.join(','),
      r.outcome,
      r.statusCode,
      r.durationMs,
      r.excerpt || null,
      r.error ? String(r.error).slice(0, 1000) : null,
      runBy || null
    ]);
    await promisePool.query(
      `INSERT INTO admin_test_results
         (run_id, test_case_id, category, name, method, endpoint, auth_role, expected_status,
          outcome, status_code, duration_ms, response_excerpt, error_message, run_by)
       VALUES ?`,
      [values]
    );
  }

  /** The recent runs, newest first, one row per run. */
  static async recentRuns(limit = 15) {
    const [rows] = await promisePool.query(
      `SELECT r.run_id, MIN(r.created_at) AS ran_at, COUNT(*) AS total,
              SUM(r.outcome = 'passed') AS passed, SUM(r.outcome = 'failed') AS failed,
              SUM(r.outcome = 'skipped') AS skipped, SUM(r.duration_ms) AS duration_ms,
              COUNT(DISTINCT r.category) AS categories, MAX(u.name) AS run_by_name
         FROM admin_test_results r
         LEFT JOIN users u ON u.id = r.run_by
        GROUP BY r.run_id
        ORDER BY MAX(r.id) DESC
        LIMIT ?`,
      [limit]
    );
    return rows.map((r) => ({
      runId: r.run_id,
      ranAt: r.ran_at,
      total: Number(r.total),
      passed: Number(r.passed),
      failed: Number(r.failed),
      skipped: Number(r.skipped),
      durationMs: Number(r.duration_ms),
      categories: Number(r.categories),
      runByName: r.run_by_name
    }));
  }

  /** The latest outcome of each case in the most recent run — what the list marks. */
  static async lastOutcomes(runId) {
    if (!runId) return {};
    const [rows] = await promisePool.query(
      'SELECT test_case_id, outcome, status_code, error_message FROM admin_test_results WHERE run_id = ? AND test_case_id IS NOT NULL',
      [runId]
    );
    const byId = {};
    rows.forEach((r) => {
      byId[r.test_case_id] = { outcome: r.outcome, statusCode: r.status_code, error: r.error_message };
    });
    return byId;
  }

  /** One run in full, failures first, then skipped, then passes; or null. */
  static async run(runId) {
    const [rows] = await promisePool.query(
      `SELECT r.*, u.name AS run_by_name
         FROM admin_test_results r
         LEFT JOIN users u ON u.id = r.run_by
        WHERE r.run_id = ?
        ORDER BY FIELD(r.outcome, 'failed', 'skipped', 'passed'), r.id`,
      [runId]
    );
    if (!rows.length) return null;
    const count = (o) => rows.filter((r) => r.outcome === o).length;
    return {
      runId,
      ranAt: rows.reduce((min, r) => (r.created_at < min ? r.created_at : min), rows[0].created_at),
      runByName: rows[0].run_by_name,
      total: rows.length,
      passed: count('passed'),
      failed: count('failed'),
      skipped: count('skipped'),
      durationMs: rows.reduce((n, r) => n + Number(r.duration_ms || 0), 0),
      results: rows
    };
  }
}

module.exports = AdminTestCase;
module.exports.fromRow = fromRow;
