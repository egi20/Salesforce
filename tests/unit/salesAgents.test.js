'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (sql) => sql.replace(/^--.*$/gm, '');

/**
 * Sales agents: the rules that live in the source rather than in a request, so they cannot
 * be exercised by the route test without a database.
 */
describe('sales agents', () => {
  const admin = read('routes/admin.js');

  it('every agent screen and action is superadmin-only', () => {
    for (const route of ["'/referrals/agents/add',", "'/referrals/agents/:id/active',"]) {
      const at = admin.indexOf(route);
      expect(at).toBeGreaterThan(-1);
      expect(admin.slice(at, at + 80)).toMatch(/isSuperadmin,/);
    }
    // The tab is a mode of /admin/referrals, which is itself superadmin.
    expect(admin).toMatch(/'\/referrals',\s*\n\s*isSuperadmin,/);
  });

  it('is registered before /referrals/:id/..., which would 404 the word "agents"', () => {
    // requireIdParam answers a non-numeric id with a 404 instead of passing it on.
    expect(admin.indexOf("'/referrals/agents/:id/active'")).toBeLessThan(admin.indexOf("'/referrals/:id/payout'"));
    expect(admin.indexOf("'/referrals/agents/add'")).toBeLessThan(admin.indexOf("'/referrals/:id/payout'"));
  });

  it('attribution is first touch, and an agent cannot credit themselves', () => {
    const model = read('models/SalesAgent.js');
    expect(model).toMatch(/UPDATE users SET sales_agent_id = \? WHERE id = \? AND sales_agent_id IS NULL/);
    expect(model).toMatch(/agent\.user_id === newUserId/);
  });

  it('never touches the commission ledger: agents are measured, not paid', () => {
    expect(read('models/SalesAgent.js')).not.toMatch(/commission_ledger/);
  });

  it('the schema is two new migrations, DATETIME only, recording no address or agent string', () => {
    const sql = strip(read('scripts/migrations/031_sales_agents.sql') + read('scripts/migrations/032_sales_agent_opens.sql'));
    // CURRENT_TIMESTAMP is a default value; a TIMESTAMP column is the CLAUDE.md trap.
    expect(sql.replace(/CURRENT_TIMESTAMP/g, '')).not.toMatch(/TIMESTAMP/i);
    expect(sql).toMatch(/DATETIME/);
    expect(sql).not.toMatch(/\bip\b|user_agent|session_id/i);
  });

  it('the agent dashboard lists people without their email addresses', async () => {
    const ejs = require('ejs');
    const block = read('views/dashboard/index.ejs');
    const card = block.slice(block.indexOf('salesAgent) { %>'), block.indexOf("<% if (currentUser.isConsultant) { %>\n  <section>"));
    expect(card).toContain('salesAgent.people.forEach');
    expect(card).not.toMatch(/p\.email\b/);
    expect(typeof ejs.compile(block)).toBe('function');
  });
});
