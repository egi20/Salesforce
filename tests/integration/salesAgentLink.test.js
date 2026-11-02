'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

const SalesAgent = require('../../models/SalesAgent');
const Referral = require('../../models/Referral');
const User = require('../../models/User');
const Token = require('../../models/Token');
const ConsultantProfile = require('../../models/ConsultantProfile');
const AppSetting = require('../../models/AppSetting');
const email = require('../../utils/email');
const { attachViewHelpers } = require('../../utils/viewHelpers');
const { notFound, errorHandler } = require('../../middleware/errorHandler');

/**
 * A sales agent's link over real HTTP: `/s/<code>` lands on sign-up with the code, counts a
 * PERSON once per session, never counts a link-preview fetcher, and the code reaches the
 * registration that follows — first touch, session before form.
 *
 * The models are spied rather than run, so no database is needed; what is under test is the
 * route's decisions, which are the part SAP Hub's agents were miscounted by. A plain HTTP
 * client sends no Sec-Fetch-Dest, which is what a navigation looks like.
 */
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const AGENT = { user_id: 7, code: 'ABCDEFGH', is_active: 1 };
const OTHER = { user_id: 8, code: 'HGFEDCBA', is_active: 1 };

function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  // One session per cookie-less test client would defeat "once per session", so the
  // session is keyed by a header the test chooses.
  const sessions = {};
  app.use((req, res, next) => {
    const id = req.get('x-test-session') || 'anon';
    sessions[id] = sessions[id] || {};
    req.session = sessions[id];
    req.flash = () => [];
    Object.assign(res.locals, {
      appName: 'Salesforce Hub', supportEmail: 's@x.test', currentUser: null, currentPath: req.path,
      csrfToken: 't', query: req.query, assistantEnabled: false, assistantMaxChars: 2000, linkedInEnabled: false,
      siteNotice: '', flash: { success: [], error: [], info: [] },
      seo: { title: 't', description: 'd', canonical: 'c', ogImage: 'o', indexable: false }
    });
    attachViewHelpers(res);
    next();
  });
  app.use('/', require('../../routes/index'));
  app.use('/auth', require('../../routes/auth'));
  app.use(notFound);
  app.use(errorHandler);
  app.sessions = sessions;
  return app;
}

beforeEach(() => {
  jest.spyOn(SalesAgent, 'findActiveByCode').mockImplementation(async (raw) => {
    const code = SalesAgent.normaliseCode(raw);
    return [AGENT, OTHER].find((a) => a.code === code) || null;
  });
  jest.spyOn(SalesAgent, 'countOpen').mockResolvedValue();
  jest.spyOn(AppSetting, 'get').mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());

describe('/s/:code', () => {
  it('lands on sign-up with the code, case-insensitively, and counts a person once per session', async () => {
    const app = buildApp();
    const first = await request(app).get('/s/abcdefgh').set('User-Agent', BROWSER).set('x-test-session', 'a');
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('/auth/register?a=ABCDEFGH');
    await request(app).get('/s/ABCDEFGH').set('User-Agent', BROWSER).set('x-test-session', 'a');
    expect(SalesAgent.countOpen).toHaveBeenCalledTimes(1);
    expect(app.sessions.a.salesAgentCode).toBe('ABCDEFGH');
  });

  it('never counts a link-preview fetcher or a client with no user agent, and still remembers the code', async () => {
    const app = buildApp();
    await request(app).get('/s/ABCDEFGH').set('User-Agent', 'WhatsApp/2.23.20.0 A').set('x-test-session', 'p');
    await request(app).get('/s/ABCDEFGH').set('User-Agent', 'LinkedInBot/1.0').set('x-test-session', 'q');
    await request(app).get('/s/ABCDEFGH').set('User-Agent', '').set('x-test-session', 'r');
    expect(SalesAgent.countOpen).not.toHaveBeenCalled();
    expect(app.sessions.p.salesAgentCode).toBe('ABCDEFGH');
  });

  it('counts somebody tapping the link inside the LinkedIn app', async () => {
    const app = buildApp();
    await request(app).get('/s/ABCDEFGH').set('x-test-session', 'li')
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.1');
    expect(SalesAgent.countOpen).toHaveBeenCalledWith(7);
  });

  it('keeps the first agent when a second link is opened later in the same session', async () => {
    const app = buildApp();
    await request(app).get('/s/ABCDEFGH').set('User-Agent', BROWSER).set('x-test-session', 'f');
    await request(app).get('/s/HGFEDCBA').set('User-Agent', BROWSER).set('x-test-session', 'f');
    expect(app.sessions.f.salesAgentCode).toBe('ABCDEFGH');
  });

  it('sends an unknown or paused code to sign-up without one, and remembers nothing', async () => {
    const app = buildApp();
    const res = await request(app).get('/s/NOTACODE').set('User-Agent', BROWSER).set('x-test-session', 'u');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/register');
    expect(app.sessions.u.salesAgentCode).toBeUndefined();
  });
});

describe('registration after an agent link', () => {
  function stubRegistration() {
    jest.spyOn(User, 'emailExists').mockResolvedValue(false);
    jest.spyOn(User, 'create').mockResolvedValue({ id: 99, email: 'new@x.test', name: 'New Person' });
    jest.spyOn(ConsultantProfile, 'ensureExists').mockResolvedValue({});
    jest.spyOn(Referral, 'attribute').mockResolvedValue(false);
    jest.spyOn(Token, 'issue').mockResolvedValue({ token: 'tok' });
    jest.spyOn(email, 'send').mockResolvedValue({ ok: true });
    jest.spyOn(SalesAgent, 'attribute').mockResolvedValue(true);
  }
  const form = (extra = {}) => ({
    name: 'New Person', email: 'new@x.test', password: 'Sup3rSecret', confirm_password: 'Sup3rSecret',
    user_types: 'consultant', terms: 'on', ...extra
  });

  it('carries the code into the form and credits the agent from the SESSION, not the posted field', async () => {
    stubRegistration();
    const app = buildApp();
    await request(app).get('/s/ABCDEFGH').set('User-Agent', BROWSER).set('x-test-session', 'reg');
    const page = await request(app).get('/auth/register?a=ABCDEFGH').set('x-test-session', 'reg');
    expect(page.text).toMatch(/name="a" value="ABCDEFGH"/);

    // A posted code naming somebody else does not take the sign-up.
    const res = await request(app).post('/auth/register').set('x-test-session', 'reg').type('form')
      .set('X-Forwarded-For', '203.0.113.9').send(form({ a: 'HGFEDCBA' }));
    expect(res.status).toBe(302);
    expect(SalesAgent.attribute).toHaveBeenCalledWith('ABCDEFGH', 99);
    expect(app.sessions.reg.salesAgentCode).toBeUndefined();
  });

  it('uses the posted code when an in-app browser lost the session, and nothing without one', async () => {
    stubRegistration();
    const app = buildApp();
    await request(app).post('/auth/register').set('x-test-session', 'inapp').type('form').send(form({ a: 'abcdefgh', email: 'a@x.test' }));
    expect(SalesAgent.attribute).toHaveBeenCalledWith('ABCDEFGH', 99);
    SalesAgent.attribute.mockClear();
    await request(app).post('/auth/register').set('x-test-session', 'none').type('form').send(form({ email: 'b@x.test' }));
    expect(SalesAgent.attribute).not.toHaveBeenCalled();
  });
});
