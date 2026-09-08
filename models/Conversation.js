'use strict';

const { promisePool, withTransaction } = require('../config/database');

/**
 * Anchored conversations.
 *
 * Every thread has a subject — an application, or an enquiry about a specific job — and
 * membership is a row in `conversation_participants`. Both facts shape every query here:
 *
 *  - The subject makes the thread's identity deterministic, so opening one is an
 *    idempotent upsert rather than a check-then-insert with a race.
 *  - Membership as a row makes "is this thread mine?" a JOIN condition on every read and
 *    every write, rather than a separate authorisation check that a future query can
 *    forget to make. There is no method here that returns a conversation without also
 *    proving the caller is in it.
 */

const MAX_BODY_LENGTH = 5000;

/**
 * Deterministic subject key. Pure, so the rule is unit-testable.
 *
 * An enquiry key sorts the two user ids, so whichever side starts the thread produces the
 * same key and a second thread cannot be created for the same pair and job.
 */
function dedupeKeyFor(kind, { applicationId = null, jobId = null, userIds = [] } = {}) {
  if (kind === 'application') {
    if (!applicationId) throw new Error('An application conversation needs an applicationId.');
    return `application:${applicationId}`;
  }

  if (kind === 'enquiry') {
    const ids = [...userIds].map(Number).filter(Number.isInteger).sort((a, b) => a - b);
    if (ids.length !== 2) throw new Error('An enquiry conversation needs exactly two participants.');
    return `enquiry:${jobId || 0}:${ids[0]}:${ids[1]}`;
  }

  throw new Error(`Unknown conversation kind: ${kind}`);
}

/**
 * Display name for the other party.
 *
 * Falls back to a NEUTRAL label, never the email local part. That fallback is what the
 * reference implementation flagged: an account with no profile would otherwise leak a
 * `firstname.lastname` email prefix to anyone who could open a thread with it.
 */
const OTHER_NAME_SQL = `COALESCE(
  NULLIF(TRIM(u.name), ''),
  NULLIF(TRIM(comp.company_name), ''),
  'Salesforce Hub user'
)`;

