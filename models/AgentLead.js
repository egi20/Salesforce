'use strict';

const { promisePool } = require('../config/database');
const { decimalToScaled } = require('../utils/decimalInput');
const { LEAD_STAGES, isStage, isSource } = require('../config/salesAgents');

/**
 * A sales agent's own pipeline (migration 046). Private to that agent: every read and write
 * is scoped by `user_id` = the agent, in the query itself, so another agent's lead id is
 * simply a row that does not exist. Administrators read them through their own screen.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+()\-.\s]{3,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_VALUE_MINOR = 100000000 * 100; // €100m: anything bigger is a typo

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * The one filter for an agent's leads, used by the list AND its count, so "12 leads" is the
 * number of rows behind it. An unknown stage is ignored rather than matching nothing.
 */
function leadFilter(agentId, { stage = '' } = {}) {
  const where = ['user_id = ?'];
  const params = [agentId];
  if (isStage(stage)) {
    where.push('stage = ?');
    params.push(stage);
  }
  return { clause: where.join(' AND '), params };
}

class AgentLead {
  static leadFilter = leadFilter;

  /**
   * Read the Add-lead form. Pure. Returns `{ value }` or `{ errors }` naming each field —
   * refused, never truncated into something the agent did not type.
   */
  static inputFrom(body = {}) {
    const errors = {};
    const company = text(body.company, 1000);
    if (!company) errors.company = 'Give the company name.';
    else if (company.length > 160) errors.company = 'The company name is longer than 160 characters.';

    const contactName = text(body.contact_name, 1000);
    if (contactName.length > 120) errors.contact_name = 'The contact name is longer than 120 characters.';

    const email = text(body.email, 1000);
    if (email && (email.length > 254 || !EMAIL.test(email))) errors.email = 'That is not an email address.';

    const phone = text(body.phone, 1000);
    if (phone && !PHONE.test(phone)) errors.phone = 'A phone number may hold digits, spaces and + ( ) - only.';

    const source = text(body.source, 40);
    if (!isSource(source)) errors.source = 'Choose where the lead came from.';

    const stage = text(body.stage, 40);
    if (!isStage(stage)) errors.stage = 'Choose a stage.';

    let estimatedValueMinor = null;
    const rawValue = text(body.estimated_value, 40);
    if (rawValue) {
      const minor = decimalToScaled(rawValue, 2, { allowNegative: false });
      if (!Number.isInteger(minor) || minor > MAX_VALUE_MINOR) errors.estimated_value = 'Give the estimated value in euros, for example 12000.';
      else estimatedValueMinor = minor;
    }

    const nextStep = text(body.next_step_on, 20);
    if (nextStep && (!DATE.test(nextStep) || Number.isNaN(new Date(`${nextStep}T00:00:00Z`).getTime()))) {
      errors.next_step_on = 'Give the next step as a date.';
    }

    const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
    if (notes.length > 2000) errors.notes = 'Notes are longer than 2,000 characters.';

    if (Object.keys(errors).length) return { errors };
    return {
      value: {
        company,
        contactName: contactName || null,
        email: email || null,
        phone: phone || null,
        source,
        stage,
        estimatedValueMinor,
        nextStepOn: nextStep || null,
        notes: notes || null
      }
    };
  }

  static async create(agentId, v) {
    const [result] = await promisePool.query(
      `INSERT INTO sales_agent_leads
         (user_id, company, contact_name, email, phone, source, estimated_value_minor, stage, next_step_on, notes, won_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${v.stage === 'won' ? 'NOW()' : 'NULL'})`,
      [agentId, v.company, v.contactName, v.email, v.phone, v.source, v.estimatedValueMinor, v.stage, v.nextStepOn, v.notes]
    );
    return result.insertId;
  }

  static async list(agentId, { stage = '', limit = 10, offset = 0 } = {}) {
    const { clause, params } = leadFilter(agentId, { stage });
    const [rows] = await promisePool.query(
      `SELECT id, company, contact_name, email, phone, source, estimated_value_minor, stage, next_step_on, created_at
         FROM sales_agent_leads WHERE ${clause}
        ORDER BY (next_step_on IS NULL), next_step_on ASC, created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(`SELECT COUNT(*) AS total FROM sales_agent_leads WHERE ${clause}`, params);
    return { rows, total: Number(total) };
  }

  /**
   * Stage counts and the KPI row, in one query. Win rate is won out of CLOSED deals (won +
   * lost) — out of all leads it would fall every time a new lead was added. Null until a deal
   * has closed, because 0% and "nothing decided yet" are different statements.
   * Total value is the estimated value of every lead not lost.
   */
  static async summaryFor(agentId, { now = new Date() } = {}) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [rows] = await promisePool.query(
      `SELECT stage, COUNT(*) AS n, COALESCE(SUM(estimated_value_minor), 0) AS value_minor,
              COALESCE(SUM(won_at >= ?), 0) AS won_this_month
         FROM sales_agent_leads WHERE user_id = ? GROUP BY stage`,
      [monthStart, agentId]
    );
    const byStage = Object.fromEntries(LEAD_STAGES.map((s) => [s.value, 0]));
    let total = 0;
    let valueMinor = 0;
    let wonThisMonth = 0;
    rows.forEach((r) => {
      const n = Number(r.n);
      if (Object.prototype.hasOwnProperty.call(byStage, r.stage)) byStage[r.stage] = n;
      total += n;
      if (r.stage !== 'lost') valueMinor += Number(r.value_minor);
      wonThisMonth += Number(r.won_this_month);
    });
    const closed = byStage.won + byStage.lost;
    return {
      byStage,
      total,
      won: byStage.won,
      winRatePct: closed ? Math.round((byStage.won / closed) * 100) : null,
      valueMinor,
      wonThisMonth
    };
  }

  /**
   * Move a lead. Scoped to the agent in the WHERE, so somebody else's id changes nothing.
   * `won_at` is stamped on the move INTO won and cleared on a move out of it.
   */
  static async setStage(agentId, leadId, stage) {
    if (!isStage(stage)) return false;
    const [result] = await promisePool.query(
      `UPDATE sales_agent_leads
          SET won_at = CASE WHEN ? = 'won' THEN COALESCE(won_at, NOW()) ELSE NULL END,
              stage = ?
        WHERE id = ? AND user_id = ?`,
      [stage, stage, leadId, agentId]
    );
    return result.affectedRows > 0;
  }
}

module.exports = AgentLead;
