'use strict';

const { promisePool } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');

/**
 * Persisted application errors, for the admin panel.
 *
 * `record()` swallows its own failures: an error handler that throws while logging an
 * error turns a 500 into an unhandled rejection and takes the process with it.
 */
class ErrorLog {
  static async record(err, req = null, statusCode = 500) {
    try {
      await promisePool.query(
        `INSERT INTO error_logs (message, stack, method, path, status_code, user_id, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          String(err && err.message ? err.message : err).slice(0, 500),
          err && err.stack ? String(err.stack).slice(0, 10000) : null,
          req ? req.method : null,
          req ? String(req.originalUrl || req.url).slice(0, 255) : null,
          statusCode,
          req && req.session && req.session.user ? req.session.user.id : null,
          req ? String(req.get('user-agent') || '').slice(0, 255) : null
        ]
      );
    } catch (logErr) {
      console.error(`Failed to persist error log: ${logErr.message}`);
    }
  }

  /**
   * THE ONE FILTER BUILDER for the log: the list, its count, the export and the delete all
   * come through it, so the rows deleted are provably the rows listed. `to` is a whole day,
   * EXCLUSIVE of the next one: `<= '2026-01-05'` means midnight at the START of the 5th and
   * would silently drop everything that happened on it.
   */
  static buildFilter({ q = '', statusCode = '', from = '', to = '' } = {}) {
    const where = [];
    const params = [];
    if (q) {
      const like = containsPattern(q);
      where.push('(message LIKE ? OR path LIKE ?)');
      params.push(like, like);
    }
    const code = Number.parseInt(statusCode, 10);
    if (Number.isInteger(code) && code >= 100 && code <= 599) {
      where.push('status_code = ?');
      params.push(code);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      where.push('created_at >= ?');
      params.push(from);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      where.push('created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      params.push(to);
    }
    return { clause: where.length ? where.join(' AND ') : '1 = 1', params };
  }

  static async list(filters = {}, { limit = 50, offset = 0 } = {}) {
    const { clause, params } = ErrorLog.buildFilter(filters);
    const [rows] = await promisePool.query(
      `SELECT * FROM error_logs WHERE ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(`SELECT COUNT(*) AS total FROM error_logs WHERE ${clause}`, params);
    return { rows, total };
  }

  /** The status codes the table holds, so the control offers only real ones. */
  static async statusCodes() {
    const [rows] = await promisePool.query(
      'SELECT DISTINCT status_code FROM error_logs WHERE status_code IS NOT NULL ORDER BY status_code'
    );
    return rows.map((r) => r.status_code);
  }

  /**
   * The rows the screen lists, newest first, for the CSV export. The stack trace is left
   * out deliberately: it is the one field that can carry a file path, a query fragment or a
   * value from the request that produced it, and an export is a file that leaves the
   * machine and gets attached to things. Capped, so a bad week is not a request that reads
   * the whole table into memory.
   */
  static async exportRows(filters = {}, { limit = 5000 } = {}) {
    const { clause, params } = ErrorLog.buildFilter(filters);
    const [rows] = await promisePool.query(
      `SELECT created_at, status_code, method, path, message, user_id
         FROM error_logs
        WHERE ${clause}
        ORDER BY created_at DESC
        LIMIT ?`,
      [...params, limit]
    );
    return rows;
  }

  /**
   * Delete exactly the rows the screen showed under a filter (2026-11-06, owner: "once the
   * errors are fixed, delete them in prod"). An unfiltered call is REFUSED — clearing the
   * whole log is the age-window purge's job. The screen posts the count it showed and a
   * different count deletes nothing (the bulk interlock), and the delete is bounded by the
   * highest id counted, so an error recorded after the page loaded is never removed unseen.
   */
  static async deleteMatching(filters = {}, expectedCount) {
    const { clause, params } = ErrorLog.buildFilter(filters);
    if (clause === '1 = 1') {
      const err = new Error('Choose a filter first: deleting the whole log is what the age-window purge is for.');
      err.code = 'ERROR_LOG_NO_FILTER';
      throw err;
    }
    const conn = await promisePool.getConnection();
    try {
      await conn.beginTransaction();
      const [[{ n, maxId }]] = await conn.query(
        `SELECT COUNT(*) AS n, MAX(id) AS maxId FROM error_logs WHERE ${clause}`,
        params
      );
      if (Number(n) !== Number(expectedCount)) {
        const err = new Error(`The filter now matches ${n} entries, not the ${expectedCount} shown. Nothing was deleted; reload and check.`);
        err.code = 'ERROR_LOG_COUNT_MISMATCH';
        throw err;
      }
      const [result] = await conn.query(
        `DELETE FROM error_logs WHERE ${clause} AND id <= ?`,
        [...params, maxId || 0]
      );
      await conn.commit();
      return result.affectedRows;
    } catch (err) {
      try { await conn.rollback(); } catch (e) { /* nothing to roll back */ }
      throw err;
    } finally {
      conn.release();
    }
  }

  static async purgeOlderThan(days = 90) {
    const [result] = await promisePool.query('DELETE FROM error_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [days]);
    return result.affectedRows;
  }
}

module.exports = ErrorLog;
