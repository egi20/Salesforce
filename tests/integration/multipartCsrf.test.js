'use strict';

const express = require('express');
const request = require('supertest');

const { csrfProtection } = require('../../middleware/csrf');
const { singleImage, isUploadPath, UPLOAD_PATHS } = require('../../middleware/fileUpload');

/**
 * Every file upload answered 403 in a real browser: a multipart body is not parsed when the
 * CSRF middleware runs, so the `_csrf` field inside it was invisible. This posts REAL
 * multipart forms, which is the thing no test did before.
 */
const SECRET = 'a'.repeat(43);
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { csrfSecret: SECRET };
    req.flash = () => [];
    next();
  });
  app.use(csrfProtection({ deferMultipart: isUploadPath }));
  app.post('/profile/consultant/photo', singleImage('photo'), (req, res) => res.json({ ok: true, file: Boolean(req.file) }));
  app.post('/admin/users/9/verify', (req, res) => res.json({ ok: true }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.code || err.message }));
  return app;
}

describe('CSRF on multipart uploads', () => {
  it('accepts an upload whose form carries the right token', async () => {
    const res = await request(buildApp()).post('/profile/consultant/photo')
      .field('_csrf', SECRET).attach('photo', PNG, { filename: 'p.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, file: true });
  });

  it('refuses an upload with a wrong or missing token, before the handler runs', async () => {
    const wrong = await request(buildApp()).post('/profile/consultant/photo')
      .field('_csrf', 'b'.repeat(43)).attach('photo', PNG, { filename: 'p.png', contentType: 'image/png' });
    expect(wrong.status).toBe(403);
    const none = await request(buildApp()).post('/profile/consultant/photo')
      .attach('photo', PNG, { filename: 'p.png', contentType: 'image/png' });
    expect(none.status).toBe(403);
  });

  it('defers ONLY for named upload routes: a multipart post anywhere else is checked at once', async () => {
    const res = await request(buildApp()).post('/admin/users/9/verify').field('_csrf', SECRET);
    expect(res.status).toBe(403);
  });

  it('every route that uses singleImage is a named upload path', () => {
    const fs = require('fs');
    const path = require('path');
    const routes = ['profile.js', 'admin.js'].map((f) => [f, fs.readFileSync(path.join(__dirname, '..', '..', 'routes', f), 'utf8')]);
    const mounts = { 'profile.js': '/profile', 'admin.js': '/admin' };
    let seen = 0;
    for (const [file, src] of routes) {
      // Each route's middleware list runs from `router.post(` to its handler.
      for (const chunk of src.split('router.post(').slice(1)) {
        const head = chunk.slice(0, chunk.indexOf('asyncHandler('));
        if (!head.includes('singleImage(')) continue;
        const full = mounts[file] + head.match(/'([^']+)'/)[1].replace(':id', '7');
        expect({ full, listed: UPLOAD_PATHS.some((re) => re.test(full)) }).toEqual({ full, listed: true });
        seen += 1;
      }
    }
    // An empty match would pass the loop silently.
    expect(seen).toBe(3);
  });
});
