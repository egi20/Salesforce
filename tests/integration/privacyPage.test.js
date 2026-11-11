'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

const { attachViewHelpers } = require('../../utils/viewHelpers');
const { notFound, errorHandler } = require('../../middleware/errorHandler');
const { RETENTION_DAYS } = require('../../config/taxAdvisory');
const { SCREENSHOTS } = require('../../config/issues');
const { ERROR_LOG_RETENTION_DAYS } = require('../../config/errorLog');
const { STALE_AFTER_DAYS } = require('../../config/crm');
const { PRIVACY_VERSION, PRIVACY_CHANGES } = require('../../config/legal-versions');

function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use((req, res, next) => {
    req.session = {};
    Object.assign(res.locals, {
      appName: 'Salesforce Hub', supportEmail: 'support@example.com', currentUser: null, currentPath: req.path,
      csrfToken: 't', query: req.query, assistantEnabled: false, assistantMaxChars: 2000, linkedInEnabled: false,
      siteNotice: '', flash: { success: [], error: [], info: [] },
      seo: { title: 'Privacy', description: 'd', canonical: 'http://x/legal/privacy', ogImage: 'http://x/o.png', indexable: true }
    });
    attachViewHelpers(res);
    next();
  });
  app.use('/', require('../../routes/index'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

describe('GET /legal/privacy', () => {
  let html;
  beforeAll(async () => {
    html = (await request(buildApp()).get('/legal/privacy').expect(200)).text;
  });

  it('every contents link lands on a section that exists', () => {
    const toc = html.slice(html.indexOf('policy-toc'), html.indexOf('</nav>', html.indexOf('policy-toc')));
    const anchors = [...toc.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(10);
    anchors.forEach((a) => expect(html).toContain(`id="${a}"`));
  });

  it('states the periods the purges enforce, read from their own config', () => {
    expect(html).toContain(`${RETENTION_DAYS} days, then deleted`);
    expect(html).toContain(`screenshots ${SCREENSHOTS.retentionDaysAfterClose} days after the report is closed`);
    expect(html).toContain(`<td>${ERROR_LOG_RETENTION_DAYS} days</td>`);
    expect(html).toContain(`${STALE_AFTER_DAYS} days is flagged`);
  });

  it('names a legal basis for every row of the summary table', () => {
    const body = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
    const rows = body.split('<tr>').slice(1);
    expect(rows.length).toBeGreaterThan(8);
    rows.forEach((row) => expect(row).toMatch(/<td>(Contract|Legal obligation|Legitimate interest|Consent|Strictly necessary)<\/td>/));
  });

  it('covers the tax programme, uploaded documents and the sales team’s contacts', () => {
    expect(html).toContain('id="tax-programme"');
    expect(html).toMatch(/employment itself is not handled through this website/);
    expect(html).toMatch(/company you\s+applied to can download <em>that<\/em> CV/);
    expect(html).toContain('id="business-contacts"');
  });

  it('names the authorities, and asks for nothing it no longer collects', () => {
    expect(html).toMatch(/Information and Data Protection Commissioner/);
    expect(html).toContain('edpb.europa.eu');
    expect(html).not.toMatch(/Optional demographic questions|name="gender"|name="date_of_birth"/);
  });

  it('shows when it was last updated and what changed', () => {
    expect(PRIVACY_CHANGES[0].version).toBe(PRIVACY_VERSION);
    expect(html).toMatch(/Last updated \d{1,2} [A-Z][a-z]+ \d{4}/);
    expect(html).toContain('href="#changes"');
    expect(html).toContain(PRIVACY_CHANGES[0].changes[0]);
  });
});
