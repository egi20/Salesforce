'use strict';

const ErrorLog = require('../models/ErrorLog');
const config = require('../config/config');
const { isNavigation } = require('./auth');
const { returnTo } = require('../utils/returnTo');
const { routeExists } = require('../utils/routeExists');

function notFound(req, res) {
  if (!isNavigation(req)) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  return res.status(404).render('errors/404', { title: 'Page not found' });
}

/**
 * A CSRF refusal from a scanner is not an error — it is the defence working — and writing
 * them down buries the one refusal that matters, a real form failing for real people. SAP
 * Hub's production log was nothing but these (POST /graphql, /xmlrpc.php, /api, POST /), and
 * this site sits on the same internet. The rule, in the order SAP Hub learned it:
 *
 *  1. No route here answers that path. A real form only ever posts to a route that exists,
 *     so a refusal on /graphql is a scanner whatever headers it sent — the one test a
 *     headless browser cannot pass. `routeExists` asks the router itself and answers yes
 *     when unsure, so an unknown shape never hides a real failure.
 *  2. No session cookie. Every form is served from a page that issues `sfhub.sid`.
 *  3. The cookie but no person: not signed in and no `Sec-Fetch-Site`, which every current
 *     browser sends on a form post. Every response sets the cookie, a 404 included, so a
 *     scanner with a cookie jar carries one.
 *
 * Those still get the 403; they are just not written down.
 */
function isScannerCsrfRefusal(err, req) {
  if (!err || err.code !== 'EBADCSRFTOKEN') return false;
  if (req.app && !routeExists(req.app, req.method, req.path)) return true;
  if (!/(?:^|;\s*)sfhub\.sid=/.test(req.get('cookie') || '')) return true;
  const signedIn = Boolean(req.session && req.session.user);
  return !signedIn && !req.get('sec-fetch-site');
}

/**
 * Terminal error handler.
 *
 * Never leaks a stack trace to a browser in production, always records the error, and
 * gives a CSRF rejection its own message so the person is told to reload rather than
 * shown a generic failure they cannot act on.
 */
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    console.error(err);
  }

  /*
   * If the response has already started, there is nothing useful left to send: writing a
   * second status line throws ERR_HTTP_HEADERS_SENT and the original error is lost behind
   * it. Express's default handler is the only correct move — it destroys the socket so the
   * client sees a truncated response rather than a mangled one.
   *
   * This happens more often than it sounds: an error surfacing after a file download has
   * begun streaming, or a session store failing asynchronously once the response is out.
   * Found by rendering real pages in a browser against an unreachable database, where the
   * store's late failure landed here after a 404 had already been sent.
   */
  if (res.headersSent) {
    ErrorLog.record(err, req, status);
    return next(err);
  }
  // Fire and forget: persisting the log must not delay or break the response.
  if (!isScannerCsrfRefusal(err, req)) ErrorLog.record(err, req, status);

  if (err.code === 'EBADCSRFTOKEN') {
    if (!isNavigation(req)) {
      return res.status(403).json({ success: false, error: 'Your session expired. Please reload the page.' });
    }
    req.flash('error', 'Your session expired. Please try again.');
    return res.redirect(returnTo(req, '/'));
  }

  if (!isNavigation(req)) {
    return res.status(status).json({
      success: false,
      error: status >= 500 ? 'Something went wrong.' : err.message
    });
  }

  return res.status(status).render('errors/500', {
    title: 'Something went wrong',
    message: status >= 500 ? 'Something went wrong on our side.' : err.message,
    stack: config.isProduction ? null : err.stack
  });
}

/** Wrap an async route handler so a rejected promise reaches the error handler. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { isScannerCsrfRefusal, notFound, errorHandler, asyncHandler };
