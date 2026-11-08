'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { attachViewHelpers } = require('../../utils/viewHelpers');
const { notFound, errorHandler } = require('../../middleware/errorHandler');
const ConsultantDocument = require('../../models/ConsultantDocument');
const GeneratedDocument = require('../../models/GeneratedDocument');
const Quote = require('../../models/Quote');
const { PURGE } = require('../../models/AccountErasure');
const { OWNED } = require('../../services/dataExport');
const { promisePool } = require('../../config/database');

/**
 * /profile/documents over real HTTP with the data layer stubbed. A plain HTTP client sends no
 * Sec-Fetch-Dest, so a refused guard answers as a navigation (302).
 */
const CONSULTANT = { id: 7, name: 'Ana B', email: 'a@example.com', isConsultant: true, emailVerified: true };
const COMPANY = { id: 9, name: 'Co', email: 'c@example.com', isCompany: true, emailVerified: true };

function buildApp(user) {
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
      seo: { title: 'My documents', description: 'd', canonical: 'http://x/profile/documents', ogImage: 'http://x/o.png', indexable: false }
    });
    attachViewHelpers(res);
    next();
  });
  app.use('/profile', require('../../routes/profile'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

const CV = { id: 1, kind: 'cv', title: 'CPQ CV', filename: 'cv.pdf', content_type: 'application/pdf', byte_size: 20480, is_default: 1, created_at: new Date('2026-11-01') };
const LETTER = { id: 2, kind: 'cover_letter', title: null, filename: 'letter.docx', content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byte_size: 4096, is_default: 1, created_at: new Date('2026-11-02') };

afterEach(() => jest.restoreAllMocks());

describe('GET /profile/documents', () => {
  it('lists a consultant\'s uploads by kind with their limits, and the generation log', async () => {
    jest.spyOn(ConsultantDocument, 'listFor').mockResolvedValue([CV]);
    jest.spyOn(GeneratedDocument, 'recentFor').mockResolvedValue([
      { id: 5, kind: 'cv_rate_card', label: 'CV + rate card', sections: ['projects'], application_id: 33, job_title: 'CPQ Lead', company_name: 'Vela', created_at: new Date('2026-11-05') }
    ]);
    const res = await request(buildApp(CONSULTANT)).get('/profile/documents');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/My documents/);
    expect(res.text).toMatch(/CVs \/ resumes[\s\S]*?1 \/ 5/);
    expect(res.text).toMatch(/Cover letters[\s\S]*?0 \/ 10/);
    expect(res.text).toMatch(/No cover letters uploaded yet/);
    expect(res.text).toMatch(/CPQ CV[\s\S]*?Default/);
    expect(res.text).toMatch(/for Vela \(CPQ Lead\)/);
    // "Generate again" reproduces the choice: the package, the same section, the same application.
    expect(res.text).toMatch(/href="\/cv-generator\?doc=package&amp;opts=1&amp;include=projects&amp;application=33"/);
    expect(res.text).not.toMatch(/SOW quotes &amp; project documents/);
    // Every action comes back here.
    expect((res.text.match(/name="redirectTo" value="\/profile\/documents"/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(res.text).toMatch(/data-confirm="Delete CPQ CV\?/);
    // One primary action on the page: the generator. Uploading is the secondary one.
    expect(res.text).toMatch(/class="btn btn-primary" href="\/cv-generator"/);
    expect(res.text).toMatch(/class="btn btn-outline-primary" href="\?upload=cv#upload"/);
  });

  it('puts a cover letter in its own card, named by its file when it has no title', async () => {
    jest.spyOn(ConsultantDocument, 'listFor').mockResolvedValue([CV, LETTER]);
    jest.spyOn(GeneratedDocument, 'recentFor').mockResolvedValue([]);
    const res = await request(buildApp(CONSULTANT)).get('/profile/documents');
    expect(res.text).toMatch(/Cover letters[\s\S]*?1 \/ 10/);
    expect(res.text).not.toMatch(/No cover letters uploaded yet/);
    expect(res.text).toMatch(/letter\.docx/);
  });

  it('shows a company its SOW quotes and their documents, and no upload section', async () => {
    jest.spyOn(Quote, 'listForOwner').mockResolvedValue({ rows: [{ id: 3, reference: 'Q-2026-0001', project_name: 'CPQ rollout', client_company: 'Vela', status: 'sent', created_at: new Date('2026-11-05') }], total: 1 });
    const res = await request(buildApp(COMPANY)).get('/profile/documents');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/SOW quotes &amp; project documents/);
    for (const kind of ['sow', 'wbs', 'deck', 'package']) {
      expect(res.text).toContain(`/quotes/Q-2026-0001/download/${kind}`);
    }
    expect(res.text).not.toMatch(/Upload your own/);
  });

  it('opens the upload form preselected from ?upload=cover_letter', async () => {
    jest.spyOn(ConsultantDocument, 'listFor').mockResolvedValue([]);
    jest.spyOn(GeneratedDocument, 'recentFor').mockResolvedValue([]);
    const res = await request(buildApp(CONSULTANT)).get('/profile/documents?upload=cover_letter');
    expect(res.text).toMatch(/<details class="docs-card docs-upload mb-4" open>/);
    expect(res.text).toMatch(/<option value="cover_letter" selected>/);
  });

  it('sends a visitor to sign in', async () => {
    const res = await request(buildApp(null)).get('/profile/documents');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/login/);
  });
});

describe('document actions return to My documents', () => {
  it('renames, and comes back to the page the form named', async () => {
    const rename = jest.spyOn(ConsultantDocument, 'rename').mockResolvedValue(true);
    const res = await request(buildApp(CONSULTANT)).post('/profile/consultant/documents/1/rename').type('form')
      .send({ title: 'For CPQ roles', redirectTo: '/profile/documents' });
    expect(rename).toHaveBeenCalledWith(7, 1, 'For CPQ roles');
    expect(res.headers.location).toBe('/profile/documents');
  });

  it('refuses an outside redirect', async () => {
    jest.spyOn(ConsultantDocument, 'remove').mockResolvedValue(true);
    const res = await request(buildApp(CONSULTANT)).post('/profile/consultant/documents/1/delete').type('form')
      .send({ redirectTo: 'https://evil.example/' });
    expect(res.headers.location).toBe('/profile/documents');
  });
});

describe('ConsultantDocument limits are per kind', () => {
  it('refuses a sixth CV, counting only CVs', async () => {
    // An isolated copy of the model over a fake transaction: nothing here may reach a database.
    const conn = { query: jest.fn().mockResolvedValueOnce([[{ sameKind: 5 }]]) };
    let Doc;
    jest.isolateModules(() => {
      jest.doMock('../../config/database', () => ({ promisePool: { query: jest.fn() }, withTransaction: (fn) => fn(conn) }));
      Doc = require('../../models/ConsultantDocument');
    });
    const refused = await Doc.add(7, { kind: 'cv', filename: 'x.pdf', contentType: 'application/pdf', bytes: Buffer.from('x') });
    expect(refused).toEqual({ ok: false, reason: 'You can keep up to 5 CVs. Delete one first.' });
    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.query.mock.calls[0][1]).toEqual([7, 'cv']);
    expect(Doc.LIMITS).toEqual({ cv: 5, cover_letter: 10 });
    jest.dontMock('../../config/database');
  });
});

describe('the generation log', () => {
  it('never throws, so a download never fails over bookkeeping', async () => {
    jest.spyOn(promisePool, 'query').mockRejectedValue(new Error('ECONNREFUSED'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(GeneratedDocument.log(7, { kind: 'cv' })).resolves.toBeUndefined();
  });

  it('goes with the account and is in the data export', () => {
    expect(PURGE).toContain('generated_documents');
    expect(OWNED.generated_documents).toBe('user_id');
  });
});

describe('every way in points at /profile/documents', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
  it('is linked from the menu, the CV Generator, the profile and the applications list', () => {
    expect(read('views/partials/navigation.ejs')).toMatch(/href="\/profile\/documents"[^>]*>.*My documents/);
    expect(read('views/cv/index.ejs')).toMatch(/isConsultantView \? '\/profile\/documents'/);
    expect(read('views/profile/consultant.ejs')).toMatch(/href="\/profile\/documents"/);
    expect(read('views/dashboard/applications.ejs')).toMatch(/No CV attached[\s\S]{0,80}\/profile\/documents/);
    for (const file of ['views/partials/navigation.ejs', 'views/cv/index.ejs', 'views/dashboard/applications.ejs', 'views/jobs/show.ejs']) {
      expect(read(file)).not.toMatch(/cv-generator#my-documents/);
    }
  });

  it('pre-selects the default CV when applying', () => {
    expect(read('views/jobs/show.ejs')).toMatch(/<option value="<%= d\.id %>" <%= d\.is_default \? 'selected' : '' %>>/);
  });
});
