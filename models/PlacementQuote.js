'use strict';

const crypto = require('crypto');

const { promisePool, withTransaction } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');
const { decimalToScaled } = require('../utils/decimalInput');
const {
  LIMITS,
  canTransition,
  feeMinor,
  isPlacementKind,
  isPlacementStatus,
  rateBpsFor
} = require('../config/placements');
const { CURRENCIES } = require('../config/finance');

/**
 * An agreed placement, and the fee due on it.
 *
 * THE ONE THING THE REFERENCE GOT RIGHT, kept: the contract value is agreed by a person and
 * stored server-side, and the fee is derived from that stored row. Nothing the browser sends
 * reaches the amount. Their own audit calls that the C3 price-tampering finding, and it is
 * the same structural answer `config/payments.js` gives every product here — a route asks,
 * a route never decides.
 *
 * Everything else is corrected in `scripts/migrations/026_placements.sql` and
 * `config/placements.js`, where the reasons are written next to the columns and the
 * arithmetic they replace.
 *
 * The rate is SNAPSHOT on the row at agreement. Theirs reads the live pricing config at
 * checkout, so renegotiating the standard rate reprices every placement already agreed with
 * a client — the same fault `referral_attributions` avoids by snapshotting, and the same one
 * a stored quote avoids by keeping its catalogue version.
 */

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function intFrom(value) {
  if (Number.isInteger(value)) return value;
  const raw = String(value ?? '').trim();
  return /^\d+$/.test(raw) ? Number(raw) : NaN;
}

/**
 * `PL-` plus 24 hex characters from a CSPRNG.
 *
 * Opaque because it is what a company is given to pay against: a sequential id in that
 * position is an invitation to try the neighbouring numbers and see whose placement comes
 * back. The reference does the same thing and it is right.
 */
