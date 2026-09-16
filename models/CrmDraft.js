'use strict';

const { promisePool } = require('../config/database');
const { LIMITS } = require('../config/crm');

/**
 * Outreach drafts.
 *
 * `body` keeps what the model wrote and `edited_body` keeps what a person actually sent —
 * the same split `quote_drafts` uses, and for the same reason: what goes out has to be
 * what somebody put their name to, and that is only checkable if both halves survive.
 *
 * `marked_sent_at` is a NOTE SOMEBODY MADE, not a delivery receipt. Nothing in this
 * application sends anything; the column is named for what it is so that nobody later
 * reads it as proof a message arrived.
 *
 * Every method takes the lead id alongside the draft id and scopes the statement by both.
 * A draft id on its own would let a request edit a draft belonging to a different lead —
 * harmless here because the whole area is superadmin-gated, load-bearing the day it is not.
 */

const MAX_DRAFTS_PER_LEAD = 5;

function block(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

class CrmDraft {
  static get MAX_DRAFTS_PER_LEAD() {
    return MAX_DRAFTS_PER_LEAD;
  }

  /**
   * Store a draft, superseding whatever came before it.
   *
   * Superseded drafts are KEPT rather than deleted — one may already have been sent by
   * hand, and a record of what was sent is the point of having the table.
   */
  static async create(leadId, { body, channel = 'email', model = null, inputTokens = null, outputTokens = null, actorUserId = null }) {
    const [[{ total }]] = await promisePool.query(
      'SELECT COUNT(*) AS total FROM crm_outreach_drafts WHERE lead_id = ?',
      [leadId]
    );
    if (total >= MAX_DRAFTS_PER_LEAD) {
      const err = new Error(
        `This lead already has ${total} drafts. Use one of them or edit it — a "try again" button with no ceiling is an unbounded bill.`
      );
      err.code = 'TOO_MANY_DRAFTS';
      throw err;
    }

    await promisePool.query(
      'UPDATE crm_outreach_drafts SET superseded_at = NOW() WHERE lead_id = ? AND superseded_at IS NULL AND marked_sent_at IS NULL',
      [leadId]
    );

    const [result] = await promisePool.query(
      `INSERT INTO crm_outreach_drafts
         (lead_id, channel, body, model, input_tokens, output_tokens, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [leadId, channel, block(body, LIMITS.draft), model, inputTokens, outputTokens, actorUserId]
    );
    return { id: result.insertId };
  }

  static async forLead(leadId) {
    const [rows] = await promisePool.query(
      `SELECT d.*, COALESCE(NULLIF(TRIM(u.name), ''), 'system') AS author_name
         FROM crm_outreach_drafts d LEFT JOIN users u ON u.id = d.created_by
        WHERE d.lead_id = ?
        ORDER BY d.created_at DESC`,
      [leadId]
    );
    return rows;
  }

  /** Save a person's edit. The model's original is never overwritten. */
  static async saveEdit(draftId, leadId, editedBody) {
    const [result] = await promisePool.query(
      'UPDATE crm_outreach_drafts SET edited_body = ? WHERE id = ? AND lead_id = ?',
      [block(editedBody, LIMITS.draft) || null, draftId, leadId]
    );
    return result.affectedRows === 1;
  }

  /**
   * Record that somebody sent it.
   *
   * Only ever set from NULL, so a second click cannot re-date a send that already happened.
   */
  static async markSent(draftId, leadId) {
    const [result] = await promisePool.query(
      'UPDATE crm_outreach_drafts SET marked_sent_at = NOW() WHERE id = ? AND lead_id = ? AND marked_sent_at IS NULL',
      [draftId, leadId]
    );
    return result.affectedRows === 1;
  }
}

module.exports = CrmDraft;
