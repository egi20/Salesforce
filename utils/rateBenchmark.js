'use strict';

const { baseDayRate, isValidRole } = require('../config/roleTaxonomy');
const model = require('../config/rateModel');
const { project } = require('./contractorEconomics');

/**
 * "Benchmark my rate" — the editorial model, applied. Pure: no database, no clock.
 *
 * recommended = base(role) × experience × region × (1 + Σ adjustments), to the nearest €5;
 * min and max sit SPREAD_BPS either side. Every step is returned so the page can show the
 * working, and `benchmarkProblems` re-checks it the way `reconciliationProblems` re-checks an
 * estimate — the arithmetic shown must be the arithmetic done.
 *
 * Monthly, annual and the equivalent salary are NOT `rate × 20` and `rate × 220`. They come
 * from `utils/contractorEconomics.project`, the contract rate calculator's own engine, with
 * its named non-billable days (holiday, illness, bench, admin, training) and running costs,
 * so the two pages cannot disagree about what a day rate is worth over a year.
 */

const own = (map, key) => (typeof key === 'string' && map.has(key) ? map.get(key) : null);

function roundTo(value, step = model.ROUND_TO) {
  return Math.round(value / step) * step;
}

function count(value, { max }) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

/**
 * Read the form. Anything unknown falls back to the neutral option rather than erroring:
 * this is a calculator somebody is playing with. A missing or unknown ROLE returns null —
 * there is no "average role" to benchmark.
 */
function inputsFrom(query = {}) {
  if (!isValidRole(query.b_role)) return null;
  return {
    role: query.b_role,
    experience: own(model.EXPERIENCE_BY_VALUE, query.b_exp) ? query.b_exp : 'senior',
    region: own(model.REGIONS_BY_VALUE, query.b_region) ? query.b_region : 'western-europe',
    certifications: count(query.b_certs, model.CERTIFICATIONS),
    skills: count(query.b_skills, model.SKILLS),
    arrangement: own(model.ARRANGEMENTS_BY_VALUE, query.b_mode) ? query.b_mode : 'remote',
    industry: own(model.INDUSTRIES_BY_VALUE, query.b_industry) ? query.b_industry : 'general',
    contractType: own(model.CONTRACT_TYPES_BY_VALUE, query.b_contract) ? query.b_contract : 'time-materials'
  };
}

function benchmark(inputs) {
  if (!inputs) return null;
  const base = baseDayRate(inputs.role);
  const experience = model.EXPERIENCE_BY_VALUE.get(inputs.experience);
  const region = model.REGIONS_BY_VALUE.get(inputs.region);
  const arrangement = model.ARRANGEMENTS_BY_VALUE.get(inputs.arrangement);
  const industry = model.INDUSTRIES_BY_VALUE.get(inputs.industry);
  const contract = model.CONTRACT_TYPES_BY_VALUE.get(inputs.contractType);

  const adjustments = [
    { label: `${inputs.certifications} certification${inputs.certifications === 1 ? '' : 's'}`, bps: inputs.certifications * model.CERTIFICATIONS.bpsEach },
    { label: `${inputs.skills} additional skill${inputs.skills === 1 ? '' : 's'}`, bps: inputs.skills * model.SKILLS.bpsEach },
    { label: arrangement.label, bps: arrangement.bps },
    { label: industry.label, bps: industry.bps },
    { label: contract.label, bps: contract.bps }
  ];
  const adjustmentBps = adjustments.reduce((sum, a) => sum + a.bps, 0);

  const beforeAdjustments = base * experience.multiplier * region.multiplier;
  const recommended = roundTo(beforeAdjustments * (1 + adjustmentBps / 10000));
  const min = roundTo(recommended * (1 - model.SPREAD_BPS / 10000));
  const max = roundTo(recommended * (1 + model.SPREAD_BPS / 10000));

  // The year, from the rate calculator's engine with its default assumptions.
  const year = project({ dayRate: recommended });

  return {
    inputs,
    steps: {
      base,
      experience: { label: experience.label, multiplier: experience.multiplier },
      region: { label: region.label, multiplier: region.multiplier },
      beforeAdjustments: Math.round(beforeAdjustments),
      adjustments,
      adjustmentBps
    },
    min,
    recommended,
    max,
    year: {
      billableDays: year.days.billable,
      nonBillableDays: year.days.nonBillable,
      annual: year.money.revenue,
      monthly: Math.round(year.money.revenue / 12),
      costs: year.money.costs,
      // What an employer's gross salary would have to be to match the same money before
      // tax: revenue less the running costs a contractor pays and an employee does not.
      equivalentSalary: year.money.netBeforeTax
    }
  };
}

/** Confidence from how many PEOPLE stand behind the community bucket compared against. */
function confidenceFor(contributors) {
  const n = Number(contributors) || 0;
  return model.CONFIDENCE.find((c) => n >= c.minContributors).level;
}

/**
 * Where the recommendation sits against the community's P25–P75, as percentages along a bar
 * spanning a little either side of both. Null when the bucket is below the floor — the page
 * then says "Not enough community data" rather than drawing a bar against nothing.
 */
function positionBar(recommended, market) {
  if (!market || market.suppressed || market.median == null) return null;
  const lo = Math.min(market.p25, recommended) * 0.85;
  const hi = Math.max(market.p75, recommended) * 1.15;
  const at = (v) => Math.round(((v - lo) / (hi - lo)) * 1000) / 10;
  return { p25: at(market.p25), median: at(market.median), p75: at(market.p75), you: at(recommended), market };
}

/** Re-checks the working shown against the figure shown. */
function benchmarkProblems(b) {
  if (!b) return [];
  const problems = [];
  if (!(b.min <= b.recommended && b.recommended <= b.max)) problems.push('min/recommended/max out of order');
  for (const v of [b.min, b.recommended, b.max]) if (v % model.ROUND_TO !== 0) problems.push(`${v} is not rounded to €${model.ROUND_TO}`);
  const sum = b.steps.adjustments.reduce((s, a) => s + a.bps, 0);
  if (sum !== b.steps.adjustmentBps) problems.push('adjustments do not sum to their total');
  const expected = roundTo(b.steps.base * b.steps.experience.multiplier * b.steps.region.multiplier * (1 + sum / 10000));
  if (expected !== b.recommended) problems.push('recommended does not follow from its steps');
  return problems;
}

module.exports = { inputsFrom, benchmark, confidenceFor, positionBar, benchmarkProblems, roundTo };
