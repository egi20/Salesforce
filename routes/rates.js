'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const RateSubmission = require('../models/RateSubmission');
const { isAuthenticated, isConsultant, isEmailVerified } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { ROLE_CATEGORIES, ROLE_SLUGS, isValidRole, baseDayRate } = require('../config/roleTaxonomy');
const { MIN_SAMPLE } = require('../utils/rateAggregation');
const countries = require('../config/all-countries.json');
const config = require('../config/config');
const {
  project,
  rateForTarget,
  positionAgainstMarket,
  reconciliationProblems,
  DAY_CATEGORIES,
  COST_CATEGORIES
} = require('../utils/contractorEconomics');

const router = express.Router();

const SENIORITIES = ['junior', 'mid', 'senior', 'lead'];

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = {
      role: isValidRole(req.query.role) ? req.query.role : '',
      seniority: SENIORITIES.includes(req.query.seniority) ? req.query.seniority : '',
      engagementType: req.query.engagement_type === 'permanent' ? 'permanent' : 'contract',
      country: /^[A-Z]{2}$/.test(req.query.country || '') ? req.query.country : ''
    };

    const [summary, byRole, bySeniority, trend, contributors] = await Promise.all([
      RateSubmission.summary(filters),
      RateSubmission.byRole(filters),
      filters.role ? RateSubmission.bySeniority(filters) : Promise.resolve([]),
      filters.role ? RateSubmission.trend(filters) : Promise.resolve([]),
      RateSubmission.totalContributors()
    ]);

    res.render('rates/index', {
      title: res.locals.seo.title,
      filters,
      summary,
      byRole,
      bySeniority,
      trend,
      contributors,
      minSample: MIN_SAMPLE,
      roleCategories: ROLE_CATEGORIES,
      countries,
      // The editorial baseline is shown clearly labelled as editorial, never blended
      // into the contributed figures — mixing the two would make the index unfalsifiable.
      curatedBaseline: filters.role ? baseDayRate(filters.role) : null
    });
  })
);

router.get(
  '/submit',
  isAuthenticated,
  isConsultant,
  asyncHandler(async (req, res) => {
    const own = await RateSubmission.findOwnLatest(req.session.user.id);
    res.render('rates/submit', {
      title: 'Contribute your rate',
      own,
      roleCategories: ROLE_CATEGORIES,
      currencies: RateSubmission.SUPPORTED_CURRENCIES,
      countries,
      minSample: MIN_SAMPLE,
      errors: []
    });
  })
);

router.post(
  '/submit',
  isAuthenticated,
  isConsultant,
  isEmailVerified,
  writeLimiter,
  [
    body('role').isIn(ROLE_SLUGS).withMessage('Choose your role.'),
    body('seniority').isIn(SENIORITIES).withMessage('Choose your seniority.'),
    body('engagement_type').isIn(['contract', 'permanent']),
    body('work_mode').isIn(['remote', 'hybrid', 'onsite']),
    body('country').matches(/^[A-Z]{2}$/).withMessage('Choose your country.'),
    body('amount').isFloat({ min: 1, max: 1000000 }).withMessage('Enter the amount as a number.'),
    body('currency').isIn(RateSubmission.SUPPORTED_CURRENCIES).withMessage('Choose a supported currency.')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const own = await RateSubmission.findOwnLatest(req.session.user.id);
      return res.status(422).render('rates/submit', {
        title: 'Contribute your rate',
        own,
        roleCategories: ROLE_CATEGORIES,
        currencies: RateSubmission.SUPPORTED_CURRENCIES,
        countries,
        minSample: MIN_SAMPLE,
        errors: errors.array()
      });
    }

    await RateSubmission.submit(req.session.user.id, {
      role: req.body.role,
      seniority: req.body.seniority,
      engagementType: req.body.engagement_type,
      workMode: req.body.work_mode,
      country: req.body.country,
      amount: req.body.amount,
      currency: req.body.currency
    });

    req.flash(
      'success',
      `Thank you. Your figure counts towards this month, and no bucket is published until at least ${config.rates.minSampleSize} people have contributed to it.`
    );
    return res.redirect(`/rates?role=${encodeURIComponent(req.body.role)}`);
  })
);

/**
 * GET /rates/calculator — what a day rate is actually worth over a year.
 *
 * PUBLIC and stateless. Public because the question is asked before anyone signs up, and
 * because the rate index it compares against is public too. Stateless because the inputs
 * are somebody's private financial assumptions — what they expect to be ill, how long they
 * expect to sit on the bench — and there is no reason for this application to hold any of
 * that. The whole state is in the query string, which also makes a working through
 * shareable by copying the URL.
 *
 * The market comparison is READ from the index's own answer, so the n-person privacy floor
 * is applied exactly once, in `utils/rateAggregation.js`, and a suppressed bucket arrives
 * as null rather than as a zero to divide by.
 */
router.get(
  '/calculator',
  asyncHandler(async (req, res) => {
    const submitted = Object.keys(req.query).length > 0;

    const projection = project(req.query);
    /*
     * Re-checked before it is shown, exactly as `routes/quotes.js` re-checks an estimate:
     * a projection whose parts do not add up can only mean a bug in the engine, and
     * someone is about to plan a year around this.
     */
    const problems = reconciliationProblems(projection);
    if (problems.length) {
      const err = new Error(`Rate projection failed its own reconciliation: ${problems.join('; ')}`);
      err.status = 500;
      throw err;
    }

    const targetNet = Number(req.query.targetNet) || 0;
    const requiredRate = targetNet > 0 ? rateForTarget(targetNet, req.query) : null;

    // Compare against the same bucket the index would show, when one was chosen.
    const role = isValidRole(req.query.role) ? req.query.role : '';
    const seniority = SENIORITIES.includes(req.query.seniority) ? req.query.seniority : '';
    let market = null;
    if (role) {
      const summary = await RateSubmission.summary({
        role,
        seniority,
        engagementType: 'contract',
        country: /^[A-Z]{2}$/.test(req.query.country || '') ? req.query.country : ''
      });
      // `median` is null for a bucket below the floor. positionAgainstMarket answers null
      // for that, and the view says "not enough contributors" rather than showing a zero.
      market = {
        summary,
        position: positionAgainstMarket(projection.assumptions.dayRate, summary && summary.median)
      };
    }

    return res.render('rates/calculator', {
      title: 'Contract rate calculator',
      submitted,
      projection,
      targetNet,
      requiredRate,
      market,
      role,
      seniority,
      country: /^[A-Z]{2}$/.test(req.query.country || '') ? req.query.country : '',
      dayCategories: DAY_CATEGORIES,
      costCategories: COST_CATEGORIES,
      roleCategories: ROLE_CATEGORIES,
      seniorities: SENIORITIES,
      countries,
      minSample: MIN_SAMPLE
    });
  })
);

module.exports = router;
