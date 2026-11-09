'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const Referral = require('../../models/Referral');
const SalesAgent = require('../../models/SalesAgent');
const AgentLead = require('../../models/AgentLead');
const { attachViewHelpers } = require('../../utils/viewHelpers');
const { notFound, errorHandler } = require('../../middleware/errorHandler');
const { promisePool } = require('../../config/database');

/**
 * /referrals and /referrals/agent over real HTTP, models stubbed. A plain HTTP client sends
 * no Sec-Fetch-Dest, so a refused guard answers as a navigation (302).
 */
const MEMBER = { id: 7, name: 'Ana B', email: 'a@example.com', isConsultant: true, emailVerified: true };
const AGENT_USER = { id: 33, name: 'Sam Agent', email: 's@example.com', isConsultant: true, emailVerified: true, isSalesAgent: true };
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

function buildApp(user) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  const session = user ? { user } : {};
  app.use((req, res, next) => {
    req.session = session;
    req.flash = () => [];
    Object.assign(res.locals, {
      appName: 'Salesforce Hub', supportEmail: 's@example.com', currentUser: user, currentPath: req.path,
      csrfToken: 'token', query: req.query, assistantEnabled: false, assistantMaxChars: 2000,
      linkedInEnabled: false, siteNotice: '', flash: { success: [], error: [], info: [] },
      seo: { title: 't', description: 'd', canonical: 'http://x/r', ogImage: 'http://x/o.png', indexable: false }
    });
    attachViewHelpers(res);
    next();
  });
  app.use('/referrals', require('../../routes/referrals'));
  app.use(notFound);
  app.use(errorHandler);
  app.session = session;
  return app;
}

const REFERRER = { id: 1, user_id: 7, code: 'X4Z3T9YA', rate_bps: 1000, is_active: 1, payout_method: 'paypal', payout_reference: null, created_at: new Date('2026-11-05') };

function stubReferrer() {
  jest.spyOn(Referral, 'findByUserId').mockResolvedValue(REFERRER);
  jest.spyOn(Referral, 'balanceFor').mockResolvedValue({ unpaidMinor: 1200, lifetimeEarnedMinor: 3400, lifetimePaidMinor: 2200, payable: false, minPayoutMinor: 5000 });
  jest.spyOn(Referral, 'linkStatsFor').mockResolvedValue({ opens: 8, signups: 2, verified: 1, signupRatePct: 25 });
  jest.spyOn(Referral, 'earningsByProduct').mockResolvedValue(new Map([['quote_deposit', { count: 1, earnedMinor: 3400 }]]));
  jest.spyOn(Referral, 'payoutsFor').mockResolvedValue([]);
}

afterEach(() => jest.restoreAllMocks());

describe('GET /referrals', () => {
  it('shows the link with copy and share, counts only, icons, and introductions as date and role', async () => {
    stubReferrer();
    jest.spyOn(Referral, 'introductionsFor').mockResolvedValue([
      { id: 9, created_at: new Date('2026-11-05'), earns_until: new Date('2027-11-05'), is_consultant: 1, is_company: 0, earned_minor: 3400 }
    ]);
    const res = await request(buildApp(MEMBER)).get('/referrals');
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-copy="http://localhost:3000/referrals/go/X4Z3T9YA"'.replace('http://localhost:3000', require('../../config/config').app.baseUrl));
    expect(res.text).toMatch(/linkedin\.com\/sharing\/share-offsite/);
    expect(res.text).toMatch(/href="mailto:\?subject=/);
    expect(res.text).toMatch(/Unique opens[\s\S]*Signed up[\s\S]*Sign-up rate[\s\S]*Verified email/);
    expect(res.text).toMatch(/25%/);
    expect(res.text).toMatch(/Date joined[\s\S]*Role[\s\S]*Earned/);
    expect(res.text).toMatch(/Consultant/);
    expect(res.text).toMatch(/Quote deposits[\s\S]*× 1/);
    expect(res.text).toMatch(/>PayPal</);
    expect(res.text).toMatch(/class="btn btn-primary w-100" type="submit">Save/);
    expect(res.text).toMatch(/Earning window[\s\S]*365 days/);
  });

  it('never names, addresses or locates an introduction', () => {
    // The query behind the table selects role flags from users and nothing else of theirs.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'models', 'Referral.js'), 'utf8');
    const q = src.slice(src.indexOf('static async introductionsFor'), src.indexOf('static async linkStatsFor'));
    expect(q).not.toMatch(/u\.(name|email|signup_country|country)/);
    const view = fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'referrals', 'dashboard.ejs'), 'utf8');
    expect(view).not.toMatch(/\.(email|name|country|signup_country)\b/);
  });

  it('the Earnings tab is the ledger', async () => {
    stubReferrer();
    jest.spyOn(Referral, 'ledgerFor').mockResolvedValue({ rows: [{ id: 1, created_at: new Date(), entry_type: 'earned', amount_minor: 0, currency: 'EUR', note: 'job_feature — not a commissionable product', payout_id: null }], total: 1 });
    const res = await request(buildApp(MEMBER)).get('/referrals?tab=earnings');
    expect(res.text).toMatch(/Date[\s\S]*Source[\s\S]*Amount[\s\S]*Status/);
    expect(res.text).toMatch(/no commission/);
    expect(res.text).toMatch(/class="nav-link active" href="\/referrals\?tab=earnings"/);
  });
});

