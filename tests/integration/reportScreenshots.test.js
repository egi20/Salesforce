'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

const IssueReport = require('../../models/IssueReport');
const { csrfProtection } = require('../../middleware/csrf');
const { isUploadPath } = require('../../middleware/fileUpload');
const { attachViewHelpers } = require('../../utils/viewHelpers');
const { notFound, errorHandler } = require('../../middleware/errorHandler');

/**
 * /report-issue with real multipart bodies: the CSRF token inside one is honoured, a
 * screenshot reaches the model as bytes, and a file that is not an image leaves the report
 * standing with a note to the sender.
 */
const SECRET = 'c'.repeat(43);

function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  const flashed = { success: [], error: [], info: [] };
  app.flashed = flashed;
  app.use((req, res, next) => {
    req.session = { csrfSecret: SECRET };
    req.flash = (type, message) => {
      if (message === undefined) return flashed[type] || [];
      flashed[type].push(message);
      return undefined;
    };
    Object.assign(res.locals, {
      appName: 'Salesforce Hub', supportEmail: 's@x.test', currentUser: null, currentPath: req.path, query: req.query,
      assistantEnabled: false, assistantMaxChars: 2000, linkedInEnabled: false, siteNotice: '', flash: flashed,
      seo: { title: 't', description: 'd', canonical: 'c', ogImage: 'o', indexable: false }
    });
    attachViewHelpers(res);
    next();
  });
  app.use(csrfProtection({ deferMultipart: isUploadPath }));
  app.use('/', require('../../routes/index'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

let ip = 0;
const post = (app) => {
  ip += 1;
  return request(app).post('/report-issue').set('X-Forwarded-For', `198.51.100.${ip}`)
    .field('summary', 'The save button fails').field('detail', 'I pressed save and the page went blank.');
};

afterEach(() => jest.restoreAllMocks());

describe('/report-issue with screenshots', () => {
  beforeEach(() => {
    jest.spyOn(IssueReport, 'create').mockResolvedValue({ id: 12 });
    jest.spyOn(IssueReport, 'addAttachments').mockResolvedValue();
  });

  it('the form is multipart and offers the screenshot field', async () => {
    const res = await request(buildApp()).get('/report-issue');
    expect(res.text).toMatch(/enctype="multipart\/form-data"/);
    expect(res.text).toMatch(/name="screenshots"[^>]*multiple/);
    expect(res.text).toMatch(/name="_csrf"/);
  });

  it('accepts the token from inside the multipart body and hands the bytes to the model', async () => {
    const png = await require('sharp')({ create: { width: 2, height: 2, channels: 3, background: '#000000' } }).png().toBuffer();
    const res = await post(buildApp()).field('_csrf', SECRET).attach('screenshots', png, { filename: 's.png', contentType: 'image/png' });
    expect(res.status).toBe(302);
    expect(IssueReport.create).toHaveBeenCalled();
    expect(IssueReport.addAttachments).toHaveBeenCalledWith(12, [expect.any(Buffer)]);
  });

  it('refuses a multipart report with no token, before anything is stored', async () => {
    // A plain client sends no Sec-Fetch-Dest, so it is a navigation: the refusal is a flash
    // and a redirect (middleware/errorHandler.js), not a bare 403.
    const app = buildApp();
    const res = await post(app);
    expect(res.status).toBe(302);
    expect(app.flashed.error[0]).toMatch(/session expired/);
    expect(IssueReport.create).not.toHaveBeenCalled();
  });

  it('keeps the report when a "screenshot" turns out not to be an image, and says so', async () => {
    IssueReport.addAttachments.mockRejectedValueOnce(new Error('Input buffer contains unsupported image format'));
    const app = buildApp();
    await post(app).field('_csrf', SECRET).attach('screenshots', Buffer.from('not an image'), { filename: 'x.png', contentType: 'image/png' });
    expect(IssueReport.create).toHaveBeenCalled();
    expect(app.flashed.info[0]).toMatch(/not a readable image/);
  });

  it('refuses a file type that is not an image at all, and stores nothing', async () => {
    const app = buildApp();
    await post(app).field('_csrf', SECRET).attach('screenshots', Buffer.from('%PDF-1.4'), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(IssueReport.create).not.toHaveBeenCalled();
    expect(app.flashed.error[0]).toMatch(/Nothing was sent/);
  });
});
