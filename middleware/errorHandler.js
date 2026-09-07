'use strict';

const ErrorLog = require('../models/ErrorLog');
const config = require('../config/config');
const { isNavigation } = require('./auth');
const { returnTo } = require('../utils/returnTo');

function notFound(req, res) {
  if (!isNavigation(req)) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  return res.status(404).render('errors/404', { title: 'Page not found' });
}

/**
 * Terminal error handler.
 *
 * Never leaks a stack trace to a browser in production, always records the error, and
 * gives a CSRF rejection its own message so the person is told to reload rather than
 * shown a generic failure they cannot act on.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    console.error(err);
  }
  // Fire and forget: persisting the log must not delay or break the response.
  ErrorLog.record(err, req, status);

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

module.exports = { notFound, errorHandler, asyncHandler };
