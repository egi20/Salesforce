'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

const SiteStats = require('../../models/SiteStats');
const TaxProgram = require('../../models/TaxProgram');
const Job = require('../../models/Job');
const { teamFor, assertTeam, TEAM } = require('../../config/team');
const { attachViewHelpers } = require('../../utils/viewHelpers');
const { notFound, errorHandler } = require('../../middleware/errorHandler');

function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use((req, res, next) => {
    req.session = {};
    req.flash = () => [];
    Object.assign(res.locals, {
      appName: 'Salesforce Hub', supportEmail: 's@example.com', currentUser: null, currentPath: req.path,
      csrfToken: 't', query: req.query, assistantEnabled: false, assistantMaxChars: 2000, linkedInEnabled: false,
      siteNotice: '', flash: { success: [], error: [], info: [] },
      seo: { title: 'About', description: 'd', canonical: 'http://x/about', ogImage: 'http://x/o.png', indexable: true }
    });
    attachViewHelpers(res);
    next();
  });
  app.use('/', require('../../routes/index'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

afterEach(() => jest.restoreAllMocks());

function stub({ counts, open = 7, stories = [] }) {
  jest.spyOn(SiteStats, 'platformCounts').mockResolvedValue(counts);
  jest.spyOn(Job, 'browse').mockResolvedValue({ rows: [], total: open });
  jest.spyOn(TaxProgram, 'liveStories').mockResolvedValue(stories);
}

describe('GET /about', () => {
  it('has the hero, the three hubs, how it works, the mission, the team and what we stand for', async () => {
    stub({ counts: { consultants: 25, companies: 6, applications: 97, hired: 10 } });
    const res = await request(buildApp()).get('/about');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Where Salesforce <span class="hero-accent">talent meets opportunity<\/span>/);
    expect(res.text).toMatch(/href="\/jobs"><i class="bi bi-search"><\/i> Find Salesforce work/);
    for (const href of ['/consultant-hub', '/companies-hub', '/quotes/new']) expect(res.text).toContain(`href="${href}">Explore`);
    expect(res.text).toMatch(/Registered consultants[\s\S]*Companies[\s\S]*Open roles[\s\S]*Applications submitted[\s\S]*Consultants hired/);
    expect(res.text).toMatch(/sister platform of Dynamics Hub/);
    expect(res.text).toMatch(/Joni Pjetri[\s\S]*Founder &amp; CEO/);
    expect(res.text).toMatch(/Malda Shushku[\s\S]*Commercial Director/);
    expect(res.text).toMatch(/we don’t give tax advice/);
    expect(res.text).not.toMatch(/We do not calculate your tax/);
    expect(res.text).toMatch(/We never send messages pretending to be you/);
    expect(res.text).toMatch(/Not affiliated with Salesforce, Inc\./);
  });

  it('hides a tile whose value is 0, and the stories section without a story', async () => {
    stub({ counts: { consultants: 25, companies: 6, applications: 0, hired: 0 }, open: 0 });
    const res = await request(buildApp()).get('/about');
    expect(res.text).toMatch(/Registered consultants/);
    expect(res.text).not.toMatch(/Applications submitted|Consultants hired|Open roles/);
    expect(res.text).not.toMatch(/Real stories/);
  });

  it('shows consented stories by first name and initial, with the review link', async () => {
    stub({ counts: { consultants: 1, companies: 0, applications: 0, hired: 0 }, stories: [{ id: 1, name: 'Ana B.', initials: 'AB', role: 'CPQ Consultant', country: 'Germany', quote: 'Straightforward.' }] });
    const res = await request(buildApp()).get('/about');
    expect(res.text).toMatch(/Real stories[\s\S]*Leave a review/);
    expect(res.text).toMatch(/Straightforward\.[\s\S]*Ana B\./);
  });
});

describe('the team', () => {
  it('passes its boot assertion', () => {
    expect(assertTeam()).toBe(true);
  });

  it('shows an unapproved bio in development, labelled, and never in production', () => {
    const dev = teamFor({ isProduction: false });
    const prod = teamFor({ isProduction: true });
    TEAM.forEach((m, i) => {
      if (m.approved) return;
      expect(dev[i].bio).toBe(m.bio);
      expect(dev[i].draft).toBe(true);
      expect(prod[i].bio).toBeNull();
      expect(prod[i].name).toBe(m.name);
    });
  });

  it('invents no link and no photo', () => {
    // Null until somebody supplies the real ones; a card without a photo shows initials.
    TEAM.forEach((m) => {
      expect(m.linkedin === null || /^https:\/\/(www\.)?linkedin\.com\/in\//.test(m.linkedin)).toBe(true);
      expect(m.photo === null || m.photo.startsWith('/images/team/')).toBe(true);
    });
  });
});
