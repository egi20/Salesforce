'use strict';

const { promisePool } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');
const { decimalToScaled, isoDate } = require('../utils/decimalInput');
const { LIMITS, isCostCategory, isCurrency, isInterval, perYear } = require('../config/finance');

/**
 * Costs — one table for a recurring subscription and a one-off purchase alike. They differ
 * by whether `recur_every` is set, not by what they store; two near-identical tables would
 * mean two of every query and a P&L built on a UNION.
 *
 * THE PART THAT IS EASY TO GET WRONG: a recurring cost is NOT a row per month. It is one
 * row with a window, and what it contributes to a given month is DERIVED. Storing twelve
 * rows for one subscription means twelve rows to correct when the price changes, and an
 * annual total that quietly disagrees with the contract.
 */

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function normalise(input = {}) {
  const description = text(input.description, LIMITS.description);
  if (description.length < 2) fail('DESCRIPTION_REQUIRED', 'Say what the cost is for.');

  if (!isCostCategory(input.category)) fail('BAD_CATEGORY', 'Choose a category.');

  const currency = String(input.currency || 'EUR').toUpperCase();
  if (!isCurrency(currency)) fail('BAD_CURRENCY', 'That is not a currency this app tracks.');

  const amountMinor = decimalToScaled(input.amount, 2, { allowNegative: false });
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > LIMITS.amountMinor) {
    fail('BAD_AMOUNT', 'The amount is not a number we can record.');
  }

  const startsOn = text(input.starts_on, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) fail('BAD_DATE', 'When did this cost start?');

  const endsOn = text(input.ends_on, 10) || null;
  if (endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) fail('BAD_DATE', 'That end date is not a date.');
  if (endsOn && endsOn < startsOn) fail('BAD_DATE', 'It cannot end before it starts.');

  const recurEvery = input.recur_every && input.recur_every !== 'once' ? String(input.recur_every) : null;
  if (recurEvery && !isInterval(recurEvery)) fail('BAD_INTERVAL', 'That is not an interval this app understands.');

  return {
    description,
    category: input.category,
    currency,
    amount_minor: amountMinor,
    recur_every: recurEvery,
    starts_on: startsOn,
    ends_on: endsOn,
    vendor: text(input.vendor, LIMITS.clientName) || null,
    notes: text(input.notes, LIMITS.note) || null
  };
}

/**
 * What one cost contributes to a given month. Pure, so the P&L is testable without a
 * database and the rule is in one place.
 *
 * `month` is 'YYYY-MM'. A cost outside its window contributes nothing. A yearly cost lands
 * on its ANNIVERSARY MONTH rather than being spread — that is what the bank statement
 * shows, and a P&L that disagrees with the bank is a P&L nobody trusts. A quarterly one
 * lands every third month from its start.
 */
function monthlyShare(cost, month) {
  const first = `${month}-01`;
  // The last day of the month, without date arithmetic: compare against the next month's
  // first day instead.
  const [y, m] = month.split('-').map(Number);
  const nextFirst = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

  /*
   * Through `isoDate`, because mysql2 hands a DATE back as a JS Date and
   * `String(date).slice(0, 10)` is 'Thu Jan 01'. Compared as a string against '2026-02-01'
   * that sorts AFTER it, so every recurring cost fell outside every window and the profit
   * and loss showed zero costs beside real invoices — with nothing in the log. The unit
   * tests were green throughout, because a unit test passes strings.
   */
  const starts = isoDate(cost.starts_on);
  const ends = isoDate(cost.ends_on);
  if (!starts) return 0;

  if (starts >= nextFirst) return 0;
  if (ends && ends < first) return 0;

  if (!cost.recur_every) {
    // A one-off lands in the month it happened.
    return starts >= first && starts < nextFirst ? cost.amount_minor : 0;
  }

  const startMonths = Number(starts.slice(0, 4)) * 12 + Number(starts.slice(5, 7));
  const thisMonths = y * 12 + m;
  const elapsed = thisMonths - startMonths;
  if (elapsed < 0) return 0;

  const every = 12 / perYear(cost.recur_every);
  return elapsed % every === 0 ? cost.amount_minor : 0;
}

