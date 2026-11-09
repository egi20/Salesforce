'use strict';

const { promisePool } = require('../config/database');

/**
 * The log behind "Recently generated" on /profile/documents (migration 044).
 *
 * A LOG, never a file store: generated documents are made fresh on each download. Writing to
 * the log never throws — a CV the consultant asked for must not fail to download because a
 * bookkeeping row could not be written, the same standing `Notification.emit` takes.
 */
const KINDS = Object.freeze({
  cv: { label: 'CV', doc: 'cv' },
  rate_card: { label: 'Rate card', doc: null },
  cv_rate_card: { label: 'CV + rate card', doc: 'package' }
});

const MAX_SECTIONS_LENGTH = 255;

class GeneratedDocument {
  static async log(userId, { kind, sections = [], applicationId = null }) {
    if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) return;
    try {
      await promisePool.query(
        'INSERT INTO generated_documents (user_id, kind, sections, application_id) VALUES (?, ?, ?, ?)',
        [userId, kind, sections.length ? sections.join(',').slice(0, MAX_SECTIONS_LENGTH) : null, applicationId]
      );
    } catch (err) {
      console.warn(`generated_documents: could not log a ${kind} for user ${userId}: ${err.message}`);
    }
  }

  /**
   * The most recent entries, with the company an application was for. The company name comes
   * from the job's advertiser at read time, through the consultant's OWN application only.
   */
  static async recentFor(userId, { limit = 8 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT g.id, g.kind, g.sections, g.application_id, g.created_at,
              j.title AS job_title, cp.company_name
         FROM generated_documents g
         LEFT JOIN applications a ON a.id = g.application_id AND a.consultant_user_id = g.user_id
         LEFT JOIN jobs j ON j.id = a.job_id
         LEFT JOIN company_profiles cp ON cp.user_id = j.company_user_id
        WHERE g.user_id = ?
        ORDER BY g.created_at DESC, g.id DESC
        LIMIT ?`,
      [userId, limit]
    );
    return rows.map((r) => ({ ...r, label: KINDS[r.kind].label, sections: r.sections ? r.sections.split(',') : [] }));
  }
}

GeneratedDocument.KINDS = KINDS;

module.exports = GeneratedDocument;