describe('GET /referrals/go/:code counts people, once per session', () => {
  it('counts a browser once and a preview fetcher never', async () => {
    jest.spyOn(Referral, 'findByCode').mockResolvedValue({ ...REFERRER });
    const counted = jest.spyOn(Referral, 'countOpen').mockResolvedValue();
    const app = buildApp(null);
    await request(app).get('/referrals/go/X4Z3T9YA').set('User-Agent', BROWSER);
    await request(app).get('/referrals/go/X4Z3T9YA').set('User-Agent', BROWSER);
    await request(app).get('/referrals/go/X4Z3T9YA').set('User-Agent', 'LinkedInBot/1.0');
    expect(counted).toHaveBeenCalledTimes(1);
  });
});

describe('GET /referrals/agent', () => {
  const AGENT_ROW = { user_id: 33, code: '9H5SXC27', is_active: 1, department: 'Partnerships', commission_bps: 750, monthly_target: 4, created_at: new Date('2026-11-01') };
  function stubAgent() {
    jest.spyOn(SalesAgent, 'activeAgentFor').mockResolvedValue(AGENT_ROW);
    jest.spyOn(SalesAgent, 'statsFor').mockResolvedValue({ code: '9H5SXC27', is_active: 1, link_opens: 10, signups: 3, consultants: 1, companies: 2, verified: 2 });
    jest.spyOn(AgentLead, 'summaryFor').mockResolvedValue({ byStage: { new: 1, contacted: 0, qualified: 0, proposal: 0, negotiation: 0, won: 2, lost: 1 }, total: 4, won: 2, winRatePct: 67, valueMinor: 4400000, wonThisMonth: 1 });
    jest.spyOn(AgentLead, 'list').mockResolvedValue({ rows: [{ id: 5, company: 'Vela', contact_name: 'Marta', email: null, source: 'linkedin', estimated_value_minor: 2400000, stage: 'won', next_step_on: null }], total: 1 });
    jest.spyOn(SalesAgent, 'earningsFor').mockResolvedValue({ byProduct: new Map([['quote_deposit', { count: 1, paidMinor: 100000, commissionMinor: 7500 }]]), totalMinor: 7500 });
    jest.spyOn(SalesAgent, 'peopleForAgent').mockResolvedValue({ rows: [
      { id: 1, email: 'new@x.test', created_at: new Date(), is_active: 1, is_consultant: 0, is_company: 1, email_verified: 1, country: 'PL', country_source: 'stated' },
      { id: 2, email: null, created_at: new Date(), is_active: 1, is_consultant: 1, is_company: 0, email_verified: 0, country: null, country_source: null }
    ], total: 2 });
  }

  it('answers 404 to an account that is not an active agent', async () => {
    jest.spyOn(SalesAgent, 'activeAgentFor').mockResolvedValue(null);
    expect((await request(buildApp(MEMBER)).get('/referrals/agent')).status).toBe(404);
  });

  it('renders the dashboard from the admin-set terms', async () => {
    stubAgent();
    const res = await request(buildApp(AGENT_USER)).get('/referrals/agent');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Sales agent dashboard/);
    expect(res.text).toMatch(/Partnerships/);
    expect(res.text).toMatch(/AGT-9H5SXC27/);
    expect(res.text).toMatch(/1 consultant · 2 companies · 2 verified their email/);
    expect(res.text).toMatch(/Total leads[\s\S]*Won deals[\s\S]*Win rate[\s\S]*Total value/);
    for (const label of ['New', 'Contacted', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost']) expect(res.text).toContain(`<span class="agent-stage-label">${label}</span>`);
    expect(res.text).toMatch(/1 \/ 4<\/strong> deals this month/);
    expect(res.text).toMatch(/SOW quote[\s\S]*× 1[\s\S]*€75\.00/);
    expect(res.text).toMatch(/Tax optimization[\s\S]*Not paid through the Hub yet/);
    expect(res.text).toMatch(/7\.5%/);
    expect(res.text).toMatch(/new@x\.test/);
    expect(res.text).toMatch(/Email not shared/);
    expect(res.text).toMatch(/2 people/);
  });

  it('keeps a refused lead in the reopened modal', async () => {
    stubAgent();
    const create = jest.spyOn(AgentLead, 'create').mockResolvedValue(1);
    const res = await request(buildApp(AGENT_USER)).post('/referrals/agent/leads').type('form').send('company=Vela&source=nope&stage=new&email=bad');
    expect(res.status).toBe(422);
    expect(create).not.toHaveBeenCalled();
    expect(res.text).toMatch(/data-open-on-load/);
    expect(res.text).toMatch(/value="Vela"/);
    expect(res.text).toMatch(/Choose where the lead came from/);
  });

  it('adds a valid lead for the signed-in agent only', async () => {
    stubAgent();
    const create = jest.spyOn(AgentLead, 'create').mockResolvedValue(1);
    const res = await request(buildApp(AGENT_USER)).post('/referrals/agent/leads').type('form').send('company=Vela&source=linkedin&stage=proposal&estimated_value=12000');
    expect(res.status).toBe(302);
    expect(create).toHaveBeenCalledWith(33, expect.objectContaining({ company: 'Vela', stage: 'proposal', estimatedValueMinor: 1200000 }));
  });

  it('moves a stage scoped to the agent', async () => {
    stubAgent();
    const move = jest.spyOn(AgentLead, 'setStage').mockResolvedValue(true);
    await request(buildApp(AGENT_USER)).post('/referrals/agent/leads/5/stage').type('form').send('stage=won');
    expect(move).toHaveBeenCalledWith(33, 5, 'won');
  });
});

describe('agent terms and commission', () => {
  it('parses admin terms and refuses what is out of range', () => {
    expect(SalesAgent.parseTerms({ department: 'Sales', commission_pct: '7.5', monthly_target: '12' })).toEqual({ ok: true, department: 'Sales', commissionBps: 750, monthlyTarget: 12 });
    expect(SalesAgent.parseTerms({}).commissionBps).toBeNull();
    expect(SalesAgent.parseTerms({ commission_pct: '45' }).ok).toBe(false);
    expect(SalesAgent.parseTerms({ commission_pct: 'ten' }).ok).toBe(false);
    expect(SalesAgent.parseTerms({ monthly_target: '-1' }).ok).toBe(false);
  });

  it('credits an agreed rate on an agent product, snapshot on the row, and never throws', async () => {
    const q = jest.spyOn(promisePool, 'query')
      .mockResolvedValueOnce([[{ agent_id: 33, commission_bps: 750, joined_at: new Date() }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const out = await SalesAgent.credit({ id: 90, user_id: 5, product: 'quote_deposit', amount_minor: 100000, currency: 'EUR' });
    expect(out).toEqual({ credited: 7500, reason: 'credited' });
    expect(q.mock.calls[1][1]).toEqual([33, 90, 'quote_deposit', 100000, 750, 7500, 'EUR']);
  });

  it('earns nothing without an agreed rate, on a job post, or when the database fails', async () => {
    jest.spyOn(promisePool, 'query').mockResolvedValueOnce([[{ agent_id: 33, commission_bps: null, joined_at: new Date() }]]);
    expect((await SalesAgent.credit({ id: 1, user_id: 5, product: 'quote_deposit', amount_minor: 100 })).reason).toBe('no agreed rate');
    expect((await SalesAgent.credit({ id: 1, user_id: 5, product: 'job_feature', amount_minor: 100 })).reason).toBe('not an agent product');
    jest.spyOn(promisePool, 'query').mockRejectedValueOnce(new Error('down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await SalesAgent.credit({ id: 1, user_id: 5, product: 'quote_deposit', amount_minor: 100 })).reason).toBe('error');
  });

  it('is called from fulfilment beside the referral credit', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'paymentFulfilment.js'), 'utf8');
    expect(src).toMatch(/await Referral\.credit\(settled\);[\s\S]{0,300}await SalesAgent\.credit\(settled\);/);
  });

  it('keeps leads with the agent: purged on erasure, exported on request', () => {
    const { PURGE } = require('../../models/AccountErasure');
    const { OWNED } = require('../../services/dataExport');
    expect(PURGE).toContain('sales_agent_leads');
    expect(OWNED.sales_agent_leads).toBe('user_id');
    expect(OWNED.agent_commission_ledger).toBe('user_id');
  });
});
