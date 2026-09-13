'use strict';

const { promisePool, withTransaction } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');
const {
  LIMITS,
  OPEN_STATUSES,
  RETENTION_DAYS,
  STATUSES,
  canTransition,
  isArrangement,
  isTopic
} = require('../config/taxAdvisory');

/**
 * Tax advisory enquiries.
 *
 * This model creates, moves and deletes enquiries. It computes NOTHING. There is no
 * saving, no effective rate, no before-and-after, and a test asserts the exported surface
 * names nothing of the kind — the same guard `utils/contractorEconomics.js` carries, for
 * the same reason. See config/taxAdvisory.js for why the reference's calculator is not
 * here.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function trimmed(value, max) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Multi-line text: collapse runs of blank lines but keep the author's paragraphs. */
function trimmedBlock(value, max) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

/**
 * Validate a submission and answer with the row to write.
 *
 * Pure and exported, so the rules can be tested without a database and so the route has
 * exactly one place to get them wrong. Server-side validation is authoritative: the
 * `maxlength` attributes on the form are a convenience a crafted POST need not respect.
 */
function normaliseSubmission(input = {}) {
  const fullName = trimmed(input.fullName, LIMITS.name);
  if (fullName.length < 2) fail('NAME_REQUIRED', 'Please tell us your name.');

  const email = trimmed(input.email, LIMITS.email).toLowerCase();
  if (!EMAIL_RE.test(email)) fail('EMAIL_INVALID', 'Please enter an email address we can reply to.');

  // Two letters, uppercased, and NOT truncated to length. Passing 2 as the cut here made
  // `ALB` arrive as `AL`, which is a different country — a test caught it. Truncating a
  // code silently changes the answer to the one question that decides who can help,
  // whereas refusing it makes the caller say what they meant. `AUT` -> `AU` is Austria
  // becoming Australia.
  //
  // Not checked against the country list: that list is a 250-entry JSON file the route
  // already holds, and validating it in two places means two places to keep in step.
  const country = trimmed(input.country, LIMITS.country).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) fail('COUNTRY_REQUIRED', 'Please choose where you are tax-resident.');

  if (!isTopic(input.topic)) fail('TOPIC_INVALID', 'Please choose what you want to ask about.');
  if (!isArrangement(input.arrangement)) fail('ARRANGEMENT_INVALID', 'Please choose how you work at the moment.');

  const question = trimmedBlock(input.question, LIMITS.question);
  if (question.length < LIMITS.questionMin) {
    fail('QUESTION_TOO_SHORT', `Please describe your situation in at least ${LIMITS.questionMin} characters.`);
  }

  // Consent is REQUIRED and is never defaulted. An unticked checkbox posts nothing, so
  // absence is refusal — the same trap `AppSetting.setMany` handles by iterating declared
  // keys rather than the submitted body.
  if (!input.consent) {
    fail('CONSENT_REQUIRED', 'We need your agreement before we can pass your enquiry to anyone.');
  }
  if (!input.consentVersion) fail('CONSENT_REQUIRED', 'Consent version missing.');

  return {
    fullName,
    email,
    phone: trimmed(input.phone, LIMITS.phone) || null,
    country,
    topic: input.topic,
    arrangement: input.arrangement,
    question,
    consentVersion: trimmed(input.consentVersion, 32)
  };
}

class TaxEnquiry {
  static get STATUSES() {
    return STATUSES;
  }

  static canTransition = canTransition;

  static normaliseSubmission = normaliseSubmission;

