'use strict';

const express = require('express');

const config = require('../config/config');
const countries = require('../config/all-countries.json');
const email = require('../utils/email');
const TaxEnquiry = require('../models/TaxEnquiry');
const { ipLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { returnTo } = require('../utils/returnTo');
const { PRIVACY_VERSION } = require('../config/legal-versions');
const { ARRANGEMENTS, LIMITS, PROMISE, RETENTION_DAYS, TOPICS } = require('../config/taxAdvisory');

const router = express.Router();

/**
 * Tax advisory: an INTRODUCTION, not a calculation.
 *
 * There is no `POST /calculate` in this file and there will not be one. The reference
 * implementation's version takes the gross and net a visitor types, subtracts a flat
 * admin-editable percentage of gross, and presents the difference as a monthly and annual
 * saving — for anyone, in any country, under any arrangement. `config/taxAdvisory.js`
 * sets out why that number is worse than no number, and `utils/contractorEconomics.js`
 * already carries the same refusal with a test behind it.
 *
 * What this replaces it with is the honest half of the same product: somebody says what
 * their situation is, and a specialist who works in their jurisdiction gets in touch.
 *
 * Everything is public. Most people asking how they should be set up have not signed up
 * to anything, and putting the question behind a registration wall would collect an
 * account instead of answering a question.
 */

/**
 * Tighter than `writeLimiter`, because this endpoint is anonymous AND it creates rows
 * that a person then has to read. Thirty a minute would be a queue full of nonsense from
 * one address before anyone noticed.
 */
const enquiryLimiter = ipLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'You have sent several enquiries already. Please give us a chance to reply first.'
});

function pageLocals() {
  return {
    topics: TOPICS,
    arrangements: ARRANGEMENTS,
    countries,
    limits: LIMITS,
    promise: PROMISE,
    retentionDays: RETENTION_DAYS
  };
}

/** GET /tax-advisory — what the service is, and in the same breath what it is not. */
router.get('/', (req, res) => {
  res.render('tax/index', {
    title: 'Tax advisory for Salesforce contractors',
    ...pageLocals()
  });
});

/**
 * GET /tax-advisory/enquire — the form.
 *
 * Prefilled from the session when there is one, because asking a signed-in person to
 * retype their own name is friction with nothing behind it. Prefilled ONLY with name and
 * email: the reference also reaches into the consultant profile, which is a different
 * source of truth appearing in a field the person then has to notice and correct.
 */
router.get('/enquire', (req, res) => {
  const user = req.session.user;
  res.render('tax/enquire', {
    title: 'Ask about your setup',
    form: {
      fullName: user ? user.name || '' : '',
      email: user ? user.email || '' : '',
      phone: '',
      country: '',
      topic: '',
      arrangement: '',
      question: ''
    },
    ...pageLocals()
  });
});

/**
 * POST /tax-advisory/enquire.
 *
 * An ordinary browser POST from a page on this origin, so it goes through CSRF like every
 * other form. Validation lives in `TaxEnquiry.normaliseSubmission`, which is pure and
 * tested, so the rules cannot differ between this handler and anything else that ever
 * writes an enquiry.
 *
 * Note what is NOT read out of the body: there is no `estimatedMonthlySavings`. The
 * reference has one, and its value is whatever the client-side calculator posted back —
 * a figure the browser chose, stored on a record next to a person's name.
 */
router.post(
  '/enquire',
  enquiryLimiter,
  asyncHandler(async (req, res) => {
    const submitted = {
      fullName: req.body.full_name,
      email: req.body.email,
      phone: req.body.phone,
      country: req.body.country,
      topic: req.body.topic,
      arrangement: req.body.arrangement,
      question: req.body.question,
      consent: req.body.consent === 'on',
      consentVersion: PRIVACY_VERSION
    };

    // Named explicitly rather than matched by shape. A pattern like /^[A-Z_]+$/ also
    // matches `ECONNREFUSED` and `ER_LOCK_WAIT_TIMEOUT`, which would render a database
    // outage to the visitor as a form validation error — and hide it from the error log.
    const VALIDATION_CODES = [
      'NAME_REQUIRED',
      'EMAIL_INVALID',
      'COUNTRY_REQUIRED',
      'TOPIC_INVALID',
      'ARRANGEMENT_INVALID',
      'QUESTION_TOO_SHORT',
      'CONSENT_REQUIRED'
    ];

    let result;
    try {
      result = await TaxEnquiry.create(submitted, { userId: req.session.user?.id || null });
    } catch (err) {
      if (!VALIDATION_CODES.includes(err.code)) throw err;

      // Re-render rather than redirect, so nobody retypes a long answer because they
      // forgot a checkbox. The submitted values come back escaped through the template.
      return res.status(400).render('tax/enquire', {
        title: 'Ask about your setup',
        error: err.message,
        form: {
          fullName: req.body.full_name || '',
          email: req.body.email || '',
          phone: req.body.phone || '',
          country: req.body.country || '',
          topic: req.body.topic || '',
          arrangement: req.body.arrangement || '',
          question: req.body.question || ''
        },
        ...pageLocals()
      });
    }

    // Both sends are fire-and-forget: `utils/email.js` returns failures rather than
    // throwing, because the enquiry is already recorded and a mail server having a bad
    // afternoon must not lose it.
    email.send({
      to: result.email,
      subject: `We have your enquiry — ${config.app.name}`,
      template: 'tax-enquiry-received',
      locals: {
        name: result.fullName,
        retentionDays: RETENTION_DAYS,
        appName: config.app.name
      }
    });

    if (config.taxAdvisory.notifyEmail) {
      email.send({
        to: config.taxAdvisory.notifyEmail,
        subject: `New tax advisory enquiry (#${result.id})`,
        template: 'tax-enquiry-internal',
        locals: {
          // The notification carries an ID and a link, never the enquiry itself. An email
          // is the one copy of a record nobody can later delete, and this record has a
          // retention promise on it.
          enquiryId: result.id,
          adminUrl: `${config.app.baseUrl}/admin/tax-advisory?q=${encodeURIComponent(result.email)}`,
          appName: config.app.name
        }
      });
    }

    req.flash(
      'success',
      result.created
        ? 'Thank you — your enquiry is with us. We will introduce you to somebody who works in your country.'
        : 'Thank you — we have updated the enquiry you already had open with us.'
    );
    return res.redirect(returnTo(req, '/tax-advisory'));
  })
);

module.exports = router;
