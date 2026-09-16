'use strict';

const { promisePool, withTransaction } = require('../config/database');
const CrmSuppression = require('./CrmSuppression');
const { containsPattern } = require('../utils/likePattern');
const {
  LIMITS,
  STALE_AFTER_DAYS,
  canTransition,
  isChannel,
  isOutcome,
  isSource,
  isStatus,
  sourceNeedsDetail
} = require('../config/crm');

/**
 * Leads.
 *
 * The suppression list is consulted on EVERY write path — create, import and outreach
 * draft — rather than only at send time. Checking at send is too late: by then the address
 * is already in the database, already in an export, and already in somebody's list.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function block(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function url(value) {
  const raw = text(value, LIMITS.url);
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname.includes('.')) return null;
    return parsed.toString().slice(0, LIMITS.url);
  } catch {
    return null;
  }
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

/**
 * Validate a lead. Pure and exported, so the form, the CSV import and anything else that
 * ever writes one share exactly the same rules — including the source requirement.
 */
function normaliseLead(input = {}) {
  const company = text(input.company, LIMITS.company);
  if (company.length < 2) fail('COMPANY_REQUIRED', 'A lead needs a company name.');

  if (!isSource(input.source)) {
    fail('SOURCE_REQUIRED', 'Choose where this contact came from. A lead cannot be saved without one.');
  }

  const sourceDetail = text(input.source_detail, LIMITS.sourceDetail);
  if (sourceNeedsDetail(input.source) && sourceDetail.length < 3) {
    fail('SOURCE_DETAIL_REQUIRED', 'Say specifically where it came from — the category on its own is not an answer.');
  }

  const email = text(input.contact_email, LIMITS.email).toLowerCase();
  if (email && !EMAIL_RE.test(email)) fail('EMAIL_INVALID', `"${email}" is not an address we could write to.`);

  const country = text(input.country, 16).toUpperCase();

  return {
    company,
    contact_name: text(input.contact_name, LIMITS.contactName) || null,
    contact_email: email || null,
    contact_phone: text(input.contact_phone, LIMITS.phone) || null,
    job_title: text(input.job_title, LIMITS.jobTitle) || null,
    // Refused rather than truncated: `DEU` sliced to two characters is Germany becoming
    // Germany by luck and `AUT` is Austria becoming Australia.
    country: /^[A-Z]{2}$/.test(country) ? country : null,
    website: url(input.website),
    linkedin_url: url(input.linkedin_url),
    source: input.source,
    source_detail: sourceDetail || null
  };
}

class CrmLead {
  static normaliseLead = normaliseLead;

