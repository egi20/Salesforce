'use strict';

const { promisePool } = require('../config/database');
const { countryName } = require('../utils/geo');

/**
 * The program's participants and their stories (migration 042), read for /tax-optimization.
 *
 * Both reads are for a public page and both are allowed to fail: the page renders without a
 * story section or a participant count rather than not at all, the same way search shows a
 * missing section instead of a failed page.
 */

/**
 * "Arta Krasniqi" -> "Arta K." The full name is never published: a first name and an initial
 * is enough for a reader to believe a person said it, and not enough to look them up.
 */
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const initial = parts.length > 1 ? ` ${parts[parts.length - 1].charAt(0).toUpperCase()}.` : '';
  return `${parts[0]}${initial}`;
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.map((p) => p.charAt(0).toUpperCase()).slice(0, 2).join('') || '?';
}

/**
 * Shape a stored row for the page. The differences are the stored after-net minus the stored
 * before-net — a subtraction of two figures the person agreed to publish, nothing estimated.
 */
function present(row, monthsPerYear = 12) {
  const monthly = Number(row.net_after_minor) - Number(row.net_before_minor);
  return {
    id: row.id,
    name: shortName(row.name),
    initials: initialsOf(row.name),
    role: row.role,
    country: countryName(row.country_code) || row.country_code,
    currency: row.currency,
    before: { grossMinor: Number(row.gross_before_minor), netMinor: Number(row.net_before_minor) },
    after: { grossMinor: Number(row.gross_after_minor), netMinor: Number(row.net_after_minor) },
    monthlyMinor: monthly,
    yearlyMinor: monthly * monthsPerYear,
    quote: row.quote
  };
}

/**
 * THE ONE CLAUSE deciding which stories are public. Consent given and not withdrawn,
 * published, not hidden, and the account not erased — every condition, every time.
 */
const LIVE_STORY = [
  's.consent_given_at IS NOT NULL',
  's.consent_withdrawn_at IS NULL',
  's.published_at IS NOT NULL',
  's.hidden_at IS NULL',
  'u.anonymised_at IS NULL'
].join(' AND ');

class TaxProgram {
  static async liveStories({ limit = 12, monthsPerYear = 12 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT s.id, s.role, s.country_code, s.currency, s.gross_before_minor, s.net_before_minor,
              s.gross_after_minor, s.net_after_minor, s.quote, u.name
         FROM tax_program_stories s
         JOIN users u ON u.id = s.user_id
        WHERE ${LIVE_STORY}
        ORDER BY s.published_at DESC, s.id DESC
        LIMIT ?`,
      [limit]
    );
    return rows.map((r) => present(r, monthsPerYear));
  }

  /**
   * The countries most consultants on the Hub live in, most first — the top of the country
   * select. Measured rather than chosen, so the list follows the people who are here.
   */
  static async topConsultantCountries(limit = 6) {
    const [rows] = await promisePool.query(
      `SELECT cp.country, COUNT(*) AS n
         FROM consultant_profiles cp
         JOIN users u ON u.id = cp.user_id
        WHERE cp.country IS NOT NULL AND u.anonymised_at IS NULL
        GROUP BY cp.country
        ORDER BY n DESC, cp.country
        LIMIT ?`,
      [limit]
    );
    return rows.map((r) => r.country);
  }

  /** People in the program today: started, not ended. Distinct accounts, not rows. */
  static async activeCount() {
    const [[row]] = await promisePool.query(
      `SELECT COUNT(DISTINCT user_id) AS n
         FROM tax_program_participants
        WHERE started_on <= CURRENT_DATE() AND (ended_on IS NULL OR ended_on > CURRENT_DATE())`
    );
    return Number(row.n) || 0;
  }
}

TaxProgram.shortName = shortName;
TaxProgram.initialsOf = initialsOf;
TaxProgram.present = present;
TaxProgram.LIVE_STORY = LIVE_STORY;

module.exports = TaxProgram;
