'use strict';

const { promisePool } = require('../config/database');
const Referral = require('./Referral');
const { commissionMinor } = require('../config/referrals');
const {
  AGENT_COMMISSION_PRODUCTS,
  AGENT_EARNING_WINDOW_DAYS,
  MAX_AGENT_COMMISSION_BPS,
  MAX_MONTHLY_TARGET
} = require('../config/salesAgents');
const { containsPattern } = require('../utils/likePattern');
const { QA_EMAIL_LIKE } = require('../utils/qaAccounts');

/**
 * Sales agents (migration 031): colleagues with a personal sign-up link that is measured.
 * Migration 031 made it pay nothing; since 2026-11-09 (migration 046) an agent earns a share
 * of what their sign-ups pay — the owner's decision, credited by `credit` below. Not the referral scheme — see the migration for why the two are apart.
 *
 * Codes use the referral alphabet and length, so they read the same aloud, but live in
 * their own table: the same eight letters can be a referral code and an agent code without
 * either meaning the other, because they arrive on different URLs.
 */

const { generateCode, normaliseCode } = Referral;

class SalesAgent {
  static normaliseCode = normaliseCode;

  /** Put an existing account on the list, or return the row it already has. */
  static async add(userId, addedBy) {
    const existing = await SalesAgent.findByUserId(userId);
    if (existing) return { agent: existing, created: false };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await promisePool.query('INSERT INTO sales_agents (user_id, code, added_by) VALUES (?, ?, ?)', [userId, generateCode(), addedBy || null]);
        // eslint-disable-next-line no-await-in-loop
        return { agent: await SalesAgent.findByUserId(userId), created: true };
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err;
        // eslint-disable-next-line no-await-in-loop
        const raced = await SalesAgent.findByUserId(userId);
        if (raced) return { agent: raced, created: false };
      }
    }
    throw new Error('Could not allocate a sales agent code.');
  }

  static async findByUserId(userId) {
    const [rows] = await promisePool.query('SELECT * FROM sales_agents WHERE user_id = ?', [userId]);
    return rows[0] || null;
  }

  /** An agent whose link still counts: on the list, switched on, and an active account. */
  static async findActiveByCode(raw) {
    const code = normaliseCode(raw);
    if (!code) return null;
    const [rows] = await promisePool.query(
      `SELECT sa.* FROM sales_agents sa JOIN users u ON u.id = sa.user_id
        WHERE sa.code = ? AND sa.is_active = 1 AND u.is_active = 1`,
      [code]
    );
    return rows[0] || null;
  }

  static async setActive(userId, active) {
    const [result] = await promisePool.query('UPDATE sales_agents SET is_active = ? WHERE user_id = ?', [active ? 1 : 0, userId]);
    return result.affectedRows > 0;
  }

  /**
   * One counted open: the lifetime counter, and a dated row (migration 032) so the admin tab
   * can say how many happened in the last 24 hours. The dated row is best-effort — a failure
   * there must not cost the counter, and the visitor is redirected either way.
   */
  static async countOpen(userId) {
    await promisePool.query('UPDATE sales_agents SET link_opens = link_opens + 1 WHERE user_id = ?', [userId]);
    try {
      await promisePool.query('INSERT INTO sales_agent_link_opens (agent_user_id) VALUES (?)', [userId]);
    } catch (err) {
      console.error(`Sales agent open not dated: ${err.message}`);
    }
  }

  /**
   * One counted open of the agent's TAX link (`/t/<code>`, migration 047). The table is the
   * count — there is no lifetime counter beside it, because the link started with it.
   */
  static async countTaxOpen(userId) {
    await promisePool.query('INSERT INTO sales_agent_tax_opens (agent_user_id) VALUES (?)', [userId]);
  }

  /**
   * Credit a new account to the agent whose link it came through. First touch: the WHERE
   * refuses to overwrite, and an agent cannot be credited with their own account.
   */
  static async attribute(rawCode, newUserId) {
    try {
      const agent = await SalesAgent.findActiveByCode(rawCode);
      if (!agent || agent.user_id === newUserId) return false;
      const [result] = await promisePool.query(
        // `agent_notice_at` (migration 046): attribution only happens on the sign-up form, and
        // that form tells the person an agent whose link they came through may contact them.
        'UPDATE users SET sales_agent_id = ?, agent_notice_at = NOW() WHERE id = ? AND sales_agent_id IS NULL',
        [agent.user_id, newUserId]
      );
      return result.affectedRows > 0;
    } catch (err) {
      // A sign-up has already succeeded; failing to note whose link it was must not undo it.
      console.error(`Sales agent attribution failed: ${err.message}`);
      return false;
    }
  }

  /** The row behind the agent dashboard: on the list and switched on. A paused agent has no dashboard. */
  static async activeAgentFor(userId) {
    if (!userId) return null;
    const [rows] = await promisePool.query('SELECT * FROM sales_agents WHERE user_id = ? AND is_active = 1', [userId]);
    return rows[0] || null;
  }

  /**
   * An administrator sets an agent's terms. Each one may be left empty — "not agreed yet" —
   * and an empty commission earns nothing. Out-of-range values are refused, never clamped:
   * a rate somebody mistyped as 150% must be noticed, not quietly turned into 30%.
   *
   * @returns {{ok:true}|{ok:false, error:string}}
   */
  static parseTerms(input = {}) {
    const department = typeof input.department === 'string' ? input.department.trim() : '';
    if (department.length > 80) return { ok: false, error: 'The department name is longer than 80 characters.' };

    let commissionBps = null;
    const pct = String(input.commission_pct ?? '').trim().replace(',', '.');
    if (pct !== '') {
      if (!/^\d{1,2}(\.\d{1,2})?$/.test(pct)) return { ok: false, error: 'Commission must be a percentage such as 10 or 7.5.' };
      commissionBps = Math.round(Number(pct) * 100);
      if (commissionBps > MAX_AGENT_COMMISSION_BPS) return { ok: false, error: `Commission cannot be above ${MAX_AGENT_COMMISSION_BPS / 100}%.` };
    }

    let monthlyTarget = null;
    const target = String(input.monthly_target ?? '').trim();
    if (target !== '') {
      if (!/^\d{1,3}$/.test(target) || Number(target) > MAX_MONTHLY_TARGET) return { ok: false, error: `The monthly target must be a whole number from 0 to ${MAX_MONTHLY_TARGET}.` };
      monthlyTarget = Number(target);
    }
    return { ok: true, department: department || null, commissionBps, monthlyTarget };
  }

  static async setTerms(userId, { department, commissionBps, monthlyTarget }) {
    const [result] = await promisePool.query(
      'UPDATE sales_agents SET department = ?, commission_bps = ?, monthly_target = ? WHERE user_id = ?',
      [department, commissionBps, monthlyTarget, userId]
    );
    return result.affectedRows > 0;
  }

  /**
   * Credit the agent whose link a paying customer came through. Called from
   * `services/paymentFulfilment.js` beside `Referral.credit`, outside the fulfilment
   * transaction, and the same rules hold: never throws, credits money RECEIVED, idempotent on
   * the payment (unique key), rate SNAPSHOT on the row so a later change reprices nothing.
   *
   * Nothing is written when the agent has no agreed rate, the product is not one agents earn
   * on, or the payment falls outside the earning window from the customer's sign-up.
   */
  static async credit(payment) {
    try {
      if (!payment || !payment.id || !payment.user_id) return { credited: 0, reason: 'no payment' };
      if (!AGENT_COMMISSION_PRODUCTS.includes(payment.product)) return { credited: 0, reason: 'not an agent product' };

      const [[row]] = await promisePool.query(
        `SELECT sa.user_id AS agent_id, sa.commission_bps, u.created_at AS joined_at
           FROM users u JOIN sales_agents sa ON sa.user_id = u.sales_agent_id
          WHERE u.id = ?`,
        [payment.user_id]
      );
      if (!row) return { credited: 0, reason: 'no agent' };
      if (row.commission_bps == null) return { credited: 0, reason: 'no agreed rate' };
      const windowEnds = new Date(new Date(row.joined_at).getTime() + AGENT_EARNING_WINDOW_DAYS * 86400000);
      if (new Date() > windowEnds) return { credited: 0, reason: 'outside the earning window' };

      const amount = commissionMinor(Number(payment.amount_minor), Number(row.commission_bps));
      const [result] = await promisePool.query(
        `INSERT IGNORE INTO agent_commission_ledger
           (user_id, payment_id, product, payment_amount_minor, rate_bps, commission_minor, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [row.agent_id, payment.id, payment.product, Number(payment.amount_minor), Number(row.commission_bps), amount, payment.currency || 'EUR']
      );
      return result.affectedRows === 1 ? { credited: amount, reason: 'credited' } : { credited: 0, reason: 'already credited' };
    } catch (err) {
      console.error(`SalesAgent.credit failed for payment #${payment && payment.id}: ${err.message}`);
      return { credited: 0, reason: 'error' };
    }
  }

  /** What the agent's ledger holds, per product, and in total. */
  static async earningsFor(userId) {
    const [rows] = await promisePool.query(
      `SELECT product, COUNT(*) AS n, COALESCE(SUM(payment_amount_minor), 0) AS paid_minor,
              COALESCE(SUM(commission_minor), 0) AS commission_minor
         FROM agent_commission_ledger WHERE user_id = ? GROUP BY product`,
      [userId]
    );
    const byProduct = new Map(rows.map((r) => [r.product, { count: Number(r.n), paidMinor: Number(r.paid_minor), commissionMinor: Number(r.commission_minor) }]));
    const totalMinor = [...byProduct.values()].reduce((sum, r) => sum + r.commissionMinor, 0);
    return { byProduct, totalMinor };
  }

  /**
   * "Came from your link", for the agent's own follow-up: email, role, country and date —
   * and the email ONLY for people who were told at sign-up that an agent may contact them
   * (`users.agent_notice_at`, migration 046). Anybody who signed up before that notice
   * existed is listed without an address, and is not findable by one either: the search
   * matches addresses the agent is allowed to see, so it cannot confirm a hidden one.
   */
  static async peopleForAgent(userId, { q = '', role = '', verified = '', limit = 100 } = {}) {
    const where = ['u.sales_agent_id = ?'];
    const params = [userId];
    const term = String(q || '').trim().slice(0, 100);
    if (term) {
      where.push('(u.agent_notice_at IS NOT NULL AND u.email LIKE ?)');
      params.push(containsPattern(term));
    }
    if (role === 'consultant') where.push('u.is_consultant = 1');
    else if (role === 'company') where.push('u.is_company = 1');
    else if (role === 'other') where.push('u.is_consultant = 0 AND u.is_company = 0');
    if (verified === 'yes') where.push('u.email_verified = 1');
    else if (verified === 'no') where.push('u.email_verified = 0');

    const clause = where.join(' AND ');
    const [rows] = await promisePool.query(
      `SELECT u.id, CASE WHEN u.agent_notice_at IS NOT NULL THEN u.email END AS email,
              u.created_at, u.is_active, u.is_consultant, u.is_company, u.email_verified,
              ${COUNTRY_SQL} AS country, ${COUNTRY_SOURCE_SQL} AS country_source
         FROM users u ${COUNTRY_JOINS}
        WHERE ${clause}
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT ?`,
      [...params, limit]
    );
    const [[{ total }]] = await promisePool.query(`SELECT COUNT(*) AS total FROM users u WHERE ${clause}`, params);
    return { rows, total: Number(total) };
  }

  /** Every agent with what their link has done, in ONE query for the page. */
  static async listAll() {
    const [rows] = await promisePool.query(
      `SELECT sa.user_id, sa.code, sa.is_active, sa.link_opens, sa.created_at,
              sa.department, sa.commission_bps, sa.monthly_target,
              u.name, u.email, u.is_active AS account_active,
              COUNT(s.id)                          AS signups,
              COALESCE(SUM(s.is_consultant = 1), 0) AS consultants,
              COALESCE(SUM(s.is_company = 1), 0)    AS companies,
              COALESCE(SUM(s.email_verified = 1), 0) AS verified,
              MAX(s.created_at)                    AS last_signup,
              COALESCE(SUM(s.created_at >= NOW() - INTERVAL 24 HOUR), 0) AS signups_24h,
              (SELECT COUNT(*) FROM sales_agent_link_opens o
                WHERE o.agent_user_id = sa.user_id AND o.opened_at >= NOW() - INTERVAL 24 HOUR) AS opens_24h,
              (SELECT COUNT(*) FROM sales_agent_tax_opens t WHERE t.agent_user_id = sa.user_id) AS tax_opens,
              (SELECT COUNT(*) FROM sales_agent_tax_opens t
                WHERE t.agent_user_id = sa.user_id AND t.opened_at >= NOW() - INTERVAL 24 HOUR) AS tax_opens_24h
         FROM sales_agents sa
         JOIN users u ON u.id = sa.user_id
         LEFT JOIN users s ON s.sales_agent_id = sa.user_id
        GROUP BY sa.user_id, sa.code, sa.is_active, sa.link_opens, sa.created_at, sa.department, sa.commission_bps, sa.monthly_target, u.name, u.email, u.is_active
        ORDER BY sa.is_active DESC, signups DESC, u.name`,
      []
    );
    return rows.map((r) => ({
      ...r,
      signups: Number(r.signups), consultants: Number(r.consultants), companies: Number(r.companies), verified: Number(r.verified),
      signups_24h: Number(r.signups_24h), opens_24h: Number(r.opens_24h),
      tax_opens: Number(r.tax_opens), tax_opens_24h: Number(r.tax_opens_24h)
    }));
  }

  /** One agent's own figures, for their dashboard — the same counts the admin tab shows. */
  static async statsFor(userId) {
    const [[row]] = await promisePool.query(
      `SELECT sa.code, sa.is_active, sa.link_opens,
              COUNT(s.id) AS signups,
              COALESCE(SUM(s.is_consultant = 1), 0) AS consultants,
              COALESCE(SUM(s.is_company = 1), 0) AS companies,
              COALESCE(SUM(s.email_verified = 1), 0) AS verified,
              MAX(s.created_at) AS last_signup,
              (SELECT COUNT(*) FROM sales_agent_tax_opens t WHERE t.agent_user_id = sa.user_id) AS tax_opens,
              (SELECT COUNT(*) FROM sales_agent_tax_opens t
                WHERE t.agent_user_id = sa.user_id AND t.opened_at >= NOW() - INTERVAL 24 HOUR) AS tax_opens_24h
         FROM sales_agents sa
         LEFT JOIN users s ON s.sales_agent_id = sa.user_id
        WHERE sa.user_id = ?
        GROUP BY sa.user_id, sa.code, sa.is_active, sa.link_opens`,
      [userId]
    );
    if (!row) return null;
    ['signups', 'consultants', 'companies', 'verified', 'tax_opens', 'tax_opens_24h'].forEach((k) => { row[k] = Number(row[k]); });
    return row;
  }

  /**
   * Everybody who signed up WITHOUT an agent's link — the exact complement of the agents'
   * counts, so the agents' sign-ups plus this row is every account. `viaReferrer` is called
   * out because those people did follow a link, a referrer's, and are not organic.
   */
  static async unattributed() {
    const [[row]] = await promisePool.query(
      `SELECT (SELECT COUNT(*) FROM users WHERE email NOT LIKE ?) AS all_accounts,
              COUNT(*) AS signups,
              COALESCE(SUM(u.is_consultant = 1), 0) AS consultants,
              COALESCE(SUM(u.is_company = 1), 0) AS companies,
              COALESCE(SUM(u.email_verified = 1), 0) AS verified,
              COALESCE(SUM(ra.referred_user_id IS NOT NULL), 0) AS via_referrer,
              COALESCE(SUM(u.created_at >= NOW() - INTERVAL 24 HOUR), 0) AS signups_24h
         FROM users u
         LEFT JOIN referral_attributions ra ON ra.referred_user_id = u.id
        WHERE u.sales_agent_id IS NULL AND u.email NOT LIKE ?`,
      // The admin panel's QA accounts signed up through nobody: they are not organic
      // sign-ups either, and counting them here would make the agents' share look smaller.
      [QA_EMAIL_LIKE, QA_EMAIL_LIKE]
    );
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
  }

  /** The accounts each agent brought in, newest first, capped per agent — one query. */
  static async peopleFor(agentIds, { perAgent = 50 } = {}) {
    const out = {};
    if (!agentIds.length) return out;
    const [rows] = await promisePool.query(
      `SELECT * FROM (
         SELECT u.sales_agent_id AS agent_id, u.id, u.name, u.email, u.created_at, u.is_active,
                u.is_consultant, u.is_company, u.email_verified,
                ${COUNTRY_SQL} AS country, ${COUNTRY_SOURCE_SQL} AS country_source,
                ROW_NUMBER() OVER (PARTITION BY u.sales_agent_id ORDER BY u.created_at DESC, u.id DESC) AS rn
           FROM users u ${COUNTRY_JOINS} WHERE u.sales_agent_id IN (?)
       ) ranked WHERE rn <= ?`,
      [agentIds, perAgent]
    );
    rows.forEach((r) => {
      (out[r.agent_id] = out[r.agent_id] || []).push(r);
    });
    return out;
  }

  /**
   * Where each agent's sign-ups are from, for every agent AND the "No agent link" bucket, in
   * ONE query. Keyed by agent user id; the no-link rows come back under `direct`, and
   * `overall` sums the agents only — it feeds a card about agent-link sign-ups, and folding
   * the no-link population into it would make that heading false.
   *
   * Every row is `{ code, count, fromIp }`: `code` is null for "Unknown", so the counts
   * always add up to the sign-up totals beside them. `fromIp` says how many of that country
   * were read from the sign-up address because the person has not stated one yet.
   */
  static async countriesByAgent() {
    const [rows] = await promisePool.query(
      `SELECT u.sales_agent_id AS agent_id, ${COUNTRY_SQL} AS code,
              COUNT(*) AS n, COALESCE(SUM(${COUNTRY_SOURCE_SQL} = 'ip'), 0) AS from_ip
         FROM users u ${COUNTRY_JOINS}
        GROUP BY u.sales_agent_id, ${COUNTRY_SQL}`,
      []
    );
    return SalesAgent.groupCountries(rows);
  }

  /** Pure: the grouping behind `countriesByAgent`, exported for the unit test. */
  static groupCountries(rows) {
    const byAgent = {};
    const direct = [];
    const overall = new Map();
    const add = (list, code, n, fromIp) => {
      const hit = list.find((r) => r.code === code);
      if (hit) { hit.count += n; hit.fromIp += fromIp; } else list.push({ code, count: n, fromIp });
    };
    rows.forEach((r) => {
      const code = r.code ? String(r.code).toUpperCase() : null;
      const n = Number(r.n) || 0;
      const fromIp = Number(r.from_ip) || 0;
      if (r.agent_id == null) { add(direct, code, n, fromIp); return; }
      add((byAgent[r.agent_id] = byAgent[r.agent_id] || []), code, n, fromIp);
      const o = overall.get(code) || { code, count: 0, fromIp: 0 };
      o.count += n; o.fromIp += fromIp;
      overall.set(code, o);
    });
    // Biggest first; Unknown last among equals so a real country is never hidden behind it.
    const order = (a, b) => (b.count - a.count) || ((a.code === null) - (b.code === null)) || String(a.code).localeCompare(String(b.code));
    Object.values(byAgent).forEach((list) => list.sort(order));
    direct.sort(order);
    return { byAgent, direct, overall: [...overall.values()].sort(order) };
  }
}

/*
 * A person's country: the one they STATED on a profile when there is one, otherwise the
 * country of the address they signed up from. Everywhere a profile is SHOWN, only the
 * country its owner stated appears, and that rule stands. Here the question
 * is where an agent's link reached, about people who mostly signed up minutes ago and have
 * stated nothing, so the sign-up address is the only answer there is — and every surface
 * that shows it says which of the two it was (`country_source`).
 */
const COUNTRY_JOINS = `LEFT JOIN consultant_profiles cp ON cp.user_id = u.id
         LEFT JOIN company_profiles comp ON comp.user_id = u.id`;
const COUNTRY_SQL = "NULLIF(COALESCE(NULLIF(cp.country, ''), NULLIF(comp.country, ''), u.signup_country), '')";
const COUNTRY_SOURCE_SQL = `CASE WHEN NULLIF(COALESCE(NULLIF(cp.country, ''), NULLIF(comp.country, '')), '') IS NOT NULL THEN 'stated'
              WHEN NULLIF(u.signup_country, '') IS NOT NULL THEN 'ip' ELSE NULL END`;

module.exports = SalesAgent;
