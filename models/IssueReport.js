'use strict';

const { promisePool } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');
const { LIMITS, isIssueKind, isIssueStatus, canTransition } = require('../config/issues');

/**
 * Reports from people that something is wrong.
 *
 * `/admin/errors` records what the SERVER noticed. This records what a PERSON noticed, which
 * is a different and mostly disjoint set: a button that does nothing, a figure that looks
 * wrong, a rule that behaves differently from what the page says. None of those raise an
 * exception, so without this they arrive as nothing at all and the first sign is somebody
 * leaving.
 *
 * ANONYMOUS REPORTS ARE ACCEPTED. The most valuable report on a marketplace comes from
 * somebody who could not finish signing up, and requiring an account to say "registration is
 * broken" loses precisely the report you most need.
 *
 * NOTHING IS CAPTURED AUTOMATICALLY — no IP, no user agent, no referrer. A bug report is not
 * a reason to start logging visitors, and each of those fields would need a retention rule
 * and a line in the privacy policy. The reporter types what they want us to have.
 */

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function block(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The page the report is about.
 *
 * Kept as a PATH and refused if it is anything else. A full URL typed in here would be an
 * off-site link rendered on an admin screen, and an administrator clicking a link a stranger
 * supplied is the oldest trick there is. It is also rendered with `<%= %>` as text, so this
 * is the second guard rather than the only one.
 */
function pagePath(value) {
  const raw = text(value, LIMITS.pagePath);
  if (!raw) return null;
  // Must start with a single slash and carry no scheme and no authority. `//evil.com` is a
  // protocol-relative URL, which a browser treats as off-site — hence the second character.
  if (!raw.startsWith('/') || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  return raw;
}

class IssueReport {
  static buildFilter(filters = {}) {
    const clauses = [];
    const params = [];

    if (filters.status && isIssueStatus(filters.status)) {
      clauses.push('i.status = ?');
      params.push(filters.status);
    }
    if (filters.kind && isIssueKind(filters.kind)) {
      clauses.push('i.kind = ?');
      params.push(filters.kind);
    }
    if (filters.q && String(filters.q).trim()) {
      const like = containsPattern(filters.q);
      clauses.push('(i.summary LIKE ? OR i.detail LIKE ?)');
      params.push(like, like);
    }
    return { clause: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
  }

  static async create(input = {}, { userId = null } = {}) {
    const summary = text(input.summary, LIMITS.summary);
    if (summary.length < 5) fail('SUMMARY_REQUIRED', 'Say in one line what went wrong.');

    const detail = block(input.detail, LIMITS.detail);
    if (detail.length < 10) fail('DETAIL_REQUIRED', 'Tell us what you did and what happened.');

    const kind = isIssueKind(input.kind) ? input.kind : 'bug';

    const email = text(input.contact_email, LIMITS.email).toLowerCase();
    if (email && !EMAIL_RE.test(email)) fail('BAD_EMAIL', 'That email address does not look right.');
    // An address is only worth storing when there is no account to answer through. Keeping a
    // typed address beside a signed-in report is a second copy of something we already hold.
    const contactEmail = userId ? null : email || null;

    const [result] = await promisePool.query(
      `INSERT INTO issue_reports (user_id, page_path, kind, summary, detail, contact_email)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, pagePath(input.page_path), kind, summary, detail, contactEmail]
    );
    return { id: result.insertId };
  }

  /** What a signed-in reporter sees: their own reports, and any answer. */
  static async listForUser(userId) {
    const [rows] = await promisePool.query(
      `SELECT id, kind, summary, detail, status, response, responded_at, created_at, page_path
         FROM issue_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
      [userId]
    );
    return rows;
  }

  static async list(filters = {}, { limit = 50, offset = 0 } = {}) {
    const { clause, params } = IssueReport.buildFilter(filters);
    const [rows] = await promisePool.query(
      `SELECT i.*, u.name AS reporter_name, u.email AS reporter_email
         FROM issue_reports i LEFT JOIN users u ON u.id = i.user_id
        WHERE ${clause}
        ORDER BY FIELD(i.status, 'new', 'open', 'closed'), i.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM issue_reports i WHERE ${clause}`,
      params
    );
    return { rows, total };
  }

  static async counts() {
    const [rows] = await promisePool.query(
      'SELECT status, COUNT(*) AS n FROM issue_reports GROUP BY status'
    );
    return rows.reduce((acc, r) => ({ ...acc, [r.status]: Number(r.n) }), {});
  }

  /**
   * Move a report along, optionally writing an answer the reporter will see.
   *
   * There is no delete, deliberately: a dismissed report is evidence that somebody complained
   * and nothing happened, which is the most useful row in this table the fourth time the same
   * thing is reported.
   */
  static async setStatus(id, to, { response = null, actorUserId = null } = {}) {
    const [[issue]] = await promisePool.query('SELECT id, status FROM issue_reports WHERE id = ?', [id]);
    if (!issue) fail('NOT_FOUND', 'That report no longer exists.');
    if (!canTransition(issue.status, to)) {
      fail('BAD_TRANSITION', `A report cannot go from ${issue.status} to ${to}.`);
    }

    const answer = block(response, LIMITS.response) || null;
    await promisePool.query(
      `UPDATE issue_reports
          SET status = ?,
              response = COALESCE(?, response),
              responded_at = CASE WHEN ? IS NULL THEN responded_at ELSE NOW() END,
              responded_by = CASE WHEN ? IS NULL THEN responded_by ELSE ? END
        WHERE id = ?`,
      [to, answer, answer, answer, actorUserId, id]
    );
    return true;
  }

  static async findById(id) {
    const [[row]] = await promisePool.query(
      `SELECT i.*, u.name AS reporter_name, u.email AS reporter_email
         FROM issue_reports i LEFT JOIN users u ON u.id = i.user_id WHERE i.id = ?`,
      [id]
    );
    return row || null;
  }
}

IssueReport.pagePath = pagePath;

module.exports = IssueReport;
