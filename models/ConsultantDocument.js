'use strict';

const { promisePool, withTransaction } = require('../config/database');

/**
 * A consultant's own uploaded CVs and cover letters (migration 037).
 *
 * The bytes live in the database, never on the host disk, and are only ever read back by
 * `findForOwner` — every list query names its columns and leaves `bytes` out, so a list of
 * ten CVs is not ten documents' worth of memory. Validation happens BEFORE anything reaches
 * here: see utils/documentUpload.js.
 *
 * One default per kind. Setting a default clears the other in the same transaction, so there
 * is never a moment with two.
 */
const KINDS = Object.freeze(['cv', 'cover_letter']);
const MAX_PER_USER = 10;
const LIST_COLUMNS = 'id, kind, title, filename, content_type, byte_size, is_default, created_at';

class ConsultantDocument {
  static async listFor(userId) {
    const [rows] = await promisePool.query(
      `SELECT ${LIST_COLUMNS} FROM consultant_documents WHERE user_id = ?
        ORDER BY kind, is_default DESC, created_at DESC`,
      [userId]
    );
    return rows;
  }

  /** @returns {{ok:true, id:number} | {ok:false, reason:string}} */
  static async add(userId, { kind, title, filename, contentType, bytes, isDefault }) {
    if (!KINDS.includes(kind)) return { ok: false, reason: 'Choose CV or cover letter.' };
    return withTransaction(async (conn) => {
      const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM consultant_documents WHERE user_id = ? FOR UPDATE', [userId]);
      if (n >= MAX_PER_USER) return { ok: false, reason: `You can keep up to ${MAX_PER_USER} documents. Delete one first.` };

      // The first document of a kind is its default whatever the box said.
      const [[{ sameKind }]] = await conn.query(
        'SELECT COUNT(*) AS sameKind FROM consultant_documents WHERE user_id = ? AND kind = ?',
        [userId, kind]
      );
      const makeDefault = Boolean(isDefault) || sameKind === 0;
      if (makeDefault) {
        await conn.query('UPDATE consultant_documents SET is_default = 0 WHERE user_id = ? AND kind = ?', [userId, kind]);
      }
      const [result] = await conn.query(
        `INSERT INTO consultant_documents (user_id, kind, title, filename, content_type, byte_size, bytes, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, kind, title || null, String(filename).slice(0, 160), contentType, bytes.length, bytes, makeDefault ? 1 : 0]
      );
      return { ok: true, id: result.insertId };
    });
  }

  static async setDefault(userId, id) {
    return withTransaction(async (conn) => {
      const [[doc]] = await conn.query('SELECT kind FROM consultant_documents WHERE id = ? AND user_id = ? FOR UPDATE', [id, userId]);
      if (!doc) return false;
      await conn.query('UPDATE consultant_documents SET is_default = 0 WHERE user_id = ? AND kind = ?', [userId, doc.kind]);
      await conn.query('UPDATE consultant_documents SET is_default = 1 WHERE id = ? AND user_id = ?', [id, userId]);
      return true;
    });
  }

  /** Removing the default promotes the newest remaining document of that kind. */
  static async remove(userId, id) {
    return withTransaction(async (conn) => {
      const [[doc]] = await conn.query('SELECT kind, is_default FROM consultant_documents WHERE id = ? AND user_id = ? FOR UPDATE', [id, userId]);
      if (!doc) return false;
      await conn.query('DELETE FROM consultant_documents WHERE id = ? AND user_id = ?', [id, userId]);
      if (doc.is_default) {
        await conn.query(
          `UPDATE consultant_documents SET is_default = 1 WHERE user_id = ? AND kind = ?
            ORDER BY created_at DESC LIMIT 1`,
          [userId, doc.kind]
        );
      }
      return true;
    });
  }

  /** The bytes, for the owner only: the user id is part of the WHERE, never a separate check. */
  static async findForOwner(userId, id) {
    const [rows] = await promisePool.query(
      'SELECT id, filename, title, content_type, bytes FROM consultant_documents WHERE id = ? AND user_id = ? LIMIT 1',
      [id, userId]
    );
    return rows[0] || null;
  }
}

ConsultantDocument.KINDS = KINDS;
ConsultantDocument.MAX_PER_USER = MAX_PER_USER;

module.exports = ConsultantDocument;
