'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { attachViewHelpers } = require('../../utils/viewHelpers');
const { notFound, errorHandler } = require('../../middleware/errorHandler');
const Job = require('../../models/Job');
const Application = require('../../models/Application');
const RateSubmission = require('../../models/RateSubmission');
const { sortSaved, sortFrom, publishedRateEur } = require('../../utils/savedJobs');

/**
 * /dashboard/saved over real HTTP with the data layer stubbed, plus the pure ordering.
 */
const CONSULTANT = { id: 8, name: 'Ana B', email: 'a@example.com', isConsultant: true, emailVerified: true };

function buildApp(user) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use((req, res, next) => {
    req.session = { user };
    req.flash = () => [];
    Object.assign(res.locals, {
      appName: 'Salesforce Hub', supportEmail: 's@example.com', currentUser: user, currentPath: req.path,
      csrfToken: 'token', query: req.query, assistantEnabled: false, assistantMaxChars: 2000,
      linkedInEnabled: false, siteNotice: '', flash: { success: [], error: [], info: [] },
      seo: { title: 'Saved jobs', description: 'd', canonical: 'http://x/dashboard/saved', ogImage: 'http://x/o.png', indexable: false }
    });
    attachViewHelpers(res);
    next();
  });
  app.use('/dashboard', require('../../routes/dashboard'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

const job = (over) => ({
  id: 1, title: 'CPQ Lead', slug: 'cpq-lead', role: 'cpq-billing-consultant', seniority: 'senior', engagement_type: 'contract',
  work_mode: 'remote', country: 'DE', city: null, rate_min: 600, rate_max: 800, currency: 'EUR', rate_visible: 1,
  duration_months: 6, published_at: new Date('2026-11-01'), status: 'open', description_snippet: 'Lead a CPQ rollout.',
  company_name: 'Vela', company_logo: null, is_featured: 0, is_open: true, saved_at: new Date('2026-11-05'), ...over
});

afterEach(() => jest.restoreAllMocks());

describe('GET /dashboard/saved', () => {
  it('renders the shortlist: count, sort, one card each, actions by state', async () => {
    jest.spyOn(Job, 'listSaved').mockResolvedValue([
      job({ id: 1 }),
      job({ id: 2, slug: 'applied-role', title: 'Applied role' }),
      job({ id: 3, slug: 'gone', title: 'Gone role', is_open: false, status: 'closed' })
    ]);
    jest.spyOn(Application, 'statusByJob').mockResolvedValue(new Map([[2, { id: 40, status: 'reviewing' }]]));
    const res = await request(buildApp(CONSULTANT)).get('/dashboard/saved');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/YOUR SHORTLIST/);
    expect(res.text).toMatch(/<span data-saved-count>3<\/span> <span data-saved-noun>saved jobs<\/span>/);
    expect(res.text).toMatch(/Browse all jobs/);
    expect(res.text).toMatch(/value="rate"[^>]*>Highest rate/);
    expect((res.text.match(/data-saved-item/g) || []).length).toBe(3);
    // Open and not applied: View details and Apply.
    expect(res.text).toContain('href="/jobs/cpq-lead#apply"');
    // Applied: the status, linking to Your applications, and no second Apply.
    expect(res.text).toMatch(/Applied · In review/);
    expect(res.text).not.toContain('href="/jobs/applied-role#apply"');
    // No longer open: greyed, labelled, Remove only — no link to the advert, no Apply.
    expect(res.text).toMatch(/job-card-closed[\s\S]*?No longer open[\s\S]*?Remove/);
    expect(res.text).not.toContain('href="/jobs/gone"');
    // The empty state is carried, hidden, so removing the last card can show it.
    expect(res.text).toMatch(/data-saved-empty hidden/);
  });

  it('never renders an empty pill where the level should be', async () => {
    jest.spyOn(Job, 'listSaved').mockResolvedValue([job({ seniority: null })]);
    jest.spyOn(Application, 'statusByJob').mockResolvedValue(new Map());
    const res = await request(buildApp(CONSULTANT)).get('/dashboard/saved');
    expect(res.text).not.toMatch(/<span class="badge-hub">\s*<\/span>/);
  });

  it('shows the empty state with a way back to the board', async () => {
    jest.spyOn(Job, 'listSaved').mockResolvedValue([]);
    jest.spyOn(Application, 'statusByJob').mockResolvedValue(new Map());
    const res = await request(buildApp(CONSULTANT)).get('/dashboard/saved');
    expect(res.text).toMatch(/No saved jobs yet/);
    expect(res.text).toMatch(/Browse open roles/);
    expect(res.text).not.toMatch(/data-saved-empty hidden/);
    expect(res.text).not.toMatch(/data-saved-toolbar/);
  });

  it('counts every saved job, not the rows on this page plus the offset', async () => {
    jest.spyOn(Job, 'listSaved').mockResolvedValue(Array.from({ length: 25 }, (_, i) => job({ id: i + 1, slug: `j${i + 1}` })));
    jest.spyOn(Application, 'statusByJob').mockResolvedValue(new Map());
    const res = await request(buildApp(CONSULTANT)).get('/dashboard/saved?page=2');
    expect(res.text).toMatch(/<span data-saved-count>25<\/span>/);
    expect((res.text.match(/data-saved-item/g) || []).length).toBe(5);
  });
});

describe('sortSaved', () => {
  const toEur = RateSubmission.toEur;
  const rows = [
    job({ id: 1, rate_max: 700, saved_at: new Date('2026-11-01'), published_at: new Date('2026-10-01') }),
    job({ id: 2, engagement_type: 'permanent', rate_min: 90000, rate_max: 120000, saved_at: new Date('2026-11-03'), published_at: new Date('2026-10-20') }),
    job({ id: 3, rate_max: 900, rate_visible: 0, saved_at: new Date('2026-11-02'), published_at: new Date('2026-10-10') }),
    job({ id: 4, rate_max: 800, saved_at: new Date('2026-10-30'), published_at: new Date('2026-11-02') })
  ];
  it('orders by when it was saved, by the posting date, and by published rate', () => {
    expect(sortSaved(rows, 'recent', toEur).map((j) => j.id)).toEqual([2, 3, 1, 4]);
    expect(sortSaved(rows, 'newest', toEur).map((j) => j.id)).toEqual([4, 2, 3, 1]);
    // Day rates first, then salaries, then a hidden rate — which must not decide its place.
    expect(sortSaved(rows, 'rate', toEur).map((j) => j.id)).toEqual([4, 1, 2, 3]);
  });
  it('reads a hidden rate as no rate, and falls back to Recently saved', () => {
    expect(publishedRateEur(rows[2], toEur)).toBeNull();
    expect(sortFrom('price')).toBe('recent');
    expect(sortFrom('__proto__')).toBe('recent');
  });
});

describe('keeping Saved roles in step with the saved page', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
  it('uses the same unsave form and handler, and links to the full list', () => {
    const block = read('views/dashboard/_appsSuggestions.ejs');
    expect(block).toMatch(/data-saved-item/);
    expect(block).toMatch(/data-save-job/);
    expect(block).toMatch(/href="\/dashboard\/saved">All saved jobs/);
  });
  it('builds the undo toast from DOM nodes', () => {
    const js = read('public/js/main.js');
    const start = js.indexOf('function showSavedToast');
    expect(start).toBeGreaterThan(-1);
    expect(js.slice(start, js.indexOf('function postSave'))).not.toMatch(/innerHTML/);
  });
  it('selects the level, so the card has it to show', () => {
    const src = read('models/Job.js');
    const listSaved = src.slice(src.indexOf('static async listSaved'), src.indexOf('static async countSaved'));
    expect(listSaved).toMatch(/j\.seniority/);
    expect(listSaved).toMatch(/AS is_open/);
  });
});
