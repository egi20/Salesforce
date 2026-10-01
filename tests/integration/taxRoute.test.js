'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

const { attachViewHelpers } = require('../../utils/viewHelpers');

const { notFound, errorHandler } = require('../../middleware/errorHandler');
const TaxEnquiry = require('../../models/TaxEnquiry');
const email = require('../../utils/email');
const { RETENTION_DAYS } = require('../../config/taxAdvisory');

/**
 * The tax advisory pages, over real HTTP.
 *
 * The assertions that matter most here are about what the pages DO NOT do: there is no
 * calculate endpoint, the form asks for no financial figure, and a submission that carries
 * one anyway does not reach the model. Everything else is ordinary form behaviour.
 */
function buildApp({ user = null } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false }));

  const flashed = { success: [], error: [], info: [] };
  app.locals.flashed = flashed;

  app.use((req, res, next) => {
    req.session = user ? { user } : {};
    req.flash = (type, message) => {
      if (message === undefined) return flashed[type] || [];
      flashed[type].push(message);
      return undefined;
    };
    res.locals.appName = 'Salesforce Hub';
    res.locals.supportEmail = 'support@example.com';
    res.locals.currentUser = user;
    res.locals.currentPath = req.path;
    res.locals.csrfToken = 'token';
    res.locals.query = req.query;
    res.locals.assistantEnabled = false;
    res.locals.assistantMaxChars = 2000;
    res.locals.linkedInEnabled = false;
    res.locals.siteNotice = '';
    res.locals.flash = flashed;
    // The real helpers, from the one list the server uses — a hand-written stub per
    // helper meant adding one broke this file with "x is not defined" from a partial.
    attachViewHelpers(res);
    res.locals.seo = {
      title: 't', description: 'd', canonical: 'http://x/tax-advisory', ogImage: 'http://x/o.png', indexable: true
    };
    next();
  });

  app.use('/tax-advisory', require('../../routes/tax'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

/**
 * A distinct source address per test.
 *
 * The enquiry limiter is created once when `routes/tax.js` is required, so every test in
 * this file shares one counter. Without a fresh IP per test the fifth request anywhere in
 * the file starts refusing — and a refusal REDIRECTS (302 to `/`), which looks exactly
 * like success if you only assert the status code. That is a real property of
 * `ipLimiter`, not a testing artefact: a browser navigation gets a flash and a redirect,
 * never a bare 429.
 */
let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function submit(app, body, ip = nextIp()) {
  return request(app).post('/tax-advisory/enquire').set('X-Forwarded-For', ip).type('form').send(body);
}

const GOOD = {
  full_name: 'Arta Krasniqi',
  email: 'arta@example.com',
  country: 'AL',
  arrangement: 'freelance',
  topic: 'cross_border',
  question: 'I work for clients in Germany and Ireland and I am not sure how I should be set up.',
  consent: 'on'
};

describe('the tax advisory pages', () => {
  afterEach(() => jest.restoreAllMocks());

  it('renders the service page and states what it will not do', async () => {
    const res = await request(buildApp()).get('/tax-advisory');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Calculate your tax/);
    expect(res.text).toMatch(new RegExp(`${RETENTION_DAYS} days`));
    // The honest alternative to a savings calculator is offered by name.
    expect(res.text).toMatch(/rates\/calculator/);
  });

  it('shows no field asking what anyone earns', async () => {
    const res = await request(buildApp()).get('/tax-advisory/enquire');

    expect(res.status).toBe(200);
    // The reference's form has all of these. Each one is a financial or employment detail
    // collected from an anonymous visitor before anybody has agreed to anything.
    for (const name of [
      'gross', 'net_monthly', 'salary', 'current_employer', 'notice_period',
      'current_tax_rate', 'has_vat_number', 'desired_daily_rate', 'estimated'
    ]) {
      expect(res.text).not.toMatch(new RegExp(`name="[^"]*${name}`, 'i'));
    }
  });

  it('has no calculate endpoint', async () => {
    const res = await request(buildApp()).post('/tax-advisory/calculate').send({ grossSalary: 6000, netSalary: 3400 });
    expect(res.status).toBe(404);
  });

  it('records a valid enquiry and confirms it', async () => {
    const create = jest.spyOn(TaxEnquiry, 'create').mockResolvedValue({
      id: 7, created: true, email: GOOD.email, fullName: GOOD.full_name
    });
    const send = jest.spyOn(email, 'send').mockResolvedValue({ delivered: false });

    const app = buildApp();
    const res = await submit(app, GOOD);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/tax-advisory');
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: GOOD.email }));
    expect(app.locals.flashed.success[0]).toMatch(/introduce you/i);
  });

  it('does not pass a financial field through even when one is submitted', async () => {
    const create = jest.spyOn(TaxEnquiry, 'create').mockResolvedValue({
      id: 8, created: true, email: GOOD.email, fullName: GOOD.full_name
    });
    jest.spyOn(email, 'send').mockResolvedValue({ delivered: false });

    await submit(buildApp(), {
      ...GOOD,
      current_gross_monthly: '6000',
      estimated_monthly_savings: '2000',
      currentEmployer: 'Some GmbH'
    });

    // The shape of the call IS the assertion, exactly as in the search route's test: the
    // handler reads named fields rather than spreading the body, so a field it does not
    // know about cannot reach the model by being added to a form.
    expect(Object.keys(create.mock.calls[0][0]).sort()).toEqual(
      ['arrangement', 'consent', 'consentVersion', 'country', 'email', 'fullName', 'phone', 'question', 'topic'].sort()
    );
  });

  it('re-renders with the answer intact when consent is missing', async () => {
    // `create` is NOT mocked: validation lives in `normaliseSubmission`, which it calls
    // before it opens a transaction, so the real refusal is what is under test here.
    const send = jest.spyOn(email, 'send').mockResolvedValue({ delivered: false });
    const { consent, ...withoutConsent } = GOOD;
    expect(consent).toBe('on');

    const res = await submit(buildApp(), withoutConsent);

    expect(res.status).toBe(400);
    expect(res.text).toMatch(/agreement/i);
    // Nobody retypes a long answer because they missed a checkbox.
    expect(res.text).toMatch(/Germany and Ireland/);
    // Nothing was recorded, so nothing was confirmed.
    expect(send).not.toHaveBeenCalled();
  });

  it('escapes what it echoes back on a failed submission', async () => {
    const res = await submit(buildApp(), {
      ...GOOD,
      consent: '',
      question: '<script>alert(1)</script> and a long enough tail to pass'
    });

    expect(res.status).toBe(400);
    expect(res.text).not.toMatch(/<script>alert/);
  });

  it('prefills a signed-in visitor, and only with their name and address', async () => {
    const res = await request(buildApp({ user: { id: 3, name: 'Arta Krasniqi', email: 'arta@example.com' } }))
      .get('/tax-advisory/enquire');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/value="Arta Krasniqi"/);
    expect(res.text).toMatch(/value="arta@example.com"/);
  });

  it('attributes the enquiry to the signed-in account, and to nobody when anonymous', async () => {
    const create = jest.spyOn(TaxEnquiry, 'create').mockResolvedValue({
      id: 9, created: true, email: GOOD.email, fullName: GOOD.full_name
    });
    jest.spyOn(email, 'send').mockResolvedValue({ delivered: false });

    await submit(buildApp({ user: { id: 42, name: 'A', email: 'a@example.com' } }), GOOD);
    expect(create.mock.calls[0][1]).toEqual({ userId: 42 });

    await submit(buildApp(), GOOD);
    expect(create.mock.calls[1][1]).toEqual({ userId: null });
  });

  it('tells a repeat sender that their open enquiry was updated, not duplicated', async () => {
    jest.spyOn(TaxEnquiry, 'create').mockResolvedValue({
      id: 7, created: false, email: GOOD.email, fullName: GOOD.full_name
    });
    jest.spyOn(email, 'send').mockResolvedValue({ delivered: false });

    const app = buildApp();
    await submit(app, GOOD);

    expect(app.locals.flashed.success[0]).toMatch(/already had open/i);
  });

  it('surfaces a database failure as an error, not as a form validation message', async () => {
    // A code-shaped error from a driver (`ECONNREFUSED`, `ER_LOCK_WAIT_TIMEOUT`) must not
    // be caught by the validation branch: the visitor would be told to fix their form,
    // and the outage would never reach the error log.
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('connect ECONNREFUSED');
    err.code = 'ECONNREFUSED';
    jest.spyOn(TaxEnquiry, 'create').mockRejectedValue(err);

    const res = await submit(buildApp(), GOOD);
    expect(res.status).toBe(500);
  });

  it('still records the enquiry when the confirmation email fails', async () => {
    // `utils/email.js` returns failures rather than throwing precisely so this holds: the
    // enquiry is already written, and a mail server having a bad afternoon must not lose it.
    jest.spyOn(TaxEnquiry, 'create').mockResolvedValue({
      id: 10, created: true, email: GOOD.email, fullName: GOOD.full_name
    });
    jest.spyOn(email, 'send').mockResolvedValue({ delivered: false, error: 'no-api-key' });

    const res = await submit(buildApp(), GOOD);
    expect(res.status).toBe(302);
  });

  it('rate limits an anonymous sender', async () => {
    jest.spyOn(TaxEnquiry, 'create').mockResolvedValue({
      id: 11, created: true, email: GOOD.email, fullName: GOOD.full_name
    });
    jest.spyOn(email, 'send').mockResolvedValue({ delivered: false });

    const app = buildApp();
    const ip = nextIp();
    const destinations = [];
    for (let i = 0; i < 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await submit(app, GOOD, ip);
      destinations.push(res.headers.location);
    }

    // Asserted on the DESTINATION, not the status. A refused navigation is also a 302 —
    // `ipLimiter` flashes and redirects rather than answering a bare 429, because that is
    // what every other failed guard in this app does for a top-level navigation.
    expect(destinations.filter((d) => d === '/tax-advisory')).toHaveLength(5);
    expect(destinations.slice(5)).toEqual(['/', '/']);
    expect(app.locals.flashed.error.some((m) => /several enquiries/i.test(m))).toBe(true);
  });
});