class FinanceCost {
  static normalise = normalise;

  static monthlyShare = monthlyShare;

  static toMinor = (value) => decimalToScaled(value, 2, { allowNegative: false });

  static buildFilter(filters = {}) {
    const clauses = [];
    const params = [];

    if (filters.category && isCostCategory(filters.category)) {
      clauses.push('c.category = ?');
      params.push(filters.category);
    }
    if (filters.recurring === 'yes') clauses.push('c.recur_every IS NOT NULL');
    if (filters.recurring === 'no') clauses.push('c.recur_every IS NULL');
    if (filters.active) {
      clauses.push('(c.ends_on IS NULL OR c.ends_on >= CURDATE())');
    }
    if (filters.q && String(filters.q).trim()) {
      const like = containsPattern(filters.q);
      clauses.push('(c.description LIKE ? OR c.vendor LIKE ?)');
      params.push(like, like);
    }
    return { clause: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
  }

  static async create(input, { actorUserId = null } = {}) {
    const f = normalise(input);
    const [result] = await promisePool.query(
      `INSERT INTO finance_costs
         (description, category, currency, amount_minor, recur_every, starts_on, ends_on, vendor, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.description, f.category, f.currency, f.amount_minor, f.recur_every, f.starts_on, f.ends_on, f.vendor, f.notes, actorUserId]
    );
    return { id: result.insertId };
  }

  static async update(id, input) {
    const f = normalise(input);
    const [result] = await promisePool.query(
      `UPDATE finance_costs
          SET description = ?, category = ?, currency = ?, amount_minor = ?, recur_every = ?,
              starts_on = ?, ends_on = ?, vendor = ?, notes = ?
        WHERE id = ?`,
      [f.description, f.category, f.currency, f.amount_minor, f.recur_every, f.starts_on, f.ends_on, f.vendor, f.notes, id]
    );
    return result.affectedRows === 1;
  }

  /**
   * Stop a recurring cost rather than deleting it.
   *
   * Deleting a subscription you paid for eleven months removes eleven months of real
   * expense from every past P&L. Ending it keeps the history and stops the future.
   */
  static async end(id, endsOn) {
    const date = text(endsOn, 10) || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('BAD_DATE', 'That is not a date.');
    const [result] = await promisePool.query('UPDATE finance_costs SET ends_on = ? WHERE id = ?', [date, id]);
    return result.affectedRows === 1;
  }

  static async remove(id) {
    // Allowed, but only for a cost that never applied to a closed month — a mistyped row
    // entered today. Anything older is ended, not erased.
    const [result] = await promisePool.query(
      "DELETE FROM finance_costs WHERE id = ? AND starts_on >= DATE_FORMAT(CURDATE(), '%Y-%m-01')",
      [id]
    );
    if (result.affectedRows !== 1) {
      fail('TOO_OLD', 'This cost already applies to a past month. End it instead, so the history stays right.');
    }
    return true;
  }

  static async findById(id) {
    const [[row]] = await promisePool.query('SELECT * FROM finance_costs WHERE id = ?', [id]);
    return row || null;
  }

  static async list(filters = {}, { limit = 200, offset = 0 } = {}) {
    const { clause, params } = FinanceCost.buildFilter(filters);
    const [rows] = await promisePool.query(
      `SELECT c.* FROM finance_costs c WHERE ${clause}
        ORDER BY c.recur_every IS NULL, c.starts_on DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM finance_costs c WHERE ${clause}`,
      params
    );
    return { rows, total };
  }

  /** Every cost that could touch a window, for the P&L to apportion in JavaScript. */
  static async forWindow(fromMonth, toMonth) {
    const [rows] = await promisePool.query(
      `SELECT * FROM finance_costs
        WHERE starts_on <= LAST_DAY(CONCAT(?, '-01'))
          AND (ends_on IS NULL OR ends_on >= CONCAT(?, '-01'))`,
      [toMonth, fromMonth]
    );
    return rows;
  }
}

module.exports = FinanceCost;
