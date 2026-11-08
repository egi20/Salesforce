'use strict';

const { BASE_DAY_RATES, SENIORITY_LEVELS } = require('./roleTaxonomy');
const { EU_COUNTRY_CODES } = require('./regions');

/**
 * The EDITORIAL rate model behind "Benchmark my rate" on /rates.
 *
 * Every number here is Salesforce Hub's own published judgement, under version control,
 * shown line by line in the page's Methodology section — and NEVER blended into the
 * community figures beside it. The two answer different questions: this one is "what
 * should somebody like me charge, by our reckoning", the community index is "what do people
 * who told us actually charge". Mixing them would make the index unfalsifiable, so the page
 * labels each and the code keeps them in separate modules.
 *
 * Nothing here is copied from the Dynamics Hub calculator: its baselines are Dynamics 365
 * roles, and its adjustments were tuned for that market. These are ours, for Salesforce
 * work, and change by a reviewed commit like any other catalogue value.
 *
 * Adjustments are in BASIS POINTS of the recommended rate (300 = +3%), so the explanation
 * on the page and the arithmetic are the same integers.
 */

/**
 * Experience brackets ARE the seniority bands: "Junior (0-2 yrs)" already states its years,
 * and a second set of brackets with different edges would put the benchmark and the
 * directory at odds about who is senior. Multipliers come from the same place.
 */
const EXPERIENCE = Object.freeze(
  SENIORITY_LEVELS.map((s) => ({
    value: s.value,
    label: s.maxYears === Infinity ? `${s.minYears}+ years` : `${s.minYears}–${s.maxYears} years`,
    multiplier: s.multiplier
  }))
);

/**
 * Where the work is billed from. Multipliers are relative to Western Europe, which is
 * what BASE_DAY_RATES are written against. `countries` decides the "By region" tab of the
 * community index; a country in no region is shown under "Other".
 */
const REGIONS = Object.freeze([
  {
    value: 'western-europe',
    label: 'Western Europe',
    multiplier: 1.0,
    countries: ['AT', 'BE', 'FR', 'DE', 'LU', 'NL', 'CH', 'IE', 'IT', 'ES', 'PT', 'GR', 'CY', 'MT', 'MC', 'LI', 'AD', 'SM']
  },
  { value: 'northern-europe', label: 'Northern Europe', multiplier: 1.05, countries: ['DK', 'FI', 'IS', 'NO', 'SE'] },
  { value: 'uk', label: 'United Kingdom', multiplier: 1.05, countries: ['GB'] },
  { value: 'us', label: 'United States', multiplier: 1.2, countries: ['US'] },
  {
    value: 'eastern-europe',
    label: 'Eastern Europe',
    multiplier: 0.6,
    countries: ['PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'HR', 'SI', 'EE', 'LV', 'LT', 'RS', 'BA', 'ME', 'MK', 'AL', 'XK', 'MD', 'UA']
  },
  { value: 'india', label: 'India', multiplier: 0.3, countries: ['IN'] },
  { value: 'australia', label: 'Australia', multiplier: 1.0, countries: ['AU'] }
]);

/** Each certification and each additional skill adds a little, up to a cap. */
const CERTIFICATIONS = Object.freeze({ bpsEach: 150, max: 6 });
const SKILLS = Object.freeze({ bpsEach: 100, max: 5 });

const ARRANGEMENTS = Object.freeze([
  { value: 'remote', label: 'Remote', bps: 0 },
  { value: 'hybrid', label: 'Hybrid', bps: 300 },
  { value: 'onsite', label: 'On-site', bps: 600 }
]);

const INDUSTRIES = Object.freeze([
  { value: 'general', label: 'General / cross-industry', bps: 0 },
  { value: 'financial-services', label: 'Financial services', bps: 1000 },
  { value: 'life-sciences', label: 'Life sciences & healthcare', bps: 700 },
  { value: 'energy', label: 'Energy & utilities', bps: 500 },
  { value: 'manufacturing', label: 'Manufacturing & automotive', bps: 200 },
  { value: 'retail', label: 'Retail & consumer goods', bps: 0 },
  { value: 'nonprofit', label: 'Nonprofit & education', bps: -800 },
  { value: 'public-sector', label: 'Public sector', bps: -500 }
]);

const CONTRACT_TYPES = Object.freeze([
  { value: 'time-materials', label: 'Time & materials', bps: 0 },
  { value: 'fixed-price', label: 'Fixed-price project', bps: 800 },
  { value: 'staff-augmentation', label: 'Staff augmentation (via agency)', bps: -400 },
  { value: 'retainer', label: 'Monthly retainer', bps: -600 }
]);

/** Min and max sit this far either side of the recommendation. */
const SPREAD_BPS = 1500;

/** Rates are quoted to the nearest €5: precision beyond that is a claim the model cannot make. */
const ROUND_TO = 5;

/**
 * How much community data stands behind the comparison, by contributors in the bucket.
 * Below the privacy floor nothing is published, which is "Low" by definition.
 */
const CONFIDENCE = Object.freeze([
  { level: 'High', minContributors: 10 },
  { level: 'Medium', minContributors: 3 },
  { level: 'Low', minContributors: 0 }
]);

function byValue(list) {
  return new Map(list.map((item) => [item.value, item]));
}

/** Asserted at boot: a model with a hole in it answers with a silent default. */
function rateModelProblems() {
  const problems = [];
  if (!Object.keys(BASE_DAY_RATES).length) problems.push('no base day rates');
  const seen = new Set();
  for (const r of REGIONS) {
    if (!(r.multiplier > 0)) problems.push(`region ${r.value} needs a positive multiplier`);
    for (const c of r.countries) {
      if (!/^[A-Z]{2}$/.test(c)) problems.push(`region ${r.value} has a bad country code ${c}`);
      if (seen.has(c)) problems.push(`country ${c} is in two regions`);
      seen.add(c);
    }
  }
  for (const code of EU_COUNTRY_CODES) {
    if (!seen.has(code)) problems.push(`EU country ${code} is in no region`);
  }
  for (const [name, list] of [['arrangement', ARRANGEMENTS], ['industry', INDUSTRIES], ['contract type', CONTRACT_TYPES]]) {
    if (!list.some((i) => i.bps === 0)) problems.push(`${name} needs a neutral (0) option`);
    for (const i of list) if (!Number.isInteger(i.bps)) problems.push(`${name} ${i.value} bps must be an integer`);
  }
  if (!(SPREAD_BPS > 0 && SPREAD_BPS < 10000)) problems.push('spread must be between 0 and 100%');
  return problems;
}

function assertRateModel() {
  const problems = rateModelProblems();
  if (problems.length) throw new Error(`config/rateModel.js: ${problems.join('; ')}`);
  return true;
}

module.exports = {
  EXPERIENCE,
  REGIONS,
  CERTIFICATIONS,
  SKILLS,
  ARRANGEMENTS,
  INDUSTRIES,
  CONTRACT_TYPES,
  SPREAD_BPS,
  ROUND_TO,
  CONFIDENCE,
  EXPERIENCE_BY_VALUE: byValue(EXPERIENCE),
  REGIONS_BY_VALUE: byValue(REGIONS),
  ARRANGEMENTS_BY_VALUE: byValue(ARRANGEMENTS),
  INDUSTRIES_BY_VALUE: byValue(INDUSTRIES),
  CONTRACT_TYPES_BY_VALUE: byValue(CONTRACT_TYPES),
  rateModelProblems,
  assertRateModel
};
