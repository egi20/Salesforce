'use strict';

const { promisePool, withTransaction } = require('../config/database');
const {
  LETTERHEAD_FIELDS,
  CLAUSE_KIND_KEYS,
  CLAUSE_KINDS,
  MAX_CLAUSES_PER_KIND,
  checkBrandColour,
  isClauseKind
} = require('../config/companyTemplates');

/**
 * A company's branding and its standard wording.
 *
 * The single writer of both tables, and the only place a brand colour is validated. A
 * colour that failed its contrast check is never stored, so a generator reading this row
 * never has to wonder whether the value it got is readable — which is the difference
 * between a check and a hope.
 */

/** Letterhead values are trimmed, bounded, and stripped of anything that is not text. */
function cleanField(field, raw) {
  if (raw === undefined || raw === null) return null;

  const text = String(raw)
    // Control characters, CR included: these land in a document and in an email header on
    // the way to one. A newline is allowed only where the field says it is multi-line.
    // eslint-disable-next-line no-control-regex
    .replace(field.multiline ? /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g : /[\x00-\x1f\x7f]/g, ' ')
    .trim();

  if (!text) return null;
  return text.slice(0, field.maxLength);
}

class CompanyTemplate {
  static async findByUserId(userId) {
    const [rows] = await promisePool.query('SELECT * FROM company_templates WHERE user_id = ? LIMIT 1', [userId]);
    return rows[0] || null;
  }

  /**
   * Save the letterhead and the brand colours.
   *
   * @returns {Promise<{saved:true} | {saved:false, reason:string}>} a rejected colour is
   *   REPORTED, not silently replaced: a company that picked a colour and got a different
   *   one has been lied to about what it configured.
   */
  static async save(userId, submitted = {}) {
    const values = {};

    for (const key of ['brand_navy', 'brand_blue']) {
      const raw = submitted[key];
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        values[key] = null; // cleared: fall back to the Hub's own colour
        continue;
      }
      const checked = checkBrandColour(raw);
      if (!checked.ok) return { saved: false, reason: checked.reason };
      values[key] = checked.hex;
    }

    for (const field of LETTERHEAD_FIELDS) {
      values[field.key] = cleanField(field, submitted[field.key]);
    }

    const columns = Object.keys(values);
    await promisePool.query(
      `INSERT INTO company_templates (user_id, ${columns.join(', ')})
       VALUES (?, ${columns.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${columns.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
      [userId, ...columns.map((c) => values[c])]
    );

    return { saved: true };
  }

  static async clausesFor(userId) {
    const [rows] = await promisePool.query(
      'SELECT * FROM company_clauses WHERE user_id = ? ORDER BY kind, position, id',
      [userId]
    );

    const byKind = {};
    for (const kind of CLAUSE_KIND_KEYS) byKind[kind] = [];
    for (const row of rows) {
      if (byKind[row.kind]) byKind[row.kind].push(row);
    }
    return byKind;
  }

  /**
   * Add a clause at the end of its kind.
   *
   * The position is derived inside the transaction rather than read and then written: two
   * clauses added at the same moment would otherwise both land on the same position and
   * the list order would depend on which row a query happened to return first.
   */
  static async addClause(userId, { kind, body }) {
    if (!isClauseKind(kind)) {
      const err = new Error('That is not a clause this document has a place for.');
      err.code = 'UNKNOWN_KIND';
      throw err;
    }

    const text = String(body || '').replace(/\s+/g, ' ').trim();
    if (text.length < 10) {
      const err = new Error('A clause needs to say something — at least ten characters.');
      err.code = 'TOO_SHORT';
      throw err;
    }

    return withTransaction(async (conn) => {
      const [[{ total }]] = await conn.query(
        'SELECT COUNT(*) AS total FROM company_clauses WHERE user_id = ? AND kind = ? FOR UPDATE',
        [userId, kind]
      );

      if (total >= MAX_CLAUSES_PER_KIND) {
        // A cap on the document, not on the company: a quote that grows a page of clauses
        // stops being read at all, which serves nobody.
        const err = new Error(`You already have ${MAX_CLAUSES_PER_KIND} ${kind} clauses. Remove one first.`);
        err.code = 'TOO_MANY';
        throw err;
      }

      const [[{ next }]] = await conn.query(
        'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM company_clauses WHERE user_id = ? AND kind = ?',
        [userId, kind]
      );

      await conn.query('INSERT INTO company_clauses (user_id, kind, body, position) VALUES (?, ?, ?, ?)', [
        userId,
        kind,
        text.slice(0, CLAUSE_KINDS[kind].maxLength),
        next
      ]);

      return true;
    });
  }

  static async removeClause(userId, clauseId) {
    const [result] = await promisePool.query('DELETE FROM company_clauses WHERE id = ? AND user_id = ?', [
      clauseId,
      userId
    ]);
    return result.affectedRows === 1;
  }

  /**
   * Move a clause one place up or down within its kind.
   *
   * Swaps two positions in one transaction. The alternative — renumbering the whole list
   * on every move — rewrites rows that did not change and turns a reorder into a diff
   * nobody can read.
   */
  static async moveClause(userId, clauseId, direction) {
    const step = direction === 'up' ? -1 : 1;

    return withTransaction(async (conn) => {
      const [[clause]] = await conn.query(
        'SELECT id, kind, position FROM company_clauses WHERE id = ? AND user_id = ? FOR UPDATE',
        [clauseId, userId]
      );
      if (!clause) return false;

      const [[neighbour]] = await conn.query(
        `SELECT id, position FROM company_clauses
          WHERE user_id = ? AND kind = ? AND position ${step < 0 ? '<' : '>'} ?
          ORDER BY position ${step < 0 ? 'DESC' : 'ASC'} LIMIT 1 FOR UPDATE`,
        [userId, clause.kind, clause.position]
      );
      // Already at the end. Not an error: a person pressing "up" on the first item has not
      // done anything wrong.
      if (!neighbour) return false;

      await conn.query('UPDATE company_clauses SET position = ? WHERE id = ?', [neighbour.position, clause.id]);
      await conn.query('UPDATE company_clauses SET position = ? WHERE id = ?', [clause.position, neighbour.id]);
      return true;
    });
  }

  /**
   * Everything a document generator needs, in one read.
   *
   * Returns a plain object even when nothing is configured, so a generator never branches
   * on whether a company has a template — it renders the Hub's defaults for anything
   * absent. Never throws: a document that has always generated must keep generating.
   */
  static async brandingFor(userId) {
    const empty = { colours: {}, letterhead: {}, clauses: { assumption: [], exclusion: [], term: [] } };
    if (!userId) return empty;

    try {
      const [template, clauses] = await Promise.all([
        CompanyTemplate.findByUserId(userId),
        CompanyTemplate.clausesFor(userId)
      ]);

      if (!template) return { ...empty, clauses };

      const letterhead = {};
      for (const field of LETTERHEAD_FIELDS) {
        if (template[field.key]) letterhead[field.key] = template[field.key];
      }

      return {
        colours: {
          ...(template.brand_navy ? { navy: template.brand_navy } : {}),
          ...(template.brand_blue ? { blue: template.brand_blue } : {})
        },
        letterhead,
        clauses
      };
    } catch (err) {
      console.error(`CompanyTemplate.brandingFor failed for user ${userId}: ${err.message}`);
      return empty;
    }
  }
}

module.exports = CompanyTemplate;
