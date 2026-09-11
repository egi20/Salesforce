'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

const { csrfProtection } = require('../../middleware/csrf');
const { notFound, errorHandler } = require('../../middleware/errorHandler');

/**
 * The LinkedIn routes, over real HTTP, with NO credentials configured — which is how CI
 * and a fresh checkout run, and therefore the state that has to be safe.
 *
 * What is being pinned is the posture rather than the OAuth mechanics: every route
 * requires a session, so there is no path here that could become a sign-in method, and
 * nothing happens at all when the integration is switched off.
 */
function buildApp({ signedIn = false } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use(express.urlencoded({ extended: true }));

  app.use((req, res, next) => {
    req.session = { csrfSecret: 'a-fixed-secret-for-this-test' };
    if (signedIn) req.session.user = { id: 1, email: 'a@example.com', isConsultant: true };
    req.session.save = (cb) => cb();
    req.flash = () => {};
    res.locals.appName = 'Salesforce Hub';
    res.locals.supportEmail = 'support@example.com';
    res.locals.currentUser = req.session.user || null;
    res.locals.currentPath = req.path;
    res.locals.assistantEnabled = false;
    res.locals.assistantMaxChars = 2000;
    res.locals.linkedInEnabled = false;
    res.locals.flash = { success: [], error: [], info: [] };
    res.locals.seo = {
      title: 't', description: 'd', canonical: 'http://x/', ogImage: 'http://x/o.png', indexable: false
    };
    next();
  });

  app.use(csrfProtection());
  app.use('/linkedin', require('../../routes/linkedin'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

describe('LinkedIn is linking only, never a sign-in method', () => {
  const app = buildApp({ signedIn: false });

  it('refuses to START a flow for a visitor with no session', async () => {
    // A callback or a start that worked without a session would be a sign-in path by
    // another name, and with it the whole email-collision account-takeover class.
    const res = await request(app).get('/linkedin/start').set('Sec-Fetch-Dest', 'empty');
    expect(res.status).toBe(401);
  });

  it('refuses the CALLBACK for a visitor with no session', async () => {
    const res = await request(app)
      .get('/linkedin/callback?code=abc&state=xyz')
      .set('Sec-Fetch-Dest', 'empty');
    expect(res.status).toBe(401);
  });

  it('refuses a disconnect for a visitor with no session', async () => {
    const res = await request(app)
      .post('/linkedin/disconnect')
      .set('Sec-Fetch-Dest', 'empty')
      .set('X-CSRF-Token', 'a-fixed-secret-for-this-test')
      .send({});
    expect(res.status).toBe(401);
  });

  it('offers no route that creates an account', async () => {
    for (const route of ['/linkedin/login', '/linkedin/signin', '/linkedin/register']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(route).set('Sec-Fetch-Dest', 'empty');
      expect(res.status).toBe(404);
    }
  });
});

describe('with no credentials configured', () => {
  const app = buildApp({ signedIn: true });

  it('sends a signed-in member back with a message rather than to a broken LinkedIn URL', async () => {
    const res = await request(app).get('/linkedin/start').set('Sec-Fetch-Dest', 'document');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/profile/settings');
  });

  it('does not honour a forged callback', async () => {
    // No state in the session, so the comparison fails and nothing is written.
    const res = await request(app)
      .get('/linkedin/callback?code=stolen&state=guessed')
      .set('Sec-Fetch-Dest', 'document');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/profile/settings');
  });
});

describe('the disconnect route', () => {
  const app = buildApp({ signedIn: true });

  it('is CSRF-protected like every other mutation', async () => {
    // Sec-Fetch-Dest is set deliberately: a failed guard answers a background fetch with
    // JSON and a navigation with a redirect, so a test asserting a status must say which.
    const res = await request(app)
      .post('/linkedin/disconnect')
      .set('Sec-Fetch-Dest', 'empty')
      .send({});
    expect(res.status).toBe(403);
  });
});

describe('the return path', () => {
  const app = buildApp({ signedIn: true });

  it('never follows an off-site redirect handed to it in the query string', async () => {
    // returnTo is passed through safePath, so an attacker cannot use the OAuth entry
    // point as an open redirect.
    const res = await request(app)
      .get('/linkedin/start?returnTo=https%3A%2F%2Fevil.example%2Fx')
      .set('Sec-Fetch-Dest', 'document');
    expect(res.headers.location).not.toMatch(/evil\.example/);
  });
});
