'use strict';

const rateLimit = require('express-rate-limit');
const { returnTo } = require('../utils/returnTo');

/**
 * IP-keyed limiters for the endpoints an attacker hits in bulk.
 *
 * The keying matters and is the documented pitfall from the reference implementation:
 * with `saveUninitialized: false` an anonymous visitor has no session, so a
 * SESSION-keyed limiter on a public endpoint counts every cookie-less request into the
 * same non-existent bucket and protects nothing. Public endpoints are keyed by IP.
 *
 * `trust proxy` must be set correctly for `req.ip` to be the client rather than the
 * load balancer; server.js does that in production.
 */
function ipLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: message },
    handler: (req, res, next, options) => {
      if (req.accepts(['html', 'json']) === 'html') {
        req.flash('error', message);
        return res.status(options.statusCode).redirect(returnTo(req, '/'));
      }
      return res.status(options.statusCode).json(options.message);
    }
  });
}

const loginLimiter = ipLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.'
});

const registerLimiter = ipLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many accounts created from this address. Please try again later.'
});

const passwordLimiter = ipLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many password requests. Please try again later.'
});

const writeLimiter = ipLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: 'You are doing that too quickly. Please slow down.'
});

module.exports = { ipLimiter, loginLimiter, registerLimiter, passwordLimiter, writeLimiter };
