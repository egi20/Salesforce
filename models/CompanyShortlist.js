'use strict';

const { promisePool } = require('../config/database');

/**
 * A company's private shortlist of consultants (migration 041).
 *
 * Private to the company that made it, and that is the whole design: the consultant is not
 * told and cannot see it, and nothing anybody else reads joins on this table. Whether a
 * consultant being on a list should ever be visible to them is a question with no obvious
 * answer, so the list answers it the conservative way and says so on the page.
 *
 * It never makes anybody visible. Adding refuses a profile this company cannot see in the
 * directory, and the shortlist view lists through `ConsultantProfile.buildFilter` with the
 * company as viewer — a profile that went private or hid itself from this company drops out.
 */
class CompanyShortlist {
  /** Idempotent: adding twice is a no-op on the primary key. */
  static async add(companyUserId, consultantUserId) {
    await promisePool.query(
      'INSERT IGNORE INTO company_shortlists (user_id, consultant_user_id) VALUES (?, ?)',
      [companyUserId, consultantUserId]
    );
  }

  static async remove(companyUserId, consultantUserId) {
    await promisePool.query('DELETE FROM company_shortlists WHERE user_id = ? AND consultant_user_id = ?', [
      companyUserId,
      consultantUserId
    ]);
  }

  /** Which of these consultants this company has shortlisted, as a Set — one query per page. */
  static async idsFor(companyUserId, consultantUserIds) {
    if (!companyUserId || !consultantUserIds || consultantUserIds.length === 0) return new Set();
    const [rows] = await promisePool.query(
      'SELECT consultant_user_id FROM company_shortlists WHERE user_id = ? AND consultant_user_id IN (?)',
      [companyUserId, consultantUserIds]
    );
    return new Set(rows.map((r) => r.consultant_user_id));
  }
}

module.exports = CompanyShortlist;