function newReference() {
  return `PL-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
}

class PlacementQuote {
  static newReference = newReference;

  static buildFilter(filters = {}) {
    const clauses = [];
    const params = [];

    if (filters.status && isPlacementStatus(filters.status)) {
      clauses.push('p.status = ?');
      params.push(filters.status);
    }
    if (filters.company_user_id) {
      clauses.push('p.company_user_id = ?');
      params.push(intFrom(filters.company_user_id) || 0);
    }
    if (filters.q && String(filters.q).trim()) {
      const like = containsPattern(filters.q);
      clauses.push('(p.consultant_name LIKE ? OR p.job_title LIKE ? OR p.reference LIKE ?)');
      params.push(like, like, like);
    }
    return { clause: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
  }

  /**
   * Agree a placement. Only an administrator reaches this, and the figure they type is the
   * figure the two parties settled on — which is why it is stored rather than recomputed.
   */
  static async agree(input = {}, { actorUserId = null } = {}) {
    const companyUserId = intFrom(input.company_user_id);
    if (!Number.isInteger(companyUserId)) fail('NO_COMPANY', 'Choose the company that owes the fee.');

    const [[company]] = await promisePool.query(
      'SELECT id FROM users WHERE id = ? AND is_company = 1 AND is_active = 1',
      [companyUserId]
    );
    if (!company) fail('NO_COMPANY', 'That company account does not exist or is not active.');

    const consultantName = text(input.consultant_name, LIMITS.name);
    if (consultantName.length < 2) fail('NO_CONSULTANT', 'Name the consultant who was placed.');

    const jobTitle = text(input.job_title, LIMITS.name);
    if (jobTitle.length < 2) fail('NO_TITLE', 'What was the role?');

    if (!isPlacementKind(input.placement_kind)) fail('BAD_KIND', 'Choose the kind of placement.');
    // Never `|| 1500`. An unrecognised kind was already refused above; this cannot be null,
    // and if it ever is, the refusal below is louder than a default nobody chose.
    const rateBps = rateBpsFor(input.placement_kind);
    if (!Number.isInteger(rateBps)) fail('BAD_KIND', 'That placement kind has no rate.');

    const currency = String(input.currency || 'EUR').toUpperCase();
    if (!CURRENCIES.includes(currency)) fail('BAD_CURRENCY', 'That is not a currency this app handles.');

    // Through the one decimal parser, so a blank or absent field is refused by name rather
    // than read as zero — see utils/decimalInput.js.
    const contractValueMinor = decimalToScaled(input.contract_value, 2, { allowNegative: false });
    if (!Number.isInteger(contractValueMinor)) fail('BAD_VALUE', 'The contract value is not a number we can use.');
    if (contractValueMinor < LIMITS.minContractMinor) {
      fail('BAD_VALUE', `The contract value must be at least ${LIMITS.minContractMinor / 100} ${currency}.`);
    }
    if (contractValueMinor > LIMITS.maxContractMinor) fail('BAD_VALUE', 'That contract value looks like a typo.');

    const fee = feeMinor(contractValueMinor, rateBps);
    if (!Number.isInteger(fee)) fail('BAD_VALUE', 'The fee could not be computed from those figures.');

    const [result] = await promisePool.query(
      `INSERT INTO placement_quotes
         (reference, company_user_id, consultant_name, consultant_user_id, job_title,
          placement_kind, contract_value_minor, currency, rate_bps, fee_minor, note, agreed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newReference(),
        companyUserId,
        consultantName,
        Number.isInteger(intFrom(input.consultant_user_id)) ? intFrom(input.consultant_user_id) : null,
        jobTitle,
        input.placement_kind,
        contractValueMinor,
        currency,
        rateBps,
        fee,
        text(input.note, LIMITS.note) || null,
        actorUserId
      ]
    );
    return { id: result.insertId };
  }

  static async findById(id) {
    const [[row]] = await promisePool.query(
      `SELECT p.*, u.name AS company_name, cp.company_name AS company_profile_name
         FROM placement_quotes p
         JOIN users u ON u.id = p.company_user_id
         LEFT JOIN company_profiles cp ON cp.user_id = p.company_user_id
        WHERE p.id = ? LIMIT 1`,
      [id]
    );
    return row || null;
  }

  static async list(filters = {}, { limit = 50, offset = 0 } = {}) {
    const { clause, params } = PlacementQuote.buildFilter(filters);
    const [rows] = await promisePool.query(
      `SELECT p.*, u.name AS company_name, cp.company_name AS company_profile_name
         FROM placement_quotes p
         JOIN users u ON u.id = p.company_user_id
         LEFT JOIN company_profiles cp ON cp.user_id = p.company_user_id
        WHERE ${clause}
        ORDER BY FIELD(p.status, 'agreed', 'paid', 'cancelled'), p.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM placement_quotes p WHERE ${clause}`,
      params
    );
    return { rows, total };
  }

  /**
   * Cancel an agreed placement. There is no delete: a cancelled one is the record that a fee
   * was agreed and did not complete, which is the row anybody asks about later.
   */
  static async cancel(id, reason, { actorUserId = null } = {}) {
    const why = text(reason, LIMITS.reason);
    if (why.length < 3) fail('REASON_REQUIRED', 'Say why it is being cancelled.');

    return withTransaction(async (conn) => {
      const [[quote]] = await conn.query('SELECT id, status FROM placement_quotes WHERE id = ? FOR UPDATE', [id]);
      if (!quote) fail('NOT_FOUND', 'That placement no longer exists.');
      if (!canTransition(quote.status, 'cancelled')) {
        fail('BAD_TRANSITION', `A ${quote.status} placement cannot be cancelled.`);
      }
      await conn.query(
        'UPDATE placement_quotes SET status = ?, cancelled_at = NOW(), cancel_reason = ?, agreed_by = COALESCE(agreed_by, ?) WHERE id = ?',
        ['cancelled', why, actorUserId, id]
      );
      return true;
    });
  }

  /**
   * Mark it paid. A CLAIM, not a setter — a conditional UPDATE that reports whether THIS
   * call moved the row, exactly as `Payment.markPaid` does.
   *
   * It is called from the fulfilment handler INSIDE the transaction that writes the fee row,
   * so the status and the fee cannot disagree. It decides nothing on its own: whether
   * fulfilment happens is decided by the unique key on `placement_fees.placement_quote_id`,
   * never by reading this status first. That distinction is the reference's worst payment
   * bug, and it is worth keeping the two apart here even though the same person wrote both.
   */
  static async claimPaid(conn, id) {
    const [result] = await conn.query(
      "UPDATE placement_quotes SET status = 'paid' WHERE id = ? AND status = 'agreed'",
      [id]
    );
    return result.affectedRows === 1;
  }
}

module.exports = PlacementQuote;
