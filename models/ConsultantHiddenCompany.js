'use strict';

const { promisePool } = require('../config/database');

/**
 * "Hide my profile from these companies."
 *
 * For the consultant looking for their next contract while still in their current one. A
 * public profile is how they get found; their present employer seeing it is the reason a lot
 * of people never publish one.
 *
 * WHAT IT CAN AND CANNOT DO is the whole design, because a privacy feature described as
 * stronger than it is, is worse than no feature:
 *
 * - A REGISTERED company, blocked by account id: enforced. Signed in and browsing, they do
 *   not see the profile in any list.
 * - A NAMED employer with no account here: matched against a registered company's profile
 *   name. It bites only if that employer signs up under a matching name — which is worth
 *   keeping, because naming your employer before they register is the common case and the
 *   block then applies on its own.
 * - A SIGNED-OUT visitor: nothing can be done. The directory is public and no filter can ask
 *   who an anonymous browser works for. The page says so, and points at the one switch that
 *   does answer that requirement — making the profile non-public.
 *
 * The exclusion itself lives in `ConsultantProfile.buildFilter`, not here and not in a query.
 * The reference implementation put its equivalent inline in one query out of the fourteen
 * that read `consultant_profiles`: the browse list honoured the block and nothing else did.
 * That is the one-builder rule's reason for existing, in its most expensive form.
 */

/** A generous cap. Not a policy — a bound, so one account cannot make the subquery expensive. */
const MAX_BLOCKS = 50;

const LIMITS = Object.freeze({ companyName: 200 });

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

/**
 * The form the unique index and the match both use. Lower-cased, punctuation-insensitive at
 * the edges and with runs of whitespace collapsed, so "Acme  Ltd." and "acme ltd" are ONE
 * block rather than two that each half-work.
 */
function nameKey(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,]+$/, '')
    .toLowerCase()
    .slice(0, LIMITS.companyName);
}

/** A whole number from a form field, or NaN. Never `parseInt` — see config/challenges.js. */
function intFrom(value) {
  if (Number.isInteger(value)) return value;
  const raw = String(value ?? '').trim();
  return /^\d+$/.test(raw) ? Number(raw) : NaN;
}

class ConsultantHiddenCompany {
  static MAX_BLOCKS = MAX_BLOCKS;

  static nameKey = nameKey;

  /** What the consultant sees on their own settings page. */
  static async listFor(consultantUserId) {
    const [rows] = await promisePool.query(
      `SELECT h.id, h.company_user_id, h.company_name, h.created_at,
              cp.company_name AS registered_name
         FROM consultant_hidden_companies h
         LEFT JOIN company_profiles cp ON cp.user_id = h.company_user_id
        WHERE h.consultant_user_id = ?
        ORDER BY h.created_at DESC`,
      [consultantUserId]
    );

    return rows.map((r) => ({
      id: r.id,
      isRegistered: r.company_user_id != null,
      // A registered company that later renames itself is shown under its CURRENT name: the
      // block follows the account, and showing the old name would make the consultant think
      // they had blocked somebody else.
      name: r.registered_name || r.company_name || 'That company',
      createdAt: r.created_at
    }));
  }

  /**
   * Block a registered company by account id, or an employer by name.
   *
   * Idempotent: adding the same block twice is a duplicate-key no-op, not a second row the
   * consultant then has to remove twice.
   */
  static async add(consultantUserId, { companyUserId = null, companyName = null } = {}) {
    const [[{ n }]] = await promisePool.query(
      'SELECT COUNT(*) AS n FROM consultant_hidden_companies WHERE consultant_user_id = ?',
      [consultantUserId]
    );
    if (n >= MAX_BLOCKS) fail('TOO_MANY', `You can hide from at most ${MAX_BLOCKS} companies.`);

    const id = intFrom(companyUserId);
    if (Number.isInteger(id)) {
      if (id === consultantUserId) fail('SELF', 'That is your own account.');

      // The account must exist AND be a company. Blocking an arbitrary user id would let
      // somebody probe which ids exist by watching which blocks are accepted.
      const [[company]] = await promisePool.query(
        'SELECT id FROM users WHERE id = ? AND is_company = 1 AND is_active = 1',
        [id]
      );
      if (!company) fail('NOT_FOUND', 'That company is not on the Hub. Add it by name instead.');

      await promisePool.query(
        `INSERT INTO consultant_hidden_companies (consultant_user_id, company_user_id)
         VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id`,
        [consultantUserId, id]
      );
      return { kind: 'registered' };
    }

    const display = String(companyName ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.companyName);
    const key = nameKey(display);
    // Two characters is the same floor `services/search.js` uses: a one-letter block would
    // match nothing useful and is a typo far more often than an intention.
    if (key.length < 2) fail('NAME_REQUIRED', 'Type the company name, or pick one from the list.');

    await promisePool.query(
      `INSERT INTO consultant_hidden_companies (consultant_user_id, company_name, company_name_key)
       VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE company_name = VALUES(company_name)`,
      [consultantUserId, display, key]
    );
    return { kind: 'named' };
  }

  /** Scoped to the owner, so an id from somebody else's list removes nothing. */
  static async remove(consultantUserId, id) {
    const [res] = await promisePool.query(
      'DELETE FROM consultant_hidden_companies WHERE consultant_user_id = ? AND id = ?',
      [consultantUserId, intFrom(id) || 0]
    );
    return res.affectedRows === 1;
  }

  /**
   * Does this consultant's block apply to this viewer?
   *
   * THE SECOND EXPRESSION OF ONE RULE, and the only one there will be. A list goes through
   * `ConsultantProfile.buildFilter`, which is SQL; a single profile page is a row that was
   * already fetched, which cannot use a WHERE clause. So the rule is stated twice — and
   * `tests/unit/hiddenCompanies.test.js` runs both against the same data and asserts they
   * give the same answer, because two expressions of one rule that nobody compares are two
   * rules waiting to drift.
   *
   * Without this, a company blocked from the directory could still open the profile by its
   * URL, which is where a link from a colleague or a search engine lands them anyway.
   */
  static async blocks(consultantUserId, viewer) {
    if (!viewer || !viewer.companyUserId) return false;
    const [[row]] = await promisePool.query(
      `SELECT 1 AS hit FROM consultant_hidden_companies
        WHERE consultant_user_id = ?
          AND ( company_user_id = ?
             OR (company_name_key IS NOT NULL AND company_name_key = ?) )
        LIMIT 1`,
      [consultantUserId, viewer.companyUserId, viewer.companyNameKey || '\u0000']
    );
    return Boolean(row);
  }

  /**
   * The viewer's identity, as the filter needs it: an account id and the company's own name.
   *
   * Resolved ONCE per request and handed to `buildFilter`, rather than the builder reaching
   * into the database — that keeps the builder a pure function over its filters, which is
   * what makes it testable and what stops a list and its count disagreeing.
   */
  static async viewerFor(user) {
    if (!user || !user.isCompany) return null;
    const [[profile]] = await promisePool.query(
      'SELECT company_name FROM company_profiles WHERE user_id = ? LIMIT 1',
      [user.id]
    );
    return { companyUserId: user.id, companyNameKey: nameKey(profile && profile.company_name) };
  }
}

module.exports = ConsultantHiddenCompany;
