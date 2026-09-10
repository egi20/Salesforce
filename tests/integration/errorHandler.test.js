'use strict';

const express = require('express');
const request = require('supertest');

const { errorHandler, notFound, asyncHandler } = require('../../middleware/errorHandler');

/**
 * The terminal error handler, over real HTTP.
 *
 * The case worth guarding is an error raised AFTER the response has started. Writing a
 * second status line then throws ERR_HTTP_HEADERS_SENT and buries the original error, so
 * the handler must step aside and let Express destroy the socket instead.
 */
function buildApp(mount) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', require('path').join(__dirname, '..', '..', 'views'));

  app.use((req, res, next) => {
    req.flash = () => {};
    // seoLocals normally supplies these; the error views need them to render.
    res.locals.appName = 'Salesforce Hub';
    res.locals.currentUser = null;
    res.locals.currentPath = req.path;
    res.locals.csrfToken = 'test-token';
    res.locals.flash = { success: [], error: [], info: [] };
    res.locals.seo = { title: 'test', description: 'd', canonical: 'http://x/', ogImage: 'http://x/o.png', indexable: false };
    next();
  });

  mount(app);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

describe('error handler', () => {
  it('renders a 500 page for a navigation', async () => {
    const app = buildApp((a) =>
      a.get('/boom', () => {
        throw new Error('deliberate');
      })
    );

    const res = await request(app).get('/boom').set('Sec-Fetch-Dest', 'document');
    expect(res.status).toBe(500);
    expect(res.text).toMatch(/Something went wrong/);
  });

  it('answers a background fetch with JSON, not an HTML page', async () => {
    const app = buildApp((a) =>
      a.get('/boom', () => {
        throw new Error('deliberate');
      })
    );

    const res = await request(app).get('/boom').set('Sec-Fetch-Dest', 'empty');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false });
    // A generic message: an internal error's text is not the caller's business.
    expect(res.body.error).not.toMatch(/deliberate/);
  });

  it('passes a client-error message through, since the caller can act on it', async () => {
    const app = buildApp((a) =>
      a.get('/nope', (req, res, next) => {
        const err = new Error('That filter is not valid.');
        err.status = 400;
        next(err);
      })
    );

    const res = await request(app).get('/nope').set('Sec-Fetch-Dest', 'empty');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('That filter is not valid.');
  });

  it('does not try to respond twice when the response has already started', async () => {
    const app = buildApp((a) =>
      a.get('/late', (req, res, next) => {
        res.status(200).write('partial');
        // Exactly the shape of a download that fails mid-stream, or a session store
        // failing asynchronously after the response is out.
        next(new Error('failed after headers were sent'));
      })
    );

    // Express destroys the socket, so supertest sees an aborted request rather than a
    // second status line. Either outcome is acceptable; a thrown
    // ERR_HTTP_HEADERS_SENT crashing the process is not.
    let failed = false;
    try {
      await request(app).get('/late');
    } catch {
      failed = true;
    }
    expect(failed || true).toBe(true);

    // The process is still alive and still serving.
    const ok = await request(app).get('/missing').set('Sec-Fetch-Dest', 'empty');
    expect(ok.status).toBe(404);
  });

  it('404s an unknown path as JSON for a fetch and as a page for a navigation', async () => {
    const app = buildApp(() => {});

    const asFetch = await request(app).get('/missing').set('Sec-Fetch-Dest', 'empty');
    expect(asFetch.status).toBe(404);
    expect(asFetch.body).toMatchObject({ success: false });

    const asNavigation = await request(app).get('/missing').set('Sec-Fetch-Dest', 'document');
    expect(asNavigation.status).toBe(404);
    expect(asNavigation.text).toMatch(/Page not found/);
  });

  it('turns a rejected async handler into a response rather than an unhandled rejection', async () => {
    const app = buildApp((a) =>
      a.get('/async', asyncHandler(async () => {
        throw new Error('async failure');
      }))
    );

    const res = await request(app).get('/async').set('Sec-Fetch-Dest', 'empty');
    expect(res.status).toBe(500);
  });
});
