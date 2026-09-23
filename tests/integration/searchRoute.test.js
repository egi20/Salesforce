'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

const { notFound, errorHandler } = require('../../middleware/errorHandler');
const Job = require('../../models/Job');
const Post = require('../../models/Post');
const ConsultantProfile = require('../../models/ConsultantProfile');
const CompanyProfile = require('../../models/CompanyProfile');

/**
 * The search page, over real HTTP.
 *
 * What is pinned here is that the page RENDERS in every state a visitor can reach: no
 * query, a query too short, results, no results, and one source down. A search box is the
 * most-linked page on a site and the one people arrive at with the strangest query strings.
 */
function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    req.session = {};
    req.flash = () => {};
    res.locals.appName = 'Salesforce Hub';
    res.locals.supportEmail = 'support@example.com';
    res.locals.currentUser = null;
    res.locals.currentPath = req.path;
    res.locals.csrfToken = 'token';
    res.locals.query = req.query;
    res.locals.assistantEnabled = false;
    res.locals.assistantMaxChars = 2000;
    res.locals.linkedInEnabled = false;
    res.locals.siteNotice = '';
    res.locals.flash = { success: [], error: [], info: [] };
    res.locals.toPlainText = (value, max) => String(value || '').slice(0, max || 200);
    res.locals.roleLabel = (slug) => slug;
    res.locals.moduleLabel = (slug) => slug;
    res.locals.familyLabel = (slug) => slug;
    res.locals.sanitizeRichText = (html) => html;
    res.locals.jsonForScript = (value) => JSON.stringify(value);
    res.locals.seo = {
      title: 't', description: 'd', canonical: 'http://x/search', ogImage: 'http://x/o.png', indexable: false
    };
    next();
  });

  app.use('/search', require('../../routes/search'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function stubAll({ jobs = 0, consultants = 0, companies = 0, posts = 0 } = {}) {
  jest.spyOn(Job, 'browse').mockResolvedValue({
    rows: Array.from({ length: Math.min(jobs, 5) }, (_, i) => ({
      id: i + 1, title: `Job ${i}`, slug: `job-${i}`, role: 'apex-developer', seniority: 'senior',
      engagement_type: 'contract', work_mode: 'remote', currency: 'EUR', status: 'open'
    })),
    total: jobs
  });
  jest.spyOn(ConsultantProfile, 'browse').mockResolvedValue({
    rows: Array.from({ length: Math.min(consultants, 5) }, (_, i) => ({
      user_id: i + 1, name: `Person ${i}`, headline: 'A headline', slug: `p-${i}`, currency: 'EUR'
    })),
    total: consultants
  });
  jest.spyOn(CompanyProfile, 'browse').mockResolvedValue({
    rows: Array.from({ length: Math.min(companies, 5) }, (_, i) => ({
      user_id: i + 1, company_name: `Co ${i}`, slug: `co-${i}`, open_jobs: 0
    })),
    total: companies
  });
  jest.spyOn(Post, 'browse').mockResolvedValue({
    rows: Array.from({ length: Math.min(posts, 5) }, (_, i) => ({
      id: i + 1, title: `Post ${i}`, slug: `post-${i}`, kind: 'question', body: 'Body text'
    })),
    total: posts
  });
}

describe('the search page', () => {
  const app = buildApp();

  afterEach(() => jest.restoreAllMocks());

  it('renders with no query at all, without touching the database', async () => {
    const spy = jest.spyOn(Job, 'browse');
    const res = await request(app).get('/search');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/One box, four places/);
    // Nothing is queried until there is something to query for.
    expect(spy).not.toHaveBeenCalled();
  });

  it('asks for more characters rather than scanning for one', async () => {
    const spy = jest.spyOn(Job, 'browse');
    const res = await request(app).get('/search?q=a');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Type a little more/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('renders results grouped by type', async () => {
    stubAll({ jobs: 43, consultants: 2, companies: 0, posts: 7 });
    const res = await request(app).get('/search?q=apex');

    expect(res.status).toBe(200);
    // The total is the sum of what each source reported.
    expect(res.text).toMatch(/<strong>52<\/strong>/);
    expect(res.text).toMatch(/See all 43/);
    // A source with nothing gets a line at the end, not an empty panel. The \s+ is real:
    // EJS puts the list on its own line, and the browser collapses it.
    expect(res.text).toMatch(/Nothing in\s+companies/);
  });

  it('says so plainly when nothing matched', async () => {
    stubAll({});
    const res = await request(app).get('/search?q=zzzznothing');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Nothing matched/);
  });

  it('renders the other sections when one is down', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    stubAll({ jobs: 3, consultants: 1 });
    Job.browse.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await request(app).get('/search?q=apex');

    expect(res.status).toBe(200);
    // Named as a failure, not shown as an absence — those are different claims.
    expect(res.text).toMatch(/could not be searched just now/);
    expect(res.text).toMatch(/Consultants/);
  });

  it('survives a query full of characters that mean something to SQL or HTML', async () => {
    stubAll({});
    for (const q of ["'; DROP TABLE jobs; --", '%', '<script>alert(1)</script>', '100%_x', '\\\\']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(`/search?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      // Echoed back escaped, never as markup.
      expect(res.text).not.toMatch(/<script>alert/);
    }
  });

  it('ignores a query longer than the cap rather than building a pattern from it', async () => {
    stubAll({});
    const res = await request(app).get(`/search?q=${'x'.repeat(4000)}`);
    expect(res.status).toBe(200);
    expect(Job.browse.mock.calls[0][0].q.length).toBe(120);
  });

  it('passes the query and nothing that widens what is visible', async () => {
    /*
     * The defaults are what make the results safe. Anything passed here that WIDENS them
     * would be the leak, so the shape of the call is the assertion.
     *
     * `viewer` is the one addition, and it narrows: it carries the hidden-company block, so a
     * company excluded from /consultants is excluded here too. Without it a blocked company
     * would find the profile through the search box instead — which is what happens whenever
     * a visibility rule is applied per page rather than in the builder every page shares. It
     * is null for an anonymous request, which is this one.
     */
    stubAll({ jobs: 1 });
    await request(app).get('/search?q=apex&status=draft&include_hidden=1&is_public=0');

    expect(Job.browse.mock.calls[0][0]).toEqual({ q: 'apex' });
    expect(Post.browse.mock.calls[0][0]).toEqual({ q: 'apex' });
    expect(ConsultantProfile.browse.mock.calls[0][0]).toEqual({ q: 'apex', viewer: null });

    // The thing the original assertion was really guarding: nothing a visitor typed into the
    // query string reaches a builder as a filter.
    for (const spy of [Job.browse, Post.browse, ConsultantProfile.browse]) {
      const passed = Object.keys(spy.mock.calls[0][0]);
      expect(passed.filter((k) => !['q', 'viewer'].includes(k))).toEqual([]);
    }
  });
});
