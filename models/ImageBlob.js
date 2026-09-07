'use strict';

const crypto = require('crypto');
const sharp = require('sharp');
const { promisePool } = require('../config/database');

/**
 * Durable image storage.
 *
 * The application host's disk is ephemeral, so uploaded bytes live in MySQL. They live
 * in a SEPARATE table from the profile they belong to, because profile and talent-list
 * queries select whole rows and inlining megabytes of image data would drag them into
 * every list query.
 *
 * The owning row stores only a pointer URL carrying a cache-busting `?v=<timestamp>`,
 * and the serving route is ETag-cached.
 */
const ALLOWED_TABLES = new Set(['consultant_photos', 'company_logos']);

function assertTable(table) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Unknown blob table: ${table}`);
  return table;
}

class ImageBlob {
  /**
   * Normalise an upload to a bounded WebP and store it.
   * Re-encoding is also the sanitiser: whatever metadata, polyglot payload or
   * oversized canvas arrived, what gets stored is what sharp produced.
   */
  static async put(table, ownerId, buffer, { size = 512 } = {}) {
    assertTable(table);

    const bytes = await sharp(buffer)
      .rotate() // honour EXIF orientation before stripping the EXIF
      .resize(size, size, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82 })
      .toBuffer();

    const etag = crypto.createHash('md5').update(bytes).digest('hex');

    await promisePool.query(
      `INSERT INTO ${table} (user_id, content_type, bytes, byte_size, etag)
       VALUES (?, 'image/webp', ?, ?, ?)
       ON DUPLICATE KEY UPDATE bytes = VALUES(bytes), byte_size = VALUES(byte_size),
                               etag = VALUES(etag), content_type = VALUES(content_type)`,
      [ownerId, bytes, bytes.length, etag]
    );

    return { etag, byteSize: bytes.length };
  }

  static async get(table, ownerId) {
    assertTable(table);
    const [rows] = await promisePool.query(
      `SELECT content_type, bytes, etag, updated_at FROM ${table} WHERE user_id = ? LIMIT 1`,
      [ownerId]
    );
    return rows[0] || null;
  }

  /** ETag only, for a cheap conditional-request answer without loading the bytes. */
  static async getEtag(table, ownerId) {
    assertTable(table);
    const [rows] = await promisePool.query(`SELECT etag FROM ${table} WHERE user_id = ? LIMIT 1`, [ownerId]);
    return rows.length ? rows[0].etag : null;
  }

  static async remove(table, ownerId) {
    assertTable(table);
    await promisePool.query(`DELETE FROM ${table} WHERE user_id = ?`, [ownerId]);
  }

  /** Pointer URL with a cache buster, stored on the owning profile row. */
  static pointerUrl(basePath, ownerId) {
    return `${basePath}/${ownerId}?v=${Date.now()}`;
  }
}

module.exports = ImageBlob;
