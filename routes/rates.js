'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const RateSubmission = require('../models/RateSubmission');
const Job = require('../models/Job');
const Application = require('../models/Application');
const TaxProgram = require('../models/TaxProgram');
const rateModel = require('../config/rateModel');
const taxProgram = require('../config/taxProgram');
const { countryGroups } = require('../config/regions');
const { inputsFrom, benchmark, confidenceFor, positionBar, benchmarkProblems } = require('../utils/rateBenchmark');
const { TREND_WINDOWS, meanOfPeople } = require('../utils/rateAggregation');
const { trendGeometry } = require('../utils/rateCharts');
const { contractBudgets, permanentSalaries } = require('../utils/jobRates');
const { isAuthenticated, isConsultant, isEmailVerified } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { ROLE_CATEGORIES, ROLE_SLUGS, isValidRole, seniorityForYears } = require('../config/roleTaxonomy');
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

/** "Day rate budgets" period filter: a declared list, so it can never become an interval string. */
const JOB_WINDOWS = Object.freeze([
  { value: '30', label: '30 days' },
  { value: '84', label: '12 weeks' },
  { value: '365', label: '12 months' }
]);

/** Plausibility per engagement: the commonest wrong figure is an annual salary typed as a day rate. */
const AMOUNT_BOUNDS = Object.freeze({
  contract: { min: 50, max: 5000 },
  permanent: { min: 5000, max: 1000000 }
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function bucketLabel(key) {
  if (/^\d{4}-\d{2}$/.test(key)) return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`;
  return key;
}

/**
 * Every query parameter the page understands, validated once. The page has several GET forms
 * (index filters, the benchmark, the trend chart, job budgets) and each carries the others'
 * state as hidden fields, so changing one never resets the rest. Only these validated values
 * are ever echoed back — never the raw query.
 */
function stateFrom(query) {
  const role = isValidRole(query.role) ? query.role : '';
  const state = {
    role,
    seniority: SENIORITIES.includes(query.seniority) ? query.seniority : '',
    engagement_type: query.engagement_type === 'permanent' ? 'permanent' : '',
    country: /^[A-Z]{2}$/.test(query.country || '') ? query.country : '',
    t_role: isValidRole(query.t_role) ? query.t_role : '',
    t_window: Object.prototype.hasOwnProperty.call(TREND_WINDOWS, query.t_window) ? query.t_window : '',
    j_role: isValidRole(query.j_role) ? query.j_role : '',
    j_days: JOB_WINDOWS.some((w) => w.value === query.j_days) ? query.j_days : ''
  };
  const bench = inputsFrom(query);
  if (bench) {
    Object.assign(state, {
      b_role: bench.role,
      b_exp: bench.experience,
      b_region: bench.region,
      b_certs: String(bench.certifications),
      b_skills: String(bench.skills),
      b_mode: bench.arrangement,
      b_industry: bench.industry,
      b_contract: bench.contractType
    });
  }
  return { state, bench };
}

/** Hidden inputs for every set value except those whose name starts with one of `prefixes`. */
function keepExcept(state, prefixes) {
  return Object.entries(state).filter(
    ([name, value]) => value !== '' && value !== undefined && !prefixes.some((p) => (p === '' ? false : name === p || name.startsWith(p)))
  );
}

/**
 * Everything /rates shows, from one place, so a refused share can re-render the page with
 * the visitor's answer intact instead of a redirect that loses it.
 */
async function renderIndex(req, res, { status = 200, shareErrors = [], shareForm = {} } = {}) {
  const { state, bench: benchInputs } = stateFrom(req.query);
  const filters = {
    role: state.role,
    seniority: state.seniority,
    engagementType: state.engagement_type || 'contract',
    country: state.country
  };
  const tWindow = state.t_window || '12m';
  const jDays = Number(state.j_days || '365');

  // The editorial model, re-checked before it is shown, exactly as an estimate is.
  const bench = benchmark(benchInputs);
  const problems = benchmarkProblems(bench);
  if (problems.length) {
    const err = new Error(`Rate benchmark failed its own check: ${problems.join('; ')}`);
    err.status = 500;
    throw err;
  }

  const [
    contributors, heroSummary, summary, byRole, bySeniority, byRegion, trend, contractByRole,
    benchMarket, askedRows, contractJobRows, permanentJobRows, topCountries
  ] = await Promise.all([
    RateSubmission.totalContributors(),
    RateSubmission.summary({ engagementType: 'contract' }),
    RateSubmission.summary(filters),
    RateSubmission.byRole(filters),
    RateSubmission.bySeniority(filters),
    RateSubmission.byRegion(filters),
    RateSubmission.trendWindow({ role: state.t_role, engagementType: 'contract' }, tWindow),
    RateSubmission.byRole({ engagementType: 'contract' }),
    bench
      ? RateSubmission.summary({ role: bench.inputs.role, seniority: bench.inputs.experience, engagementType: 'contract' })
      : Promise.resolve(null),
    Application.askedDayRates(),
    Job.rateRows({ engagement_type: 'contract', role: state.j_role || undefined, posted_within_days: jDays }),
    Job.rateRows({ engagement_type: 'permanent' }),
    TaxProgram.topConsultantCountries().catch(() => [])
  ]);

  const toEur = RateSubmission.toEur;
  const asked = meanOfPeople(askedRows.map((r) => ({ user_id: r.user_id, amount_eur: toEur(Number(r.day_rate), r.currency || 'EUR') })));

  res.status(status).render('rates/index', {
    title: res.locals.seo.title,
    state,
    keepExcept: (prefixes) => keepExcept(state, prefixes),
    filters,
    contributors,
    heroSummary,
    summary,
    byRole,
    bySeniority,
    byRegion,
    regionLabels: new Map([...rateModel.REGIONS.map((r) => [r.value, r.label]), ['other', 'Other countries']]),
    trend,
    trendChart: trendGeometry(trend, { formatLabel: bucketLabel }),
    trendWindows: TREND_WINDOWS,
    tWindow,
    ratesByRole: contractByRole.filter((r) => !r.suppressed),
    bench,
    benchMarket,
    benchConfidence: bench ? confidenceFor(benchMarket && benchMarket.contributors) : null,
    benchBar: bench ? positionBar(bench.recommended, benchMarket) : null,
    model: rateModel,
    asked,
    budgets: contractBudgets(contractJobRows, toEur),
    salaries: permanentSalaries(permanentJobRows, toEur),
    jobWindows: JOB_WINDOWS,
    jDays: String(jDays),
    programFee: taxProgram.pageModel().fee,
    minSample: MIN_SAMPLE,
    roleCategories: ROLE_CATEGORIES,
    seniorities: SENIORITIES,
    countryGroups: countryGroups(countries, topCountries),
    shareErrors,
    shareForm,
    amountBounds: AMOUNT_BOUNDS
  });
}

router.get('/', asyncHandler((req, res) => renderIndex(req, res)));

/**
 * The share form now lives on /rates itself (#share). This address stays as a redirect for
 * the links and bookmarks that point at it.
 */
router.get('/submit', (req, res) => res.redirect(301, '/rates#share'));

/**
 * POST /rates/submit — the inline "Share my rate" form.
 *
 * Five answers: role, engagement, the figure, years of experience and (optionally) the
 * country. The seniority band is DERIVED from the years with the same `seniorityForYears`
 * the profile uses, so the index and the directory agree about who is "senior". The figure is
 * EUR; a contract figure above a day-rate ceiling, or a permanent one below a salary floor, is
 * refused by name — the commonest wrong submission is an annual salary in a day-rate field,
 * and it moves a published percentile for everybody.
 */
router.post(
  '/submit',
  isAuthenticated,
  isConsultant,
  isEmailVerified,
  writeLimiter,
  [
    body('role').isIn(ROLE_SLUGS).withMessage('Choose your role.'),
    body('engagement_type').isIn(['contract', 'permanent']).withMessage('Choose contract or permanent.'),
    body('years').isInt({ min: 0, max: 60 }).withMessage('Enter your years of experience as a whole number.'),
    body('amount').isFloat({ min: 1, max: 1000000 }).withMessage('Enter the amount as a number.'),
    body('country').optional({ values: 'falsy' }).matches(/^[A-Z]{2}$/).withMessage('Choose a country from the list.')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req).array().map((e) => e.msg);
    const engagement = req.body.engagement_type === 'permanent' ? 'permanent' : 'contract';
    const amount = Number(req.body.amount);
    const bounds = AMOUNT_BOUNDS[engagement];
    if (!errors.length && (amount < bounds.min || amount > bounds.max)) {
      errors.push(
        engagement === 'contract'
          ? `A day rate between €${bounds.min} and €${bounds.max}, please. If that is a yearly figure, choose Permanent.`
          : `An annual salary of at least €${bounds.min.toLocaleString('en-GB')}, please. If that is a day rate, choose Contract.`
      );
    }
    if (errors.length) {
      return renderIndex(req, res, {
        status: 422,
        shareErrors: [...new Set(errors)],
        shareForm: {
          role: String(req.body.role || ''),
          engagement_type: engagement,
          amount: String(req.body.amount || ''),
          years: String(req.body.years || ''),
          country: String(req.body.country || '')
        }
      });
    }

    await RateSubmission.submit(req.session.user.id, {
      role: req.body.role,
      seniority: seniorityForYears(Number(req.body.years)),
      engagementType: engagement,
      workMode: null,
      country: req.body.country || null,
      amount,
      currency: 'EUR'
    });

    req.flash(
      'success',
      `Thank you. Your figure counts towards this month, and no group is shown until at least ${config.rates.minSampleSize} people are in it.`
    );
    return res.redirect(`/rates?role=${encodeURIComponent(req.body.role)}#community`);
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
