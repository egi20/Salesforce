'use strict';

const { promisePool, withTransaction } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');
// One parser for every typed decimal in the finance area — see utils/decimalInput.js on why
// there is exactly one, and on why a blank field is refused rather than read as zero.
const { decimalToScaled } = require('../utils/decimalInput');
const {
  LIMITS,
  MAX_VAT_BPS,
  canTransition,
  invoiceLabel,
  invoiceTotals,
  isCurrency,
  isImmutable,
  isInvoiceStatus,
  lineTotals,
  reconciliationProblems
} = require('../config/finance');

/**
 * Invoices.
 *
 * Two rules, and both exist because the reference implementation breaks them:
 *
 * 1. THE NUMBER IS ALLOCATED UNDER A LOCK. `getNextSeq` there is
 *    `SELECT MAX(invoice_seq) + 1` outside any transaction, read and then inserted.
 *    Here the year's counter row is locked FOR UPDATE inside the transaction that writes
 *    the invoice, so two concurrent issues serialise on it — and `UNIQUE (year, seq)`
 *    sits behind that so a future bug fails loudly rather than duplicating quietly.
 *
 * 2. AN ISSUED INVOICE IS NEVER DELETED OR EDITED. `CompanyInvoice.remove(id)` there is a
 *    hard DELETE at any status, reachable from a list button. Deleting an issued invoice
 *    leaves a gap in the sequence, which is exactly what an auditor looks for. Here only a
 *    draft can be changed or discarded; anything issued can only be cancelled, and the
 *    number stays used.
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

/** A whole number from a form field, or NaN. Never `parseInt` — see config/challenges.js. */
function intFrom(value) {
  if (Number.isInteger(value)) return value;
  const raw = String(value ?? '').trim();
  return /^-?\d+$/.test(raw) ? Number(raw) : NaN;
}

/**
 * Validate the lines somebody submitted. Pure, so the arithmetic is testable without a
 * database and cannot differ between the create path and the edit path.
 */
function normaliseLines(submitted) {
  const rows = Array.isArray(submitted) ? submitted : submitted && typeof submitted === 'object' ? Object.values(submitted) : [];

  const lines = [];
  for (const row of rows) {
    const description = text(row && row.description, LIMITS.description);
    // A row with no description is an empty row the form rendered, not a line.
    if (!description) continue;

    const quantityMilli = decimalToScaled(row.quantity, 3);
    const unitPriceMinor = decimalToScaled(row.unit_price, 2);
    const vatBps = decimalToScaled(row.vat_percent, 2);

    if (!Number.isInteger(quantityMilli) || quantityMilli <= 0 || quantityMilli > LIMITS.quantityMilli) {
      fail('LINE_QUANTITY', `"${description}": the quantity is not a number we can invoice.`);
    }
    if (!Number.isInteger(unitPriceMinor) || Math.abs(unitPriceMinor) > LIMITS.amountMinor) {
      fail('LINE_PRICE', `"${description}": the unit price is not a number we can invoice.`);
    }
    if (!Number.isInteger(vatBps) || vatBps < 0 || vatBps > MAX_VAT_BPS) {
      fail('LINE_VAT', `"${description}": the VAT rate must be between 0 and 100.`);
    }

    const totals = lineTotals({ quantityMilli, unitPriceMinor, vatBps });
    lines.push({
      description,
      unit: text(row.unit, 32) || null,
      quantityMilli,
      unitPriceMinor,
      vatBps,
      netMinor: totals.netMinor,
      vatMinor: totals.vatMinor
    });

    if (lines.length > LIMITS.lines) fail('TOO_MANY_LINES', `An invoice may have at most ${LIMITS.lines} lines.`);
  }

  if (!lines.length) fail('NO_LINES', 'An invoice needs at least one line with a description.');
  return lines;
}

class FinanceInvoice {
  static decimalToScaled = decimalToScaled;

  static normaliseLines = normaliseLines;