  /**
   * THE ONE FILTER BUILDER for enquiries.
   *
   * Same house rule as `Job.buildFilter` and `Post.buildFilter`: a list and its count must
   * provably describe the same rows, and a screen that assembles its own WHERE is the one
   * that eventually disagrees with the number printed above it.
   */
  static buildFilter(filters = {}) {
    const clauses = [];
    const params = [];

    if (filters.status && STATUSES.includes(filters.status)) {
      clauses.push('e.status = ?');
      params.push(filters.status);
    } else if (filters.open_only) {
      clauses.push(`e.status IN (${OPEN_STATUSES.map(() => '?').join(', ')})`);
      params.push(...OPEN_STATUSES);
    }

    if (filters.country) {
      // Clamped rather than refused, unlike the country on a SUBMISSION. This one narrows
      // a list an administrator is looking at, so a wrong value shows the wrong rows
      // visibly and is corrected in a second; a truncated code stored ON a record is
      // wrong silently, forever, about the one fact that decides who can help.
      clauses.push('e.country = ?');
      params.push(String(filters.country).toUpperCase().slice(0, 2));
    }

    if (filters.topic && isTopic(filters.topic)) {
      clauses.push('e.topic = ?');
      params.push(filters.topic);
    }

    if (filters.q && String(filters.q).trim()) {
      // containsPattern escapes %, _ and the backslash. Without it a search for a literal
      // `%` becomes `%%%`, which matches every row — see utils/likePattern.js.
      const like = containsPattern(filters.q);
      clauses.push('(e.full_name LIKE ? OR e.email LIKE ?)');
      params.push(like, like);
    }

    return { clause: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
  }

  /**
   * Record an enquiry.
   *
   * `open_key` carries the address while the enquiry is open and the unique index on it
   * makes a second submission from the same address an UPDATE of the open row rather than
   * a duplicate. Two clicks on a slow form produce one enquiry, and someone who was helped
   * months ago (their row closed, their key NULLed) can ask again without hitting it.
   */
  static async create(input, { userId = null } = {}) {
    const data = normaliseSubmission(input);

    return withTransaction(async (conn) => {
      const [[existing]] = await conn.query(
        'SELECT id, status FROM tax_enquiries WHERE open_key = ? FOR UPDATE',
        [data.email]
      );

      if (existing) {
        await conn.query(
          `UPDATE tax_enquiries
              SET user_id = COALESCE(?, user_id), full_name = ?, phone = ?, country = ?,
                  topic = ?, arrangement = ?, question = ?,
                  consent_version = ?, consented_at = NOW()
            WHERE id = ?`,
          [
            userId,
            data.fullName,
            data.phone,
            data.country,
            data.topic,
            data.arrangement,
            data.question,
            data.consentVersion,
            existing.id
          ]
        );
        await conn.query(
          'INSERT INTO tax_enquiry_events (enquiry_id, actor_user_id, from_status, to_status, note) VALUES (?, ?, ?, ?, ?)',
          [existing.id, userId, existing.status, existing.status, 'Enquiry updated by the enquirer']
        );
        return { id: existing.id, created: false, email: data.email, fullName: data.fullName };
      }

      const [result] = await conn.query(
        `INSERT INTO tax_enquiries
           (user_id, full_name, email, phone, country, topic, arrangement, question,
            status, open_key, consent_version, consented_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, NOW())`,
        [
          userId,
          data.fullName,
          data.email,
          data.phone,
          data.country,
          data.topic,
          data.arrangement,
          data.question,
          data.email,
          data.consentVersion
        ]
      );

      await conn.query(
        'INSERT INTO tax_enquiry_events (enquiry_id, actor_user_id, from_status, to_status, note) VALUES (?, ?, ?, ?, ?)',
        [result.insertId, userId, null, 'new', 'Enquiry received']
      );

      return { id: result.insertId, created: true, email: data.email, fullName: data.fullName };
    });
  }

  /**
   * Move an enquiry along, or refuse.
   *
   * Closing releases the reservation by NULLing `open_key`, which is the only place that
   * column is ever written after the insert.
   */
  static async setStatus(id, to, { actorUserId = null, note = null } = {}) {
    if (!STATUSES.includes(to)) fail('BAD_STATUS', 'That is not a status an enquiry can be in.');

    return withTransaction(async (conn) => {
      const [[row]] = await conn.query(
        'SELECT id, status, email FROM tax_enquiries WHERE id = ? FOR UPDATE',
        [id]
      );
      if (!row) fail('NOT_FOUND', 'That enquiry no longer exists.');
      if (!canTransition(row.status, to)) {
        fail('BAD_TRANSITION', `An enquiry cannot go from ${row.status} to ${to}.`);
      }

      // The reservation is held for as long as the enquiry is open and released exactly
      // once, on the move to `closed`. Writing NULL on every transition would let a second
      // enquiry from the same address be created while the first is still being worked.
      await conn.query('UPDATE tax_enquiries SET status = ?, open_key = ? WHERE id = ?', [
        to,
        to === 'closed' ? null : row.email,
        id
      ]);

      await conn.query(
        'INSERT INTO tax_enquiry_events (enquiry_id, actor_user_id, from_status, to_status, note) VALUES (?, ?, ?, ?, ?)',
        [id, actorUserId, row.status, to, note ? trimmed(note, 500) : null]
      );

      return { id, from: row.status, to };
    });
  }

  static async findById(id) {
    const [[row]] = await promisePool.query('SELECT * FROM tax_enquiries WHERE id = ?', [id]);
    return row || null;
  }

  static async eventsFor(id) {
    const [rows] = await promisePool.query(
      `SELECT ev.*, u.full_name AS actor_name
         FROM tax_enquiry_events ev
         LEFT JOIN users u ON u.id = ev.actor_user_id
        WHERE ev.enquiry_id = ?
        ORDER BY ev.created_at ASC, ev.id ASC`,
      [id]
    );
    return rows;
  }

  static async list(filters = {}, { limit = 30, offset = 0 } = {}) {
    const { clause, params } = TaxEnquiry.buildFilter(filters);

    const [rows] = await promisePool.query(
      `SELECT e.* FROM tax_enquiries e
        WHERE ${clause}
        ORDER BY e.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM tax_enquiries e WHERE ${clause}`,
      params
    );

    return { rows, total };
  }

  /** What the enquirer can see back, when they had an account at the time. */
  static async listForUser(userId) {
    const [rows] = await promisePool.query(
      `SELECT id, topic, arrangement, country, status, created_at
         FROM tax_enquiries
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 20`,
      [userId]
    );
    return rows;
  }

  /** How many rows are past the declared retention period and awaiting the purge. */
  static async dueForPurge() {
    const [[{ total }]] = await promisePool.query(
      'SELECT COUNT(*) AS total FROM tax_enquiries WHERE created_at < (NOW() - INTERVAL ? DAY)',
      [RETENTION_DAYS]
    );
    return total;
  }

  /**
   * Delete everything past the retention period.
   *
   * Actually deleted, not flagged. Moderation HIDES rather than deletes because a hidden
   * post still has counters and a ledger pointing at it; an enquiry has neither, and the
   * promise made on the form was deletion. The events cascade with it — keeping an audit
   * trail of a record we said we would delete is keeping the record.
   */
  static async purgeExpired() {
    const [result] = await promisePool.query(
      'DELETE FROM tax_enquiries WHERE created_at < (NOW() - INTERVAL ? DAY)',
      [RETENTION_DAYS]
    );
    return result.affectedRows;
  }
}

module.exports = TaxEnquiry;
