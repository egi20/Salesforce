'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

const { csrfProtection } = require('../../middleware/csrf');
const { notFound, errorHandler } = require('../../middleware/errorHandler');
const { WEBHOOK_PATH } = require('../../config/payments');

/**
 * The Stripe webhook, over real HTTP.
 *
 * Three things about this route are arranged in server.js rather than in the route file,
 * which means they are exactly the things a unit test cannot see and a refactor can
 * silently undo:
 *
 *  1. the raw body parser is mounted BEFORE the JSON parser, so the signature can be
 *     checked against the bytes Stripe actually sent;
 *  2. the route is exempt from CSRF, so a request with no token is answered on its
 *     signature rather than rejected at the door;
 *  3. a bad signature is a 400, not a 500 and not a crash.
 *
 * This app reproduces that composition. If server.js stops matching it, these pass while
 * production breaks — so the arrangement is asserted here AND read from the same
 * constant server.js uses.
 */
function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));

  // (1) Raw first. body-parser marks the request as read, so the JSON parser below skips it.
  app.use(WEBHOOK_PATH, express.raw({ type: 'application/json', limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // A session stub: enough for csrfProtection, which needs somewhere to keep its secret.
  app.use((req, res, next) => {
    req.session = { csrfSecret: 'a-fixed-secret-for-this-test' };
    req.flash = () => {};
    res.locals.appName = 'Salesforce Hub';
    res.locals.supportEmail = 'support@example.com';
    // server.js sets these for every request; the error pages include the layout,
    // which reads them. A missing global local should fail loudly, not be papered
    // over with a `typeof` guard in the template.
    res.locals.assistantEnabled = false;
    res.locals.assistantMaxChars = 2000;
    res.locals.currentUser = null;
    res.locals.currentPath = req.path;
    res.locals.flash = { success: [], error: [], info: [] };
    res.locals.seo = {
      title: 't',
      description: 'd',
      canonical: 'http://x/',
      ogImage: 'http://x/o.png',
      indexable: false
    };
    next();
  });

  // (2) The exemption, written exactly as server.js writes it.
  app.use(csrfProtection({ exempt: (req) => req.path === WEBHOOK_PATH }));

  app.use('/payments', require('../../routes/payments'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

describe('the Stripe webhook', () => {
  const app = buildApp();

  it('is exempt from CSRF: an unsigned POST is judged on its signature, not on a token', async () => {
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'checkout.session.completed' }));

    // 403 here would mean the CSRF middleware rejected it before the signature check ran,
    // which is the failure mode that makes every real Stripe delivery bounce.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });

  it('rejects a forged signature with 400 rather than 500', async () => {
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=deadbeef')
      .send(JSON.stringify({ type: 'checkout.session.completed', id: 'evt_forged' }));

    expect(res.status).toBe(400);
  });

  it('receives the body as a raw Buffer, because a re-serialised body cannot verify', async () => {
    // Proven from the inside: the handler is reached with req.body still a Buffer.
    const seen = [];
    const probe = express();
    probe.use(WEBHOOK_PATH, express.raw({ type: 'application/json', limit: '1mb' }));
    probe.use(express.json());
    probe.post(WEBHOOK_PATH, (req, res) => {
      seen.push(Buffer.isBuffer(req.body));
      res.json({ ok: true });
    });

    await request(probe)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ hello: 'world' }));

    expect(seen).toEqual([true]);
  });

  it('does not extend its CSRF exemption to the checkout route next door', async () => {
    /*
     * The exemption is for one path. If it ever widened, this is what would notice.
     *
     * `Sec-Fetch-Dest: empty` is set DELIBERATELY: a failed guard answers a background
     * fetch with 403 JSON and a top-level navigation with a 302 to somewhere useful. A
     * plain HTTP client sends no such header and is therefore treated as a navigation,
     * so a test that asserts 403 must say which of the two it is asking for.
     */
    const res = await request(app)
      .post('/payments/checkout/job_feature')
      .set('Sec-Fetch-Dest', 'empty')
      .type('form')
      .send({ subjectId: '1' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/session expired/i);
  });
});
