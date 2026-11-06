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
const { ARRANGEMENTS, LIMITS, PROGRAM_TOPIC, RETENTION_DAYS, TOPICS, isTopic } = require('../config/taxAdvisory');
const taxProgram = require('../config/taxProgram');
const TaxProgram = require('../models/TaxProgram');

const router = express.Router();

/**
 * Tax optimization: the Albania employment program, and the enquiry that applies to it.
 *
 * There is no `POST /calculate` in this file and there will not be one. The page's
 * take-home calculator runs in the browser (`public/js/tax-calculator.js`) on the program's
 * own payroll parameters from `config/tax-program.json`; what somebody types into it is
 * never sent here, so there is nothing to store and nothing to leak. With no parameters
 * configured the page says the calculator is coming rather than showing a number. See
 * `config/taxProgram.js` for why this is not the reference's flat-percentage "saving".
 *
 * "Apply now" and "Contact us" are both the enquiry form below — the program topic
 * preselected for the first. Six questions, none of them about pay.
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
    programTopic: PROGRAM_TOPIC,
    retentionDays: RETENTION_DAYS
  };
}

/**
 * A read for a public page that is allowed to fail: a missing section, logged, never a
 * failed page. A story section that is down is simply not shown — showing "no stories"
 * would be a different claim.
 */
async function optional(label, read, fallback) {
  try {
    return await read();
  } catch (err) {
    console.warn(`tax-advisory: ${label} unavailable: ${err.message}`);
    return fallback;
  }
}

/**
 * GET /tax-advisory — the program, its calculator, and who it is for.
 *
 * Every figure on the page comes from `config/tax-program.json` or from the database, and a
 * figure that is not there is not shown. Stories appear only with consent; the participant
 * count only from `ACTIVE_COUNT_FLOOR` upwards, because "3 active consultants" is a number
 * that argues against itself.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const program = taxProgram.pageModel();
    const monthsPerYear = program.payroll ? program.payroll.monthsPerYear : 12;
    const [stories, active] = await Promise.all([
      optional('stories', () => TaxProgram.liveStories({ monthsPerYear }), []),
      optional('participant count', () => TaxProgram.activeCount(), 0)
    ]);
    res.render('tax/index', {
      title: 'Tax optimization',
      program,
      stories,
      activeConsultants: active >= taxProgram.ACTIVE_COUNT_FLOOR ? active : null,
      money: taxProgram.money,
      ...pageLocals()
    });
  })
);

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
  // `?topic=program` is what "Apply now" links to. Anything that is not a declared topic is
  // ignored rather than echoed into the form.
  const topic = isTopic(req.query.topic) ? req.query.topic : '';
  res.render('tax/enquire', {
    title: topic === PROGRAM_TOPIC ? 'Apply to the program' : 'Ask about your setup',
    form: {
      fullName: user ? user.name || '' : '',
      email: user ? user.email || '' : '',
      phone: '',
      country: '',
      topic,
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
        title: req.body.topic === PROGRAM_TOPIC ? 'Apply to the program' : 'Ask about your setup',
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
