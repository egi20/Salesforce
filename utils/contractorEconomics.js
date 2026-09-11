'use strict';

/**
 * What a day rate is actually worth over a year, and what rate a target requires.
 *
 * Pure — no database, no clock — for the same reason `utils/sowEstimation.js` is: the
 * invariants are the whole point and they have to be testable.
 *
 * ONE REFUSAL UP FRONT, and it shapes everything below: **this module does not compute
 * tax.** The reference implementation shipped a `calculateTaxSavings` that compared a
 * hard-coded 30% against a hard-coded 5% and presented the difference as a saving. Tax
 * depends on jurisdiction, entity type, VAT registration, dividend versus salary split
 * and personal circumstances; a number that LOOKS like tax advice but is a guess is worse
 * than no number, because people act on it. Everything here is pre-tax and says so.
 *
 * The invariants:
 *
 *  1. Billable days = working days − every category of non-billable day, EXACTLY. The
 *     parts sum to the whole, the way phase days do in the estimator.
 *  2. Net = revenue − costs, on integers, so the summary reconciles line by line.
 *  3. `rateForTarget` is the exact inverse of `project` under the same assumptions.
 *     Round-tripping a rate through both must land back on the rate.
 */

/**
 * Working days in a year, before anything is taken off.
 *
 * 260 is 52 × 5. It is a convention rather than a fact about any particular year — 2026
 * has 261 — and using the convention consistently matters more than being right about one
 * year, because every figure a contractor compares this against uses it too.
 */
const WORKING_DAYS_PER_YEAR = 260;

/** The bounds exist so a slider or a hand-typed number cannot produce nonsense. */
const LIMITS = Object.freeze({
  dayRate: { min: 1, max: 10000 },
  days: { min: 0, max: WORKING_DAYS_PER_YEAR },
  cost: { min: 0, max: 1000000 }
});

/**
 * The non-billable days, named rather than rolled into one "utilisation %".
 *
 * A single utilisation figure is the thing people get wrong: 80% sounds fine until you
 * notice it has to cover holiday, illness, the gap between contracts AND the unpaid time
 * spent finding the next one. Naming each category forces the estimate to be honest about
 * what it has actually allowed for.
 */
const DAY_CATEGORIES = Object.freeze([
  { key: 'holidayDays', label: 'Holiday', default: 25, help: 'Paid holiday is an employee benefit. Here it is simply days you do not invoice.' },
  { key: 'sickDays', label: 'Illness', default: 5, help: 'No sick pay unless you buy it.' },
  { key: 'benchDays', label: 'Between contracts', default: 20, help: 'The gap after one engagement ends and before the next starts. Optimism here is the most common mistake.' },
  { key: 'adminDays', label: 'Admin and business development', default: 10, help: 'Invoicing, accounts, proposals, interviews. Real days, unbillable.' },
  { key: 'trainingDays', label: 'Certification and training', default: 5, help: 'Salesforce releases three times a year; staying current is not free.' }
]);

/**
 * Annual running costs, likewise itemised.
 *
 * Every one of these is a real invoice a contractor pays, and all of them are commonly
 * left out of "my day rate × 220" arithmetic.
 */
const COST_CATEGORIES = Object.freeze([
  { key: 'insuranceCost', label: 'Insurance', default: 600, help: 'Professional indemnity and public liability. Many clients require it contractually.' },
  { key: 'accountingCost', label: 'Accounting', default: 1500, help: 'Company accounts, payroll, filings.' },
  { key: 'softwareCost', label: 'Software and subscriptions', default: 500, help: 'Laptop, tooling, a Salesforce developer org is free but not much else is.' },
  { key: 'trainingCost', label: 'Certification fees', default: 800, help: 'Exam fees and retakes, at roughly €200 each.' },
  { key: 'pensionCost', label: 'Pension contribution', default: 0, help: 'Nobody else is making one. Left at zero because it is a choice, not a cost.' },
  { key: 'otherCost', label: 'Everything else', default: 0, help: 'Travel you absorb, equipment, an office.' }
]);