  /** THE ONE FILTER BUILDER for invoices — list, count, export and the P&L all use it. */
  static buildFilter(filters = {}) {
    const clauses = [];
    const params = [];

    if (filters.status && isInvoiceStatus(filters.status)) {
      clauses.push('i.status = ?');
      params.push(filters.status);
    }
    if (filters.client_id) {
      clauses.push('i.client_id = ?');
      params.push(intFrom(filters.client_id) || 0);
    }
    if (filters.year) {
      clauses.push('i.invoice_year = ?');
      params.push(intFrom(filters.year) || 0);
    }
    if (filters.from) {
      clauses.push('i.issue_date >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('i.issue_date <= ?');
      params.push(filters.to);
    }
    if (filters.overdue) {
      clauses.push("i.status = 'issued'", 'i.due_date IS NOT NULL', 'i.due_date < CURDATE()');
    }
    if (filters.q && String(filters.q).trim()) {
      const like = containsPattern(filters.q);
      clauses.push('(c.name LIKE ? OR i.reference LIKE ?)');
      params.push(like, like);
    }

    return { clause: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
  }

  /** Create a draft. No number is allocated: a draft holds none, which is why discarding one is free. */
  static async createDraft({ clientId, currency = 'EUR', reference = null, notes = null, dueDate = null, lines, actorUserId = null }) {
    if (!isCurrency(currency)) fail('BAD_CURRENCY', 'That is not a currency this app will invoice in.');
    const normalised = normaliseLines(lines);
    const totals = invoiceTotals(normalised);

    return withTransaction(async (conn) => {
      const [[client]] = await conn.query('SELECT id FROM finance_clients WHERE id = ?', [intFrom(clientId) || 0]);
      if (!client) fail('NO_CLIENT', 'Choose who this invoice is for.');

      const [result] = await conn.query(
        `INSERT INTO finance_invoices
           (client_id, currency, net_minor, vat_minor, gross_minor, due_date, reference, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          client.id, currency, totals.netMinor, totals.vatMinor, totals.grossMinor,
          dueDate || null, text(reference, LIMITS.reference) || null,
          block(notes, LIMITS.note) || null, actorUserId
        ]
      );

      await FinanceInvoice.writeLines(conn, result.insertId, normalised);
      return { id: result.insertId };
    });
  }

  static async writeLines(conn, invoiceId, lines) {
    await conn.query('DELETE FROM finance_invoice_lines WHERE invoice_id = ?', [invoiceId]);
    let position = 0;
    for (const line of lines) {
      // eslint-disable-next-line no-await-in-loop
      await conn.query(
        `INSERT INTO finance_invoice_lines
           (invoice_id, position, description, quantity_milli, unit, unit_price_minor, vat_bps, net_minor, vat_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId, position, line.description, line.quantityMilli, line.unit,
          line.unitPriceMinor, line.vatBps, line.netMinor, line.vatMinor
        ]
      );
      position += 1;
    }
  }

  /** Edit a DRAFT. Refused for anything else — see the note at the top of this file. */
  static async updateDraft(id, { clientId, currency, reference, notes, dueDate, lines }) {
    const normalised = normaliseLines(lines);
    const totals = invoiceTotals(normalised);

    return withTransaction(async (conn) => {
      const [[invoice]] = await conn.query('SELECT id, status FROM finance_invoices WHERE id = ? FOR UPDATE', [id]);
      if (!invoice) fail('NOT_FOUND', 'That invoice no longer exists.');
      if (isImmutable(invoice.status)) {
        fail('IMMUTABLE', `This invoice is ${invoice.status} and cannot be changed. Cancel it and issue a new one.`);
      }
      if (!isCurrency(currency)) fail('BAD_CURRENCY', 'That is not a currency this app will invoice in.');

      await conn.query(
        `UPDATE finance_invoices
            SET client_id = ?, currency = ?, net_minor = ?, vat_minor = ?, gross_minor = ?,
                due_date = ?, reference = ?, notes = ?
          WHERE id = ?`,
        [
          intFrom(clientId) || 0, currency, totals.netMinor, totals.vatMinor, totals.grossMinor,
          dueDate || null, text(reference, LIMITS.reference) || null, block(notes, LIMITS.note) || null, id
        ]
      );
      await FinanceInvoice.writeLines(conn, id, normalised);
      return { id };
    });
  }

  /**
   * Issue a draft: allocate the number and freeze the customer's details.
   *
   * The counter row is locked FOR UPDATE before it is read, so a second issue waits rather
   * than reading the same value. The client's name, address and tax id are COPIED onto the
   * invoice here — an invoice is a statement made on a date, and a customer moving office
   * next year must not rewrite one already sent and filed.
   */
  static async issue(id, { issueDate = null, actorUserId = null } = {}) {
    return withTransaction(async (conn) => {
      const [[invoice]] = await conn.query('SELECT * FROM finance_invoices WHERE id = ? FOR UPDATE', [id]);
      if (!invoice) fail('NOT_FOUND', 'That invoice no longer exists.');
      if (invoice.status !== 'draft') fail('NOT_A_DRAFT', `This invoice is already ${invoice.status}.`);

      const [lines] = await conn.query('SELECT * FROM finance_invoice_lines WHERE invoice_id = ?', [id]);
      if (!lines.length) fail('NO_LINES', 'An invoice needs at least one line before it can be issued.');

      const [[client]] = await conn.query('SELECT * FROM finance_clients WHERE id = ?', [invoice.client_id]);
      if (!client) fail('NO_CLIENT', 'The client on this invoice no longer exists.');

      const date = issueDate || new Date().toISOString().slice(0, 10);
      const year = Number(date.slice(0, 4));

      // Lock the year's counter. `INSERT ... ON DUPLICATE KEY UPDATE` creates it on the
      // first invoice of a year without a separate branch, and the SELECT that follows is
      // inside the same transaction, so the value cannot move underneath us.
      await conn.query(
        'INSERT INTO finance_invoice_counters (invoice_year, last_seq) VALUES (?, 0) ON DUPLICATE KEY UPDATE invoice_year = invoice_year',
        [year]
      );
      const [[counter]] = await conn.query(
        'SELECT last_seq FROM finance_invoice_counters WHERE invoice_year = ? FOR UPDATE',
        [year]
      );
      const seq = counter.last_seq + 1;
      await conn.query('UPDATE finance_invoice_counters SET last_seq = ? WHERE invoice_year = ?', [seq, year]);

      await conn.query(
        `UPDATE finance_invoices
            SET status = 'issued', invoice_year = ?, invoice_seq = ?, issue_date = ?,
                bill_to_name = ?, bill_to_address = ?, bill_to_tax_id = ?, bill_to_country = ?
          WHERE id = ?`,
        [year, seq, date, client.name, client.address, client.tax_id, client.country, id]
      );

      return { id, year, seq, label: invoiceLabel(year, seq), actorUserId };
    });
  }

  /**
   * Move an issued invoice along. Declared transitions only.
   *
   * Cancelling keeps the row and keeps the number used. There is no delete on this model
   * for anything that has been issued, and a test asserts it.
   */
  static async setStatus(id, to, { reason = null } = {}) {
    if (!isInvoiceStatus(to)) fail('BAD_STATUS', 'That is not a status an invoice can be in.');

    return withTransaction(async (conn) => {
      const [[invoice]] = await conn.query('SELECT id, status FROM finance_invoices WHERE id = ? FOR UPDATE', [id]);
      if (!invoice) fail('NOT_FOUND', 'That invoice no longer exists.');
      if (!canTransition(invoice.status, to)) {
        fail('BAD_TRANSITION', `An invoice cannot go from ${invoice.status} to ${to}.`);
      }
      if (to === 'cancelled' && !text(reason, LIMITS.description)) {
        fail('REASON_REQUIRED', 'Say why it is being cancelled. It stays on the record with its number.');
      }

      await conn.query(
        `UPDATE finance_invoices
            SET status = ?,
                paid_at = CASE WHEN ? = 'paid' THEN NOW() ELSE paid_at END,
                cancelled_at = CASE WHEN ? = 'cancelled' THEN NOW() ELSE cancelled_at END,
                cancel_reason = CASE WHEN ? = 'cancelled' THEN ? ELSE cancel_reason END
          WHERE id = ?`,
        [to, to, to, to, text(reason, LIMITS.description) || null, id]
      );
      return { id, from: invoice.status, to };
    });
  }

  /**
   * Discard a DRAFT. The only deletion in this module, and it is safe precisely because a
   * draft never held a number.
   */
  static async discardDraft(id) {
    const [result] = await promisePool.query("DELETE FROM finance_invoices WHERE id = ? AND status = 'draft'", [id]);
    if (result.affectedRows !== 1) {
      fail('NOT_A_DRAFT', 'Only a draft can be discarded. An issued invoice is cancelled, never removed.');
    }
    return true;
  }

  static async findById(id) {
    const [[invoice]] = await promisePool.query(
      `SELECT i.*, c.name AS client_name, c.email AS client_email
         FROM finance_invoices i JOIN finance_clients c ON c.id = i.client_id
        WHERE i.id = ?`,
      [id]
    );
    if (!invoice) return null;

    const [lines] = await promisePool.query(
      'SELECT * FROM finance_invoice_lines WHERE invoice_id = ? ORDER BY position ASC, id ASC',
      [id]
    );

    return {
      ...invoice,
      lines,
      label: invoice.invoice_seq ? invoiceLabel(invoice.invoice_year, invoice.invoice_seq) : null
    };
  }

  /** Re-checked before an invoice is shown or downloaded, as quotes re-check an estimate. */
  static problemsWith(invoice) {
    return reconciliationProblems({
      ...invoice,
      lines: (invoice.lines || []).map((l) => ({
        quantityMilli: l.quantity_milli,
        unitPriceMinor: l.unit_price_minor,
        vatBps: l.vat_bps
      }))
    });
  }

  static async list(filters = {}, { limit = 50, offset = 0 } = {}) {
    const { clause, params } = FinanceInvoice.buildFilter(filters);

    const [rows] = await promisePool.query(
      `SELECT i.*, c.name AS client_name
         FROM finance_invoices i JOIN finance_clients c ON c.id = i.client_id
        WHERE ${clause}
        ORDER BY COALESCE(i.issue_date, i.created_at) DESC, i.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM finance_invoices i JOIN finance_clients c ON c.id = i.client_id WHERE ${clause}`,
      params
    );

    return {
      rows: rows.map((r) => ({ ...r, label: r.invoice_seq ? invoiceLabel(r.invoice_year, r.invoice_seq) : null })),
      total
    };
  }

  /**
   * Revenue by month, per currency.
   *
   * CANCELLED INVOICES ARE EXCLUDED and drafts never counted — a draft is not revenue and a
   * cancelled invoice is revenue that did not happen. Grouped by the EXPRESSION, not by the
   * alias: `finance_invoices` has no column called `period` today, but `rate_submissions`
   * did and that is exactly how /admin/analytics broke.
   */
  static async revenueByMonth({ from, to } = {}) {
    /*
     * The window is passed IN, not derived from CURDATE() here. An earlier version took a
     * number of months and always anchored on today, so asking for last year's statement
     * returned this year's revenue rows — which then matched none of the requested months
     * and rendered as a year of zeros beside real costs. A report that answers a different
     * question from the one asked is worse than one that refuses.
     *
     * Half-open on the upper bound (`< the first of the month after`), so an invoice issued
     * on the last day of the window is inside it. `<= LAST_DAY(...)` would be right for a
     * DATE and wrong the day `issue_date` becomes a DATETIME.
     */
    const [rows] = await promisePool.query(
      `SELECT DATE_FORMAT(i.issue_date, '%Y-%m') AS period, i.currency,
              SUM(i.net_minor) AS net_minor, SUM(i.vat_minor) AS vat_minor,
              SUM(CASE WHEN i.status = 'paid' THEN i.net_minor ELSE 0 END) AS paid_net_minor,
              COUNT(*) AS invoices
         FROM finance_invoices i
        WHERE i.status IN ('issued', 'paid')
          AND i.issue_date >= CONCAT(?, '-01')
          AND i.issue_date < DATE_ADD(CONCAT(?, '-01'), INTERVAL 1 MONTH)
        GROUP BY DATE_FORMAT(i.issue_date, '%Y-%m'), i.currency
        ORDER BY DATE_FORMAT(i.issue_date, '%Y-%m') ASC`,
      [from, to]
    );
    return rows;
  }

  /** What is issued and unpaid, oldest first. */
  static async outstanding() {
    const [rows] = await promisePool.query(
      `SELECT i.id, i.invoice_year, i.invoice_seq, i.currency, i.gross_minor, i.issue_date, i.due_date,
              c.name AS client_name,
              (i.due_date IS NOT NULL AND i.due_date < CURDATE()) AS is_overdue
         FROM finance_invoices i JOIN finance_clients c ON c.id = i.client_id
        WHERE i.status = 'issued'
        ORDER BY COALESCE(i.due_date, i.issue_date) ASC
        LIMIT 200`
    );
    return rows.map((r) => ({ ...r, label: invoiceLabel(r.invoice_year, r.invoice_seq) }));
  }

  /**
   * The gaps in the sequence, if there are any.
   *
   * There should never be one: numbers are allocated under a lock and an issued invoice is
   * cancelled rather than deleted. This exists so that claim is CHECKABLE rather than
   * asserted — it is the first thing anybody auditing the books looks for, and a report
   * that says "none" is worth more than a comment saying it cannot happen.
   */
  static async sequenceGaps(year) {
    const [rows] = await promisePool.query(
      'SELECT invoice_seq FROM finance_invoices WHERE invoice_year = ? ORDER BY invoice_seq ASC',
      [year]
    );
    const used = rows.map((r) => r.invoice_seq);
    const gaps = [];
    for (let n = 1; n <= (used[used.length - 1] || 0); n += 1) {
      if (!used.includes(n)) gaps.push(n);
    }
    return { year, used: used.length, highest: used[used.length - 1] || 0, gaps };
  }

  static async years() {
    const [rows] = await promisePool.query(
      'SELECT DISTINCT invoice_year AS year FROM finance_invoices WHERE invoice_year IS NOT NULL ORDER BY invoice_year DESC'
    );
    return rows.map((r) => r.year);
  }
}

module.exports = FinanceInvoice;
