'use strict';

const { promisePool, withTransaction } = require('../config/database');
const { SECTION_KEYS, isSection, MAX_DRAFTS_PER_QUOTE } = require('../config/drafting');

/**
 * Drafted narrative for a quote.
 *
 * The invariant this model exists to hold: **at most one ACCEPTED, non-superseded draft
 * per section**, and only that one reaches a document. Everything else is history and
 * stays visible — "what did the model actually write, before I edited it" is the first
 * question anyone reviewing this feature asks.
 *
 * Nothing here can touch `quotes.estimate`. There is no path from a model response to a
 * figure, which is the whole reason drafts live in their own table.
 */
class QuoteDraft {
  static async create(quoteId, { section, body, model, inputTokens, outputTokens, catalogueVersion }) {
    if (!isSection(section)) throw new Error(`QuoteDraft.create: unknown section "${section}"`);

    const [result] = await promisePool.query(
      `INSERT INTO quote_drafts
         (quote_id, section, body, model, input_tokens, output_tokens, catalogue_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [quoteId, section, body, model, inputTokens || 0, outputTokens || 0, catalogueVersion || null]
    );
    return result.insertId;
  }

  /**
   * How many drafts this quote has consumed.
   *
   * The cap is a cost control, so it counts every ATTEMPT that produced a stored draft,
   * not the ones still live. Regenerating ten times and accepting one still cost ten.
   */
  static async countFor(quoteId) {
    const [[row]] = await promisePool.query('SELECT COUNT(*) AS total FROM quote_drafts WHERE quote_id = ?', [
      quoteId
    ]);
    return { used: Number(row.total) || 0, limit: MAX_DRAFTS_PER_QUOTE };
  }

  static async listFor(quoteId) {
    const [rows] = await promisePool.query(
      'SELECT * FROM quote_drafts WHERE quote_id = ? ORDER BY created_at DESC, id DESC',
      [quoteId]
    );
    return rows;
  }

  /**
   * The narrative that goes into a document: accepted, not superseded, keyed by section.
   *
   * `edited_body` wins over `body` wherever it exists. What a client reads is what the
   * author wrote, and the model's original is kept only so the two can be compared.
   */
  static async acceptedFor(quoteId) {
    const [rows] = await promisePool.query(
      `SELECT section, COALESCE(edited_body, body) AS body, accepted_at, model
         FROM quote_drafts
        WHERE quote_id = ? AND accepted_at IS NOT NULL AND superseded_at IS NULL`,
      [quoteId]
    );

    const bySection = {};
    for (const row of rows) {
      if (SECTION_KEYS.includes(row.section)) bySection[row.section] = row;
    }
    return bySection;
  }

  /**
   * Accept a draft, superseding whatever was live for that section.
   *
   * Both halves in one transaction, so a section can never have two live drafts — the one
   * state in which a document's contents would depend on which row a query happened to
   * return first.
   */
  static async accept(draftId, quoteId, { editedBody = null } = {}) {
    return withTransaction(async (conn) => {
      const [[draft]] = await conn.query(
        'SELECT id, section FROM quote_drafts WHERE id = ? AND quote_id = ? FOR UPDATE',
        [draftId, quoteId]
      );
      if (!draft) {
        const err = new Error('That draft no longer exists.');
        err.code = 'NOT_FOUND';
        throw err;
      }

      await conn.query(
        `UPDATE quote_drafts SET superseded_at = NOW()
          WHERE quote_id = ? AND section = ? AND id <> ? AND accepted_at IS NOT NULL AND superseded_at IS NULL`,
        [quoteId, draft.section, draftId]
      );

      await conn.query(
        'UPDATE quote_drafts SET accepted_at = NOW(), superseded_at = NULL, edited_body = ? WHERE id = ?',
        [editedBody && editedBody.trim() ? editedBody.trim() : null, draftId]
      );

      return draft.section;
    });
  }

  /**
   * Withdraw an accepted draft.
   *
   * Marks it superseded rather than deleting it: the row is evidence of what was in a
   * document that may already have been sent.
   */
  static async withdraw(draftId, quoteId) {
    const [result] = await promisePool.query(
      'UPDATE quote_drafts SET superseded_at = NOW() WHERE id = ? AND quote_id = ? AND accepted_at IS NOT NULL',
      [draftId, quoteId]
    );
    return result.affectedRows === 1;
  }

  static async findForQuote(draftId, quoteId) {
    const [rows] = await promisePool.query('SELECT * FROM quote_drafts WHERE id = ? AND quote_id = ? LIMIT 1', [
      draftId,
      quoteId
    ]);
    return rows[0] || null;
  }
}

module.exports = QuoteDraft;
