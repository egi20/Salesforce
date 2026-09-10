'use strict';

const express = require('express');

const assistant = require('../utils/assistant');
const assistantConfig = require('../config/assistant');
const ErrorLog = require('../models/ErrorLog');
const { ipLimiter, globalLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

/**
 * The in-site assistant.
 *
 * Open to anonymous visitors on purpose — most of the questions it answers are "what is
 * this site" and "where do I start", which are asked before anyone signs up. That makes
 * it a PUBLIC endpoint that costs money per request, so it carries three independent
 * bounds rather than one:
 *
 *  1. per-IP rate limiting;
 *  2. a process-wide backstop, because a distributed flood keeps every individual address
 *     under the per-IP limit;
 *  3. a month-to-date spend cap read from a shared ledger (`utils/aiBudget.js`), which is
 *     the only one of the three that actually bounds the invoice.
 *
 * The per-IP limiter is keyed on the IP and NOT on the session id. With
 * `saveUninitialized: false` a cookie-less flood gets a fresh session id per request, so
 * a session-keyed counter never accumulates and protects nothing. On a paid endpoint that
 * is not a rate-limiting bug, it is a way to run up someone else's bill.
 *
 * There are no database tables for conversations. History lives in the visitor's own
 * sessionStorage and is posted back with each message, capped and re-validated server-side
 * before it reaches the model. Storing chat transcripts would mean holding whatever people
 * type into a support box, indefinitely, for a feature that answers questions about
 * public pages.
 */

const chatIpLimiter = ipLimiter({
  windowMs: assistantConfig.RATE_WINDOW_MS,
  max: assistantConfig.RATE_MAX_PER_IP,
  message: 'You are sending messages too quickly. Please wait a few minutes.'
});

const chatGlobalLimiter = globalLimiter({
  windowMs: assistantConfig.RATE_WINDOW_MS,
  max: assistantConfig.RATE_MAX_GLOBAL,
  message: 'The assistant is very busy right now. Please try again in a few minutes.'
});

router.post(
  '/chat',
  chatIpLimiter,
  chatGlobalLimiter,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const message = typeof body.message === 'string' ? body.message.trim() : '';

    if (!message || message.length > assistantConfig.MAX_MESSAGE_CHARS) {
      return res.status(400).json({
        success: false,
        error: `Please write between 1 and ${assistantConfig.MAX_MESSAGE_CHARS} characters.`
      });
    }

    if (!assistant.isConfigured()) {
      // 503, not 500: nothing is broken, the feature is simply not switched on here.
      return res.status(503).json({ success: false, error: 'The assistant is not available.' });
    }

    try {
      const { reply } = await assistant.ask({
        message,
        history: body.history,
        user: req.session.user || null
      });

      if (!reply) {
        return res.status(502).json({
          success: false,
          error: 'The assistant could not produce an answer. Please try again.'
        });
      }

      return res.json({ success: true, reply });
    } catch (err) {
      if (err.code === 'BUDGET_EXCEEDED') {
        // A deliberate pause, not an outage, so the visitor gets the real reason rather
        // than a generic failure they cannot act on. 429 because it is "come back later".
        console.warn(`Assistant: budget block (${err.scope}) shown to a visitor`);
        return res.status(429).json({ success: false, error: err.message, code: 'BUDGET_EXCEEDED' });
      }

      // Deliberately not re-thrown into the error handler: this is a JSON endpoint for a
      // widget, and a rendered 500 page is not something the widget can display.
      console.error(`Assistant: chat failed — ${err.message}`);
      await ErrorLog.record(err, req, 502);
      return res.status(502).json({
        success: false,
        error: 'The assistant could not answer right now. Please try again in a moment.'
      });
    }
  })
);

module.exports = router;