function clamp(value, { min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

/** Whole currency units throughout: a contractor's annual figures do not need cents. */
function round(value) {
  return Math.round(Number(value) || 0);
}

/**
 * Normalise a submitted form into the assumption set the projection runs on.
 *
 * Every field is clamped rather than rejected, because this is a calculator someone is
 * playing with — a typo should move the answer, not produce an error page.
 */
function normaliseAssumptions(input = {}) {
  const out = {
    dayRate: clamp(input.dayRate, LIMITS.dayRate),
    workingDays: WORKING_DAYS_PER_YEAR
  };

  for (const { key, default: fallback } of DAY_CATEGORIES) {
    out[key] = round(clamp(input[key] === undefined || input[key] === '' ? fallback : input[key], LIMITS.days));
  }
  for (const { key, default: fallback } of COST_CATEGORIES) {
    out[key] = round(clamp(input[key] === undefined || input[key] === '' ? fallback : input[key], LIMITS.cost));
  }

  return out;
}

function nonBillableDays(assumptions) {
  return DAY_CATEGORIES.reduce((total, { key }) => total + (assumptions[key] || 0), 0);
}

function annualCosts(assumptions) {
  return COST_CATEGORIES.reduce((total, { key }) => total + (assumptions[key] || 0), 0);
}

/**
 * Project a year from a day rate.
 *
 * @returns {object} every figure the summary shows, with the parts that make it up, so a
 *   reader can add the column and get the total.
 */
function project(input = {}) {
  const assumptions = normaliseAssumptions(input);

  const unbillable = nonBillableDays(assumptions);
  // Never negative: someone can claim 300 days of holiday, and the answer to that is
  // "zero billable days", not a negative revenue.
  const billableDays = Math.max(0, assumptions.workingDays - unbillable);

  const revenue = round(billableDays * assumptions.dayRate);
  const costs = annualCosts(assumptions);
  const netBeforeTax = revenue - costs;

  return {
    assumptions,
    days: {
      working: assumptions.workingDays,
      nonBillable: unbillable,
      billable: billableDays,
      // The share of the year actually invoiced. Derived and shown because it is the
      // number people think they already know.
      utilisationPercent: assumptions.workingDays
        ? Math.round((billableDays / assumptions.workingDays) * 100)
        : 0,
      breakdown: DAY_CATEGORIES.map(({ key, label }) => ({ key, label, days: assumptions[key] || 0 }))
    },
    money: {
      revenue,
      costs,
      netBeforeTax,
      costBreakdown: COST_CATEGORIES.map(({ key, label }) => ({ key, label, amount: assumptions[key] || 0 })),
      /*
       * The figure the whole calculator exists for: what one invoiced day is worth once
       * the unbillable days and the running costs are spread back across it. This is the
       * number to compare against a salary, and it is always well below the headline rate.
       */
      effectiveDayRate: billableDays ? round(netBeforeTax / billableDays) : 0,
      // Same idea against the calendar rather than against invoices.
      effectiveMonthly: round(netBeforeTax / 12)
    }
  };
}

/**
 * The inverse: what day rate does a target net require?
 *
 * Exactly inverts `project` under the same assumptions — `rateForTarget(project(r).money
 * .netBeforeTax)` returns `r` — which is what makes the two directions of the calculator
 * agree instead of being two formulas that drift.
 *
 * Rounds UP. A rate that lands a euro short of the target every year is the wrong way to
 * be precise.
 */
function rateForTarget(targetNet, input = {}) {
  const assumptions = normaliseAssumptions(input);
  const billableDays = Math.max(0, assumptions.workingDays - nonBillableDays(assumptions));
  if (!billableDays) return null;

  const required = (Number(targetNet) || 0) + annualCosts(assumptions);
  return Math.max(0, Math.ceil(required / billableDays));
}

/**
 * Compare against a market figure from the rate index.
 *
 * Takes the index's own answer rather than looking it up, so the privacy floor is applied
 * exactly once, in `utils/rateAggregation.js`, and this stays pure. A null market figure
 * is a suppressed bucket and must be shown as "not enough data", never as zero.
 */
function positionAgainstMarket(dayRate, marketMedian) {
  const rate = Number(dayRate);
  const median = Number(marketMedian);
  if (!Number.isFinite(rate) || !Number.isFinite(median) || median <= 0) return null;

  const differencePercent = Math.round(((rate - median) / median) * 100);
  return {
    median: round(median),
    differencePercent,
    // Deliberately coarse. The index is a sample of a few dozen people; implying that
    // being 7% above the median is meaningfully different from 3% would be false precision.
    band: differencePercent <= -15 ? 'below' : differencePercent >= 15 ? 'above' : 'around'
  };
}

/**
 * Re-check the arithmetic, in the same spirit as `reconciliationProblems` in the
 * estimator: a projection whose parts do not add up can only mean a bug here, and it is
 * cheaper to find it than to have someone plan a year around it.
 *
 * @returns {string[]} empty when the projection is sound.
 */
function reconciliationProblems(projection) {
  const problems = [];
  if (!projection || !projection.days || !projection.money) return ['projection is not shaped like one'];

  const { days, money, assumptions } = projection;

  const breakdownTotal = days.breakdown.reduce((total, row) => total + row.days, 0);
  if (breakdownTotal !== days.nonBillable) {
    problems.push(`non-billable days (${days.nonBillable}) do not equal the sum of their categories (${breakdownTotal})`);
  }
  if (days.billable + days.nonBillable !== days.working && days.billable !== 0) {
    problems.push(`billable + non-billable (${days.billable + days.nonBillable}) does not equal the working year (${days.working})`);
  }

  const costTotal = money.costBreakdown.reduce((total, row) => total + row.amount, 0);
  if (costTotal !== money.costs) {
    problems.push(`costs (${money.costs}) do not equal the sum of their categories (${costTotal})`);
  }
  if (money.revenue !== round(days.billable * assumptions.dayRate)) {
    problems.push('revenue is not billable days times the day rate');
  }
  if (money.netBeforeTax !== money.revenue - money.costs) {
    problems.push('net is not revenue minus costs');
  }

  return problems;
}

module.exports = {
  WORKING_DAYS_PER_YEAR,
  DAY_CATEGORIES,
  COST_CATEGORIES,
  LIMITS,
  normaliseAssumptions,
  project,
  rateForTarget,
  positionAgainstMarket,
  reconciliationProblems
};
