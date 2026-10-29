'use strict';

const sharp = require('sharp');
const { promisePool } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');
const {
  LIMITS, isIssueKind, isIssueStatus, canTransition, ISSUE_SEVERITY_VALUES, SCREENSHOTS, IDEA_KIND, CONTENT_KIND
} = require('../config/issues');

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

    // Optional, from a declared list; an idea is not a fault, so it has none.
    const severity = kind !== IDEA_KIND && ISSUE_SEVERITY_VALUES.includes(input.severity) ? input.severity : null;
    // The content being reported, only for that kind, and only as a path on this site.
    const contentPath = kind === CONTENT_KIND ? pagePath(input.content_path) : null;
    // An unticked box posts nothing, so absence is refusal and is never defaulted.
    const publishConsent = kind === IDEA_KIND && input.publish_consent === 'on' ? 1 : 0;

    const [result] = await promisePool.query(
      `INSERT INTO issue_reports
         (user_id, page_path, content_path, kind, severity, summary, detail, contact_email, publish_consent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, pagePath(input.page_path), contentPath, kind, severity, summary, detail, contactEmail, publishConsent]
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
      `SELECT i.*, u.name AS reporter_name, u.email AS reporter_email,
              (SELECT COUNT(*) FROM issue_report_attachments a WHERE a.issue_id = i.id) AS attachment_count,
              (SELECT COUNT(*) FROM idea_votes v WHERE v.issue_id = i.id) AS votes
         FROM issue_reports i LEFT JOIN users u ON u.id = i.user_id
        WHERE ${clause}
        ORDER BY FIELD(i.status, 'new', 'open', 'closed'), (i.severity = 'critical') DESC, i.created_at DESC
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
              closed_at = CASE WHEN ? = 'closed' THEN NOW() ELSE closed_at END,
              response = COALESCE(?, response),
              responded_at = CASE WHEN ? IS NULL THEN responded_at ELSE NOW() END,
              responded_by = CASE WHEN ? IS NULL THEN responded_by ELSE ? END
        WHERE id = ?`,
      [to, to, answer, answer, answer, actorUserId, id]
    );
    return true;
  }

  /* ------------------------------------------------------------ screenshots */

  /**
   * Store screenshots on a report. Each buffer is re-encoded by sharp first — that is the
   * sanitiser, as for profile photographs, and it also drops EXIF, location included — and
   * bounded on its long side, which keeps a 4K screenshot readable at a few hundred
   * kilobytes. Anything that is not an image fails to decode and throws.
   */
  static async addAttachments(issueId, buffers) {
    for (const buffer of buffers.slice(0, SCREENSHOTS.maxFiles)) {
      // eslint-disable-next-line no-await-in-loop
      const { data, info } = await sharp(buffer)
        .rotate()
        .resize(SCREENSHOTS.maxEdgePx, SCREENSHOTS.maxEdgePx, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer({ resolveWithObject: true });
      // eslint-disable-next-line no-await-in-loop
      await promisePool.query(
        `INSERT INTO issue_report_attachments (issue_id, content_type, bytes, byte_size, width, height)
         VALUES (?, 'image/webp', ?, ?, ?, ?)`,
        [issueId, data, data.length, info.width, info.height]
      );
    }
  }

  /** Metadata for the queue, keyed by report — never the bytes. */
  static async attachmentsFor(issueIds) {
    const out = {};
    if (!issueIds.length) return out;
    const [rows] = await promisePool.query(
      `SELECT id, issue_id, byte_size, width, height FROM issue_report_attachments
        WHERE issue_id IN (?) ORDER BY id`,
      [issueIds]
    );
    rows.forEach((r) => { (out[r.issue_id] = out[r.issue_id] || []).push(r); });
    return out;
  }

  /** One screenshot's bytes, matched on BOTH ids so one report's URL cannot reach another's. */
  static async attachment(issueId, attachmentId) {
    const [rows] = await promisePool.query(
      'SELECT content_type, bytes FROM issue_report_attachments WHERE issue_id = ? AND id = ? LIMIT 1',
      [issueId, attachmentId]
    );
    return rows[0] || null;
  }

  /** Delete screenshots past the stated retention after closing. The report text stays. */
  static async purgeExpiredAttachments(days = SCREENSHOTS.retentionDaysAfterClose) {
    const [result] = await promisePool.query(
      `DELETE a FROM issue_report_attachments a
         JOIN issue_reports i ON i.id = a.issue_id
        WHERE i.status = 'closed' AND i.closed_at IS NOT NULL AND i.closed_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [days]
    );
    return result.affectedRows;
  }

  /** How many are due to go, so the promise on the form is checkable rather than claimed. */
  static async attachmentsDueForPurge(days = SCREENSHOTS.retentionDaysAfterClose) {
    const [[row]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM issue_report_attachments a
         JOIN issue_reports i ON i.id = a.issue_id
        WHERE i.status = 'closed' AND i.closed_at IS NOT NULL AND i.closed_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [days]
    );
    return Number(row.total);
  }

  /* ------------------------------------------------------------------ ideas */

  /**
   * THE one definition of "a published idea": its kind, its sender's consent, and an
   * administrator's decision. Every public read and every vote goes through this fragment,
   * so no page can show an idea that is missing one of the three.
   */
  static publicIdeaFilter() {
    return { clause: 'i.kind = ? AND i.publish_consent = 1 AND i.published_at IS NOT NULL', params: [IDEA_KIND] };
  }

  /** Publish or unpublish. The WHERE refuses an idea sent without consent, whatever is posted. */
  static async setIdeaPublished(id, published, adminUserId) {
    const [result] = await promisePool.query(
      `UPDATE issue_reports
          SET published_at = CASE WHEN ? = 1 THEN NOW() ELSE NULL END, published_by = ?
        WHERE id = ? AND kind = ? AND publish_consent = 1`,
      [published ? 1 : 0, published ? adminUserId : null, id, IDEA_KIND]
    );
    return result.affectedRows === 1;
  }

  /** Published ideas with their vote counts and whether the viewer voted. No names, no emails. */
  static async publishedIdeas({ viewerUserId = null, limit = 100 } = {}) {
    const { clause, params } = IssueReport.publicIdeaFilter();
    const [rows] = await promisePool.query(
      `SELECT i.id, i.summary, i.detail, i.status, i.response, i.published_at,
              (SELECT COUNT(*) FROM idea_votes v WHERE v.issue_id = i.id) AS votes,
              EXISTS (SELECT 1 FROM idea_votes v WHERE v.issue_id = i.id AND v.user_id = ?) AS my_vote
         FROM issue_reports i
        WHERE ${clause}
        ORDER BY votes DESC, i.published_at DESC
        LIMIT ?`,
      [viewerUserId || 0, ...params, limit]
    );
    return rows.map((r) => ({ ...r, votes: Number(r.votes), my_vote: Boolean(Number(r.my_vote)) }));
  }

  /**
   * Vote, or take the vote back. Refused for anything that is not a published idea, so a
   * vote cannot be cast on a report nobody was meant to see — or used to discover which ids
   * are ideas waiting to be published.
   */
  static async toggleIdeaVote(id, userId) {
    const { clause, params } = IssueReport.publicIdeaFilter();
    const [[idea]] = await promisePool.query(`SELECT i.id FROM issue_reports i WHERE i.id = ? AND ${clause}`, [id, ...params]);
    if (!idea) return { ok: false };
    const [removed] = await promisePool.query('DELETE FROM idea_votes WHERE issue_id = ? AND user_id = ?', [id, userId]);
    if (removed.affectedRows) return { ok: true, voted: false };
    await promisePool.query('INSERT IGNORE INTO idea_votes (issue_id, user_id) VALUES (?, ?)', [id, userId]);
    return { ok: true, voted: true };
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