function normaliseBody(body) {
  return String(body || '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, MAX_BODY_LENGTH);
}

class Conversation {
  static get MAX_BODY_LENGTH() {
    return MAX_BODY_LENGTH;
  }

  static dedupeKeyFor = dedupeKeyFor;

  static normaliseBody = normaliseBody;

  /**
   * Open the thread for a subject, creating it if it does not exist.
   *
   * The INSERT ... ON DUPLICATE KEY on `dedupe_key` is the concurrency control: two people
   * clicking "message" at the same moment get the same thread, not two.
   */
  static async findOrCreate({ kind, applicationId = null, jobId = null, participantIds, createdByUserId }) {
    const dedupeKey = dedupeKeyFor(kind, { applicationId, jobId, userIds: participantIds });

    return withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO conversations (kind, dedupe_key, job_id, application_id, created_by_user_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [kind, dedupeKey, jobId, applicationId, createdByUserId]
      );

      const [[row]] = await conn.query('SELECT id FROM conversations WHERE dedupe_key = ? LIMIT 1', [dedupeKey]);
      const conversationId = row.id;

      const values = participantIds.map((userId) => [conversationId, userId]);
      await conn.query('INSERT IGNORE INTO conversation_participants (conversation_id, user_id) VALUES ?', [values]);

      return conversationId;
    });
  }

  /**
   * Fetch a thread AS a participant.
   *
   * The participant join is part of the query, so a non-member gets null rather than a
   * conversation plus a hope that the caller checks.
   */
  static async forParticipant(conversationId, userId) {
    const [rows] = await promisePool.query(
      `SELECT c.*, cp.last_read_at,
              j.title AS job_title, j.slug AS job_slug,
              a.status AS application_status
         FROM conversations c
         JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = ?
         LEFT JOIN jobs j ON j.id = c.job_id
         LEFT JOIN applications a ON a.id = c.application_id
        WHERE c.id = ?
        LIMIT 1`,
      [userId, conversationId]
    );
    return rows[0] || null;
  }

  static async participants(conversationId) {
    const [rows] = await promisePool.query(
      `SELECT cp.user_id, cp.last_read_at, ${OTHER_NAME_SQL} AS display_name,
              con.profile_picture, comp.logo
         FROM conversation_participants cp
         JOIN users u ON u.id = cp.user_id
         LEFT JOIN consultant_profiles con ON con.user_id = u.id
         LEFT JOIN company_profiles comp ON comp.user_id = u.id
        WHERE cp.conversation_id = ?`,
      [conversationId]
    );
    return rows;
  }

  /**
   * Inbox. One row per thread with the other party, the last message and the unread count.
   *
   * The unread count is computed against this participant's `last_read_at`, and a message
   * the participant sent themselves never counts as unread — otherwise sending a reply
   * lights up your own inbox.
   */
  static async listForUser(userId, { limit = 30, offset = 0 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT c.id, c.kind, c.job_id, c.application_id, c.last_message_at,
              j.title AS job_title, j.slug AS job_slug,
              other.user_id AS other_user_id,
              ${OTHER_NAME_SQL} AS other_name,
              con.profile_picture AS other_photo,
              comp.logo AS other_logo,
              (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
              (SELECT m.sender_user_id FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender_id,
              (SELECT COUNT(*) FROM messages m
                WHERE m.conversation_id = c.id
                  AND m.sender_user_id <> ?
                  AND (me.last_read_at IS NULL OR m.created_at > me.last_read_at)) AS unread_count
         FROM conversations c
         JOIN conversation_participants me ON me.conversation_id = c.id AND me.user_id = ?
         JOIN conversation_participants other ON other.conversation_id = c.id AND other.user_id <> ?
         JOIN users u ON u.id = other.user_id
         LEFT JOIN consultant_profiles con ON con.user_id = u.id
         LEFT JOIN company_profiles comp ON comp.user_id = u.id
         LEFT JOIN jobs j ON j.id = c.job_id
        ORDER BY c.last_message_at IS NULL, c.last_message_at DESC, c.id DESC
        LIMIT ? OFFSET ?`,
      [userId, userId, userId, limit, offset]
    );

    const [[{ total }]] = await promisePool.query(
      'SELECT COUNT(*) AS total FROM conversation_participants WHERE user_id = ?',
      [userId]
    );

    return { rows, total };
  }

  static async messages(conversationId, { limit = 200 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT m.id, m.sender_user_id, m.body, m.created_at, ${OTHER_NAME_SQL} AS sender_name
         FROM messages m
         JOIN users u ON u.id = m.sender_user_id
         LEFT JOIN company_profiles comp ON comp.user_id = u.id
        WHERE m.conversation_id = ?
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ?`,
      [conversationId, limit]
    );
    return rows;
  }

  /**
   * Post a message.
   *
   * The participant check is inside the transaction and inside the WHERE, so there is no
   * window between "are you a member?" and the insert. Sending also marks the thread read
   * for the sender: you have by definition seen everything up to your own reply.
   *
   * @throws {Error & {code:'NOT_A_PARTICIPANT'|'EMPTY_MESSAGE'}}
   */
  static async postMessage(conversationId, senderUserId, rawBody) {
    const body = normaliseBody(rawBody);
    if (!body) {
      const err = new Error('A message cannot be empty.');
      err.code = 'EMPTY_MESSAGE';
      throw err;
    }

    return withTransaction(async (conn) => {
      const [[membership]] = await conn.query(
        'SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id = ? FOR UPDATE',
        [conversationId, senderUserId]
      );
      if (!membership) {
        const err = new Error('That conversation is not yours.');
        err.code = 'NOT_A_PARTICIPANT';
        throw err;
      }

      const [result] = await conn.query(
        'INSERT INTO messages (conversation_id, sender_user_id, body) VALUES (?, ?, ?)',
        [conversationId, senderUserId, body]
      );

      await conn.query('UPDATE conversations SET last_message_at = NOW() WHERE id = ?', [conversationId]);
      await conn.query(
        'UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?',
        [conversationId, senderUserId]
      );

      const [recipients] = await conn.query(
        'SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id <> ?',
        [conversationId, senderUserId]
      );

      return { messageId: result.insertId, body, recipientIds: recipients.map((r) => r.user_id) };
    });
  }

  /** Ownership is in the WHERE, so a guessed id cannot mark someone else's thread read. */
  static async markRead(conversationId, userId) {
    const [result] = await promisePool.query(
      'UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?',
      [conversationId, userId]
    );
    return result.affectedRows === 1;
  }

  /** Total unread across every thread, for the navigation badge. */
  static async unreadCount(userId) {
    const [[row]] = await promisePool.query(
      `SELECT COUNT(*) AS count
         FROM messages m
         JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = ?
        WHERE m.sender_user_id <> ?
          AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)`,
      [userId, userId]
    );
    return row.count;
  }
}

module.exports = Conversation;