  /**
   * THE ONE FILTER BUILDER for leads.
   *
   * Used by the list, its count, the CSV export AND the bulk actions. That last one is the
   * reason the rule exists at all: a bulk delete and the screen that showed what it would
   * delete must provably target the same rows.
   */
  static buildFilter(filters = {}) {
    const clauses = [];
    const params = [];

    if (filters.status && isStatus(filters.status)) {
      clauses.push('l.status = ?');
      params.push(filters.status);
    }
    if (filters.source && isSource(filters.source)) {
      clauses.push('l.source = ?');
      params.push(filters.source);
    }
    if (filters.country) {
      clauses.push('l.country = ?');
      params.push(String(filters.country).toUpperCase().slice(0, 2));
    }
    if (filters.owner_user_id) {
      clauses.push('l.owner_user_id = ?');
      params.push(Number.parseInt(filters.owner_user_id, 10) || 0);
    }
    if (filters.unowned) {
      clauses.push('l.owner_user_id IS NULL');
    }
    if (filters.stale) {
      clauses.push('(l.last_activity_at IS NULL OR l.last_activity_at < (NOW() - INTERVAL ? DAY))');
      params.push(STALE_AFTER_DAYS);
    }
    if (filters.q && String(filters.q).trim()) {
      const like = containsPattern(filters.q);
      clauses.push('(l.company LIKE ? OR l.contact_name LIKE ? OR l.contact_email LIKE ?)');
      params.push(like, like, like);
    }

    return { clause: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
  }

  /**
   * Create or update one lead.
   *
   * REFUSES A SUPPRESSED ADDRESS OUTRIGHT. Not "creates it flagged" — refuses. A row that
   * exists is a row that appears in an export, gets assigned to somebody, and eventually
   * gets written to by whoever did not read the flag.
   *
   * The unique key on `contact_email` makes a re-import an update rather than a duplicate.
   */
  static async upsert(input, { actorUserId = null } = {}) {
    const fields = normaliseLead(input);

    if (fields.contact_email && (await CrmSuppression.has(fields.contact_email))) {
      fail('SUPPRESSED', 'That address is on the do-not-contact list and cannot be added.');
    }

    return withTransaction(async (conn) => {
      if (fields.contact_email) {
        const [[existing]] = await conn.query(
          'SELECT id FROM crm_leads WHERE contact_email = ? FOR UPDATE',
          [fields.contact_email]
        );
        if (existing) {
          await conn.query(
            `UPDATE crm_leads
                SET company = ?, contact_name = ?, contact_phone = ?, job_title = ?,
                    country = ?, website = ?, linkedin_url = ?, source = ?, source_detail = ?
              WHERE id = ?`,
            [
              fields.company, fields.contact_name, fields.contact_phone, fields.job_title,
              fields.country, fields.website, fields.linkedin_url, fields.source,
              fields.source_detail, existing.id
            ]
          );
          return { id: existing.id, created: false };
        }
      }

      const [result] = await conn.query(
        `INSERT INTO crm_leads
           (company, contact_name, contact_email, contact_phone, job_title, country,
            website, linkedin_url, source, source_detail, created_by, owner_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fields.company, fields.contact_name, fields.contact_email, fields.contact_phone,
          fields.job_title, fields.country, fields.website, fields.linkedin_url,
          fields.source, fields.source_detail, actorUserId, actorUserId
        ]
      );
      return { id: result.insertId, created: true };
    });
  }

  /**
   * Move a lead along, writing the activity in the same transaction.
   *
   * Moving to `unsubscribed` ALSO writes the suppression, inside that transaction. Two
   * separate calls would leave a window in which the status says "leave them alone" and
   * the list does not — and the list is the half that survives.
   */
  static async setStatus(id, to, { actorUserId = null, note = null, channel = null } = {}) {
    if (!isStatus(to)) fail('BAD_STATUS', 'That is not a status a lead can be in.');

    return withTransaction(async (conn) => {
      const [[lead]] = await conn.query(
        'SELECT id, status, contact_email FROM crm_leads WHERE id = ? FOR UPDATE',
        [id]
      );
      if (!lead) fail('NOT_FOUND', 'That lead no longer exists.');
      if (!canTransition(lead.status, to)) {
        fail('BAD_TRANSITION', `A lead cannot go from ${lead.status} to ${to}.`);
      }

      await conn.query(
        'UPDATE crm_leads SET status = ?, last_activity_at = NOW() WHERE id = ?',
        [to, id]
      );

      await conn.query(
        `INSERT INTO crm_lead_activities
           (lead_id, actor_user_id, channel, outcome, from_status, to_status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          actorUserId,
          isChannel(channel) ? channel : null,
          to === 'unsubscribed' ? 'refused' : 'note',
          lead.status,
          to,
          note ? block(note, LIMITS.note) : null
        ]
      );

      if (to === 'unsubscribed' && lead.contact_email) {
        await conn.query(
          'INSERT IGNORE INTO crm_suppressions (email_hash, reason, note, created_by) VALUES (?, ?, ?, ?)',
          [CrmSuppression.hashOf(lead.contact_email), 'requested', note ? String(note).slice(0, 500) : null, actorUserId]
        );
      }

      return { id, from: lead.status, to };
    });
  }

  /** Record what happened. Append-only; the counter moves in the same transaction. */
  static async addActivity(id, { outcome, channel = null, note = null, actorUserId = null }) {
    if (!isOutcome(outcome)) fail('BAD_OUTCOME', 'Choose what happened.');

    return withTransaction(async (conn) => {
      const [[lead]] = await conn.query('SELECT id FROM crm_leads WHERE id = ? FOR UPDATE', [id]);
      if (!lead) fail('NOT_FOUND', 'That lead no longer exists.');

      await conn.query(
        `INSERT INTO crm_lead_activities (lead_id, actor_user_id, channel, outcome, note)
         VALUES (?, ?, ?, ?, ?)`,
        [id, actorUserId, isChannel(channel) ? channel : null, outcome, note ? block(note, LIMITS.note) : null]
      );
      await conn.query('UPDATE crm_leads SET last_activity_at = NOW() WHERE id = ?', [id]);
      return true;
    });
  }

  static async findById(id) {
    const [[row]] = await promisePool.query('SELECT * FROM crm_leads WHERE id = ?', [id]);
    return row || null;
  }

  static async activitiesFor(id) {
    const [rows] = await promisePool.query(
      `SELECT a.*, COALESCE(NULLIF(TRIM(u.name), ''), 'system') AS actor_name
         FROM crm_lead_activities a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.lead_id = ?
        ORDER BY a.created_at DESC, a.id DESC`,
      [id]
    );
    return rows;
  }

  static async list(filters = {}, { limit = 50, offset = 0 } = {}) {
    const { clause, params } = CrmLead.buildFilter(filters);

    const [rows] = await promisePool.query(
      `SELECT l.*, COALESCE(NULLIF(TRIM(u.name), ''), NULL) AS owner_name
         FROM crm_leads l LEFT JOIN users u ON u.id = l.owner_user_id
        WHERE ${clause}
        ORDER BY COALESCE(l.last_activity_at, l.created_at) DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM crm_leads l WHERE ${clause}`,
      params
    );
    return { rows, total };
  }

  /** Counts per status, for the board header. Derived, never cached. */
  static async statusCounts() {
    const [rows] = await promisePool.query(
      'SELECT status, COUNT(*) AS total FROM crm_leads GROUP BY status'
    );
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.total)]));
  }

  /**
   * Delete the rows a filter matches, with the interlock.
   *
   * `expectedCount` is the number the screen showed. If the filtered set has changed since
   * — somebody else imported, somebody else deleted — this aborts and changes nothing.
   *
   * THE REFERENCE GOT THIS RIGHT and it is ported deliberately: `bulk-delete` there takes
   * an `expectedCount` and refuses on a mismatch. Worth saying, because most of what this
   * codebase takes from there it takes as a correction.
   *
   * Deleting a lead does NOT remove its suppression. `crm_suppressions` has no foreign key
   * to this table for exactly that reason.
   */
  static async deleteFiltered(filters, expectedCount) {
    const { clause, params } = CrmLead.buildFilter(filters);

    return withTransaction(async (conn) => {
      const [[{ total }]] = await conn.query(
        `SELECT COUNT(*) AS total FROM crm_leads l WHERE ${clause}`,
        params
      );

      if (Number.isInteger(expectedCount) && total !== expectedCount) {
        const err = new Error(
          `The filter now matches ${total} leads, not ${expectedCount}. Nothing was deleted — reload and check.`
        );
        err.code = 'BULK_COUNT_MISMATCH';
        err.actual = total;
        throw err;
      }

      const [result] = await conn.query(`DELETE l FROM crm_leads l WHERE ${clause}`, params);
      return { deleted: result.affectedRows };
    });
  }

  /** Rows for a CSV export, through the same builder the screen used. */
  static async exportRows(filters) {
    const { clause, params } = CrmLead.buildFilter(filters);
    const [rows] = await promisePool.query(
      `SELECT l.company, l.contact_name, l.contact_email, l.contact_phone, l.job_title,
              l.country, l.website, l.linkedin_url, l.source, l.source_detail, l.status,
              l.last_activity_at, l.created_at
         FROM crm_leads l
        WHERE ${clause}
        ORDER BY l.company ASC
        LIMIT 10000`,
      params
    );
    return rows;
  }

  static async staleCount() {
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM crm_leads
        WHERE last_activity_at IS NULL OR last_activity_at < (NOW() - INTERVAL ? DAY)`,
      [STALE_AFTER_DAYS]
    );
    return total;
  }
}

module.exports = CrmLead;
