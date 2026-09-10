'use strict';

const express = require('express');
const request = require('supertest');

const { singleImage } = require('../../middleware/fileUpload');
const config = require('../../config/config');

/**
 * The upload middleware, exercised over real HTTP.
 *
 * This is the layer that decides what a stranger can put into the process, so it is worth
 * testing against actual multipart requests rather than by reading the config. No database
 * is involved: the middleware never touches one.
 *
 * `flash` and `redirect` are stubbed so a rejection is observable as JSON.
 */
function buildApp() {
  const app = express();

  app.use((req, res, next) => {
    res.locals.flashes = [];
    req.flash = (type, message) => {
      res.locals.flashes.push({ type, message });
    };
    // The middleware answers a rejection with a redirect. Capture it instead.
    res.redirect = (to) => res.status(302).json({ redirected: to, flashes: res.locals.flashes });
    next();
  });

  app.post('/upload', singleImage('photo'), (req, res) => {
    res.json({
      received: Boolean(req.file),
      size: req.file ? req.file.size : 0,
      mimetype: req.file ? req.file.mimetype : null
    });
  });

  return app;
}

// A real 1x1 PNG, so the MIME and the bytes actually agree.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('image upload middleware', () => {
  const app = buildApp();

  it('accepts a PNG with a matching extension', async () => {
    const res = await request(app).post('/upload').attach('photo', PNG, 'avatar.png');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, mimetype: 'image/png' });
  });

  it('accepts JPEG, WebP and GIF', async () => {
    for (const [name, type] of [
      ['a.jpg', 'image/jpeg'],
      ['a.webp', 'image/webp'],
      ['a.gif', 'image/gif']
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post('/upload').attach('photo', PNG, { filename: name, contentType: type });
      expect(res.status).toBe(200);
    }
  });

  it('rejects a disallowed MIME type', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('photo', Buffer.from('#!/bin/sh\nrm -rf /'), { filename: 'evil.sh', contentType: 'application/x-sh' });

    expect(res.status).toBe(302);
    expect(res.body.flashes[0].message).toMatch(/JPEG, PNG, WebP or GIF/);
  });

  it('rejects an image MIME type carrying a non-image extension', async () => {
    // The client controls both, so neither alone is evidence. Requiring them to agree
    // closes the "declare image/png, name it .php" trick.
    const res = await request(app)
      .post('/upload')
      .attach('photo', PNG, { filename: 'shell.php', contentType: 'image/png' });

    expect(res.status).toBe(302);
    expect(res.body.flashes[0].message).toMatch(/extension is not accepted/);
  });

  it('rejects a file over the size limit with a message that names the limit', async () => {
    const tooBig = Buffer.alloc(config.uploads.maxPhotoBytes + 1024, 0);
    const res = await request(app).post('/upload').attach('photo', tooBig, { filename: 'big.png', contentType: 'image/png' });

    expect(res.status).toBe(302);
    expect(res.body.flashes[0].message).toMatch(/too large/);
    expect(res.body.flashes[0].message).toMatch(new RegExp(String(Math.round(config.uploads.maxPhotoBytes / 1024 / 1024))));
  });

  it('rejects a second file rather than silently taking one', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('photo', PNG, 'one.png')
      .attach('photo', PNG, 'two.png');

    expect(res.status).toBe(302);
  });

  it('passes through a request with no file, leaving the route to handle it', async () => {
    const res = await request(app).post('/upload').field('unrelated', 'x');
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(false);
  });

  it('does not crash on a malformed multipart body', async () => {
    // Multer 1.x could throw an unhandled exception on a malformed request. Whatever the
    // outcome, the process must answer rather than die.
    const res = await request(app)
      .post('/upload')
      .set('Content-Type', 'multipart/form-data; boundary=----nope')
      .send('------nope\r\nContent-Disposition: form-data; name="photo"');

    expect([200, 302, 400, 500]).toContain(res.status);
  });
});
