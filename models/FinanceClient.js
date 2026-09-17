'use strict';

const { promisePool } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');
const { LIMITS } = require('../config/finance');

/**
 * Who gets invoiced.
 *
 * Separate from `users` on purpose: most people you invoice never had an account here, and
 * a customer closing their marketplace account must not touch an invoice already sent.
 *
 * A client with invoices CANNOT BE DELETED — the foreign key has no cascade and no
 * SET NULL, so the database refuses it. Archiving is the operation; removing the customer
 * an invoice was addressed to is not a thing anybody should be able to do from a list view.
 */

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function block(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function normalise(input = {}) {
  const name = text(input.name, LIMITS.clientName);
  if (name.length < 2) {
    const err = new Error('A client needs a name — it is what goes on the invoice.');
    err.code = 'NAME_REQUIRED';
    throw err;
  }
  const country = text(input.country, 16).toUpperCase();

  return {
    name,
    contact_name: text(input.contact_name, LIMITS.clientName) || null,
    email: text(input.email, LIMITS.email).toLowerCase() || null,
    // Kept multi-line: an invoice address has no reliable shape across jurisdictions, and
    // splitting it into fields guarantees the one country it does not fit.
    address: block(input.address, LIMITS.address) || null,
    // Refused rather than truncated — the ALB-to-AL trap this codebase has hit three times.
    country: /^[A-Z]{2}$/.test(country) ? country : null,
    tax_id: text(input.tax_id, LIMITS.taxId) || null,
    notes: block(input.notes, LIMITS.note) || null
  };
}

class FinanceClient {
  static normalise = normalise;

  static buildFilter(filters = {}) {
    const clauses = [];
    const params = [];

    if (!filters.include_archived) clauses.push('c.is_archived = 0');
    if (filters.q && String(filters.q).trim()) {
      const like = containsPattern(filters.q);
      clauses.push('(c.name LIKE ? OR c.email LIKE ? OR c.tax_id LIKE ?)');
      params.push(like, like, like);
    }
    return { clause: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
  }

  static async create(input) {
    const fields = normalise(input);
    const [result] = await promisePool.query(
      `INSERT INTO finance_clients (name, contact_name, email, address, country, tax_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [fields.name, fields.contact_name, fields.email, fields.address, fields.country, fields.tax_id, fields.notes]
    );
    return { id: result.insertId };
  }

  /**
   * Editing a client does NOT change any invoice already issued to them: those carry their
   * own copy of the name, address and tax id, frozen at the moment of issue.
   */
  static async update(id, input) {
    const fields = normalise(input);
    const [result] = await promisePool.query(
      `UPDATE finance_clients
          SET name = ?, contact_name = ?, email = ?, address = ?, country = ?, tax_id = ?, notes = ?
        WHERE id = ?`,
      [fields.name, fields.contact_name, fields.email, fields.address, fields.country, fields.tax_id, fields.notes, id]
    );
    return result.affectedRows === 1;
  }

  static async setArchived(id, archived) {
    const [result] = await promisePool.query(
      'UPDATE finance_clients SET is_archived = ? WHERE id = ?',
      [archived ? 1 : 0, id]
    );
    return result.affectedRows === 1;
  }

  static async findById(id) {
    const [[row]] = await promisePool.query('SELECT * FROM finance_clients WHERE id = ?', [id]);
    return row || null;
  }

  static async list(filters = {}, { limit = 100, offset = 0 } = {}) {
    const { clause, params } = FinanceClient.buildFilter(filters);
    const [rows] = await promisePool.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM finance_invoices i WHERE i.client_id = c.id) AS invoice_count,
              (SELECT COALESCE(SUM(i.gross_minor), 0) FROM finance_invoices i
                WHERE i.client_id = c.id AND i.status = 'issued') AS outstanding_minor
         FROM finance_clients c
        WHERE ${clause}
        ORDER BY c.name ASC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM finance_clients c WHERE ${clause}`,
      params
    );
    return { rows, total };
  }
}

module.exports = FinanceClient;
