'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

const { attachViewHelpers } = require('../../utils/viewHelpers');
const { notFound, errorHandler } = require('../../middleware/errorHandler');
const RateSubmission = require('../../models/RateSubmission');
const Job = require('../../models/Job');
const Application = require('../../models/Application');
const TaxProgram = require('../../models/TaxProgram');

/**
 * /rates over real HTTP, with the data layer stubbed: these tests are about what the page
 * shows and what the share form accepts. A plain HTTP client sends no Sec-Fetch-Dest, so a
 * refused guard answers as a navigation (302), never as JSON.
 */
const CONSULTANT = { id: 7, name: 'C', email: 'c@example.com', isConsultant: true, emailVerified: true };

function buildApp({ user = null } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
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
    Object.assign(res.locals, {
      appName: 'Salesforce Hub', supportEmail: 's@example.com', currentUser: user, currentPath: req.path,
      csrfToken: 'token', query: req.query, assistantEnabled: false, assistantMaxChars: 2000,
      linkedInEnabled: false, siteNotice: '', flash: flashed,
      seo: { title: 'Rate & Salary Index', description: 'd', canonical: 'http://x/rates', ogImage: 'http://x/o.png', indexable: true }
    });
    attachViewHelpers(res);
    next();
  });
  app.use('/rates', require('../../routes/rates'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

const SUPPRESSED = { contributors: 1, suppressed: true, median: null, p25: null, p75: null, min: null, max: null };
const PUBLISHED = { contributors: 5, suppressed: false, median: 800, p25: 700, p75: 900, min: 600, max: 1000 };

function stubData({ hero = PUBLISHED, asked = [] } = {}) {
  jest.spyOn(RateSubmission, 'totalContributors').mockResolvedValue(24);
  jest.spyOn(RateSubmission, 'summary').mockImplementation(async (f) => (f.role ? SUPPRESSED : hero));
  jest.spyOn(RateSubmission, 'byRole').mockResolvedValue([
    { role: 'cpq-consultant', ...PUBLISHED },
    { role: 'sales-cloud', ...SUPPRESSED }
  ]);
  jest.spyOn(RateSubmission, 'bySeniority').mockResolvedValue([{ seniority: 'senior', ...PUBLISHED }]);
  jest.spyOn(RateSubmission, 'byRegion').mockResolvedValue([{ region: 'western-europe', ...PUBLISHED }]);
  jest.spyOn(RateSubmission, 'trendWindow').mockResolvedValue([
    { period: '2026-09', value: 780, contributors: 4, suppressed: false },
    { period: '2026-10', value: null, contributors: 2, suppressed: true },
    { period: '2026-11', value: 800, contributors: 5, suppressed: false }
  ]);
  jest.spyOn(Application, 'askedDayRates').mockResolvedValue(asked);
  jest.spyOn(Job, 'rateRows').mockResolvedValue([]);
  jest.spyOn(Job, 'facetByRole').mockResolvedValue([{ role: 'tableau-consultant', count: 9 }]);
  jest.spyOn(TaxProgram, 'topConsultantCountries').mockResolvedValue(['DE', 'NL']);
}

afterEach(() => jest.restoreAllMocks());

describe('GET /rates', () => {
  it('renders every section, labelled by what kind of figure it shows', async () => {
    stubData();
    const res = await request(buildApp()).get('/rates');
    expect(res.status).toBe(200);
    for (const text of ['Rate &amp; Salary Index', '24</strong> contributors', '€800</strong> median day rate', 'Benchmark my rate',
      'Market rate trend', 'Rates by role', 'Community rate index', 'Day rate budgets (contract jobs)',
      'Annual salaries (permanent positions)', 'Rate benchmarks by role', 'Methodology &amp; data quality']) {
      expect(res.text).toContain(text);
    }
    expect(res.text).toMatch(/Editorial model/);
    expect(res.text).toMatch(/Community data/);
  });

  it('hides the median pill when the all-roles bucket is below the threshold', async () => {
    stubData({ hero: { ...SUPPRESSED, contributors: 2 } });
    const res = await request(buildApp()).get('/rates');
    expect(res.text).not.toMatch(/median day rate/);
    expect(res.text).toMatch(/contributors/);
  });

  it('shows a suppressed group as "Not enough data" with its count', async () => {
    stubData();
    const res = await request(buildApp()).get('/rates');
    expect(res.text).toMatch(/Sales Cloud Consultant[\s\S]*?Not enough data[\s\S]*?<td class="text-end">1<\/td>/);
  });

  it('draws the trend with a gap where a period is below the threshold', async () => {
    stubData();
    const res = await request(buildApp()).get('/rates');
    // Two published points either side of a gap: two separate dots, no line through the gap.
    expect(res.text).not.toMatch(/<polyline class="median-line"/);
    expect((res.text.match(/class="median-dot"/g) || []).length).toBe(2);
    expect(res.text).toMatch(/2026-10: 2 contributors — not enough to publish/);
  });

  it('says the trend has not started rather than drawing one dot, from the first period with data', async () => {
    stubData();
    RateSubmission.trendWindow.mockResolvedValue([
      { period: '2026-01', value: null, contributors: 0, suppressed: true },
      { period: '2026-10', value: null, contributors: 0, suppressed: true },
      { period: '2026-11', value: 753, contributors: 24, suppressed: false }
    ]);
    const res = await request(buildApp()).get('/rates');
    expect(res.text).toMatch(/Trend appears after two months of data/);
    expect(res.text).toMatch(/Nov 26: median €753 from 24 contributors/);
    expect(res.text).not.toMatch(/Jan 26/);
    expect(res.text).not.toMatch(/class="rates-chart"/);
  });

  it('shows ten role chips, the busiest first, and keeps the rest behind All roles', async () => {
    stubData();
    const res = await request(buildApp()).get('/rates');
    const section = res.text.slice(res.text.indexOf('id="roles"'), res.text.indexOf('id="methodology"'));
    const [top, rest] = section.split('All roles →');
    expect((top.match(/class="rates-chip[ "]/g) || []).length).toBe(10);
    // Tableau has the jobs and CPQ the contributors, so both lead.
    expect(top.indexOf('Tableau')).toBeLessThan(top.indexOf('CPQ'));
    expect((rest.match(/class="rates-chip[ "]/g) || []).length).toBeGreaterThan(20);
  });

  it('tells the two community forms apart and applies the filters without a Go button', async () => {
    stubData();
    const res = await request(buildApp()).get('/rates');
    expect(res.text).toMatch(/Share your rate<\/h3>/);
    expect(res.text).toMatch(/<form class="rates-card mb-3 rates-autosubmit"[^>]*>\s*<h3[^>]*>[\s\S]*?Filter the index/);
    expect(res.text).not.toMatch(/>Go<\/button>/);
  });

  it('benchmarks a scenario from the query string and says when there is no community comparison', async () => {
    stubData();
    const res = await request(buildApp()).get('/rates?b_role=cpq-consultant&b_exp=senior&b_region=western-europe&b_certs=3&b_skills=2&b_mode=hybrid&b_industry=financial-services');
    expect(res.text).toMatch(/€955<\/strong>/);
    expect(res.text).toMatch(/Low confidence/);
    expect(res.text).toMatch(/Not enough community data/);
    expect(res.text).toMatch(/\/rates\/calculator\?dayRate=955/);
    expect(res.text).toMatch(/before employer contributions/);
  });

  it('carries other forms\' state, and only validated values', async () => {
    stubData();
    const res = await request(buildApp()).get('/rates?t_window=12w&role=cpq-consultant&j_days=%22%3E%3Cscript%3E');
    expect(res.text).toMatch(/<input type="hidden" name="t_window" value="12w">/);
    expect(res.text).not.toMatch(/name="j_days" value="/);
    expect(res.text).not.toMatch(/"><script>/);
  });

  it('shows the asked-on-applications mean only from three people', async () => {
    stubData({ asked: [{ user_id: 1, day_rate: 600, currency: 'EUR' }, { user_id: 2, day_rate: 700, currency: 'EUR' }] });
    let res = await request(buildApp()).get('/rates');
    expect(res.text).toMatch(/not shown until at least 3 consultants/);
    jest.restoreAllMocks();
    stubData({ asked: [{ user_id: 1, day_rate: 600, currency: 'EUR' }, { user_id: 2, day_rate: 700, currency: 'EUR' }, { user_id: 3, day_rate: 800, currency: 'EUR' }] });
    res = await request(buildApp()).get('/rates');
    expect(res.text).toMatch(/Asked on applications: <strong>€700\/day<\/strong>/);
  });

  it('lists the commonest countries first', async () => {
    stubData();
    const res = await request(buildApp()).get('/rates');
    const top = res.text.match(/<optgroup label="Where most consultants on the Hub live">([\s\S]*?)<\/optgroup>/)[1];
    expect([...top.matchAll(/value="([A-Z]{2})"/g)].map((m) => m[1])).toEqual(['DE', 'NL']);
  });
});

describe('sharing a rate', () => {
  it('moves the old submit page to the inline form', async () => {
    const res = await request(buildApp({ user: CONSULTANT })).get('/rates/submit');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/rates#share');
  });

  it('derives the seniority from the years and stores no country when none is given', async () => {
    stubData();
    const submit = jest.spyOn(RateSubmission, 'submit').mockResolvedValue({ period: '2026-11', amountEur: 850 });
    const res = await request(buildApp({ user: CONSULTANT })).post('/rates/submit').type('form')
      .send({ role: 'cpq-consultant', engagement_type: 'contract', amount: '850', years: '7', country: '' });
    expect(res.status).toBe(302);
    expect(submit).toHaveBeenCalledWith(7, expect.objectContaining({
      role: 'cpq-consultant', seniority: 'senior', engagementType: 'contract', country: null, workMode: null, currency: 'EUR', amount: 850
    }));
  });

  it('refuses an annual figure typed as a day rate, keeping the answers', async () => {
    stubData();
    const submit = jest.spyOn(RateSubmission, 'submit');
    const res = await request(buildApp({ user: CONSULTANT })).post('/rates/submit').type('form')
      .send({ role: 'cpq-consultant', engagement_type: 'contract', amount: '95000', years: '7', country: 'DE' });
    expect(res.status).toBe(422);
    expect(res.text).toMatch(/If that is a yearly figure, choose Permanent/);
    expect(res.text).toMatch(/name="amount"[^>]*value="95000"/);
    expect(submit).not.toHaveBeenCalled();
  });

  it('sends a visitor to sign in rather than accepting a figure', async () => {
    const res = await request(buildApp()).post('/rates/submit').type('form').send({ role: 'cpq-consultant' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/login/);
  });
});
