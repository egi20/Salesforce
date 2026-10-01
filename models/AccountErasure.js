'use strict';

const { withTransaction, promisePool } = require('../config/database');

/**
 * Erasing an account.
 *
 * THE RULE: destroy everything that identifies a person; keep everything that belongs to
 * somebody ELSE's record, to a published aggregate, or to a legal obligation — with nothing
 * left tying it to a human being.
 *
 * `scripts/migrations/023_account_erasure.sql` sets out why `DELETE FROM users` is wrong:
 * it would move a published percentile, leave `posts.reply_count` permanently wrong on other
 * people's questions, and destroy financial records with a statutory retention period. All
 * three are rules this codebase already states elsewhere; erasure must not become the back
 * door around them.
 *
 * ONE MODULE, one transaction. Same reason `models/Moderation.js` is the only thing that
 * touches the hidden flags: a second place that erases an account is a second place that can
 * forget one of these tables, and the failure is silent — a name left behind in a row nobody
 * thought about.
 */

/**
 * Tables holding personal data about the ACCOUNT HOLDER that nothing else depends on.
 * Deleted outright. Every one of these is something the person published or uploaded about
 * themselves; none of it appears in anybody else's record.
 */
const PURGE = Object.freeze([
  // The consultant's dossier — the CV, in pieces.
  'consultant_work_experiences',
  'consultant_certifications',
  'consultant_projects',
  'consultant_skills',
  'consultant_photos',
  'consultant_profiles',
  // The company and recruiter equivalents.
  'company_clauses',
  'company_templates',
  'company_logos',
  'company_profiles',
  'recruiter_logos',
  'recruiter_profiles',
  // Credentials and identity links. `external_identities` holds the LinkedIn subject, which
  // is an identifier for a named person at a third party.
  'email_verifications',
  'password_reset_tokens',
  'external_identities',
  /*
   * The photo and logo tables hold the BYTES, keyed by user_id — they are the side tables
   * `models/ImageBlob.js` writes to, not pointers to something else. Deleting the profile
   * row does not reach them, so they are listed here in their own right: a photograph of
   * somebody's face is the least ambiguous personal data on this site, and the one that
   * would survive a careless erasure.
   */
  // Private activity that is nobody else's record.
  'saved_jobs',
  'post_votes',
  'challenge_attempts'
]);

/**
 * What survives, and why — kept here as a list rather than a comment because the reason is
 * the whole design and somebody will eventually ask about each one.
 */
const RETAINED = Object.freeze([
  ['rate_submissions', 'A published aggregate. Removing figures moves a percentile for everybody; once the account is anonymised the figure identifies nobody.'],
  ['posts, post_replies', "Other people's threads and the counters on them. A reply vanishing leaves posts.reply_count permanently wrong and nothing recomputes it."],
  ['payments, invoices', 'Financial records under a statutory retention period. The right to erasure does not override a legal obligation to keep them.'],
  ['applications, application_events', "Part of an employer's hiring record, not solely the applicant's."],
  ['messages', "Half of a conversation somebody else took part in and can still legitimately read."],
  ['commission_ledger', 'Money a DIFFERENT person is owed. The ledger is the balance.'],
  ['site_reviews', 'Published content. Hidden and unpublished exist; delete deliberately does not.'],
  ['moderation_events', 'An append-only audit trail. "Who did this, when and why" must keep an answer.']
]);

/** The address written onto an erased row. `.invalid` is reserved by RFC 2606 and can never route. */
function erasedEmail(userId) {
  return `erased-${userId}@erased.invalid`;
}

const ERASED_NAME = 'Deleted account';

/**
 * Erase one account, in a single transaction.
 *
 * Returns what it did, so the route can show it and a test can assert it. Refuses an account
 * that is already erased rather than writing a second set of placeholders over the first.
 */
async function erase(userId, { reason = 'self-service' } = {}) {
  return withTransaction(async (conn) => {
    const [[user]] = await conn.query(
      'SELECT id, email, anonymised_at, is_superadmin FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );
    if (!user) {
      const err = new Error('That account no longer exists.');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (user.anonymised_at) {
      const err = new Error('That account has already been erased.');
      err.code = 'ALREADY_ERASED';
      throw err;
    }
    /*
     * A superadmin cannot erase itself. Not paternalism: this is the only account that can
     * administer the site, and an erased one cannot sign in — the site would be left with no
     * way in at all. Another superadmin can remove the flag first.
     */
    if (user.is_superadmin) {
      const err = new Error('Remove the superadmin role from this account before erasing it.');
      err.code = 'SUPERADMIN';
      throw err;
    }

    const purged = {};
    for (const table of PURGE) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, deliberately sequential
      const [res] = await conn.query(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
      if (res.affectedRows) purged[table] = res.affectedRows;
    }

    /*
     * The account row itself. Every identifying column is overwritten rather than left for a
     * later pass to forget: name, address, the demographic answers, and the signup IP —
     * which is personal data on its own and is the one field a reader would not think of.
     *
     * The password hash is replaced with a value no input can produce, so the row cannot be
     * authenticated against even if `is_active` were flipped back by mistake.
     */
    await conn.query(
      `UPDATE users SET
         email = ?, name = ?, password_hash = ?,
         gender = NULL, date_of_birth = NULL,
         signup_ip = NULL, signup_country = NULL,
         is_active = 0, email_verified = 0,
         is_consultant = 0, is_company = 0, is_recruiter = 0,
         last_login_at = NULL,
         anonymised_at = NOW()
       WHERE id = ?`,
      [erasedEmail(userId), ERASED_NAME, `erased:${Date.now()}`, userId]
    );

    return { userId, reason, purged, retained: RETAINED.map(([t]) => t) };
  });
}

/** Has this account been erased? Used by the guards that must never let one sign in. */
async function isErased(userId) {
  const [[row]] = await promisePool.query('SELECT anonymised_at FROM users WHERE id = ?', [userId]);
  return Boolean(row && row.anonymised_at);
}

module.exports = { erase, isErased, PURGE, RETAINED, erasedEmail, ERASED_NAME };
