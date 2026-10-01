'use strict';

/**
 * How an engagement is shaped, and where the work happens.
 *
 * These two lists lived as bare slug arrays inside `routes/jobs.js`, which is why every
 * card in the site printed "onsite" and "permanent" in lower case: a route file has no
 * labels, so a view had nothing to render but the value. A catalogue belongs in `config/`
 * beside the roles and the clouds, with its label next to its slug.
 *
 * `rateUnit` is the load-bearing part. One pair of rate columns serves both shapes, so the
 * SAME number means a day rate on a contract and an annual salary on a permanent role. The
 * unit is a property of the engagement, not something a view decides with an inline
 * ternary — which is how a seeded day rate came to be published as "468 EUR/yr".
 */
const ENGAGEMENT_TYPES = [
  { value: 'contract', label: 'Contract', rateUnit: '/day', rateNoun: 'Day rate', hasDuration: true },
  { value: 'permanent', label: 'Permanent', rateUnit: '/yr', rateNoun: 'Annual salary', hasDuration: false }
];

const WORK_MODES = [
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'onsite', label: 'On site' }
];

const ENGAGEMENT_SLUGS = ENGAGEMENT_TYPES.map((e) => e.value);
const WORK_MODE_SLUGS = WORK_MODES.map((w) => w.value);

const ENGAGEMENTS_BY_SLUG = new Map(ENGAGEMENT_TYPES.map((e) => [e.value, e]));
const WORK_MODES_BY_SLUG = new Map(WORK_MODES.map((w) => [w.value, w]));

function engagementLabel(slug) {
  const e = ENGAGEMENTS_BY_SLUG.get(slug);
  return e ? e.label : slug || '';
}

function workModeLabel(slug) {
  const w = WORK_MODES_BY_SLUG.get(slug);
  return w ? w.label : slug || '';
}

/**
 * The suffix a figure carries for this engagement — "/day" or "/yr".
 *
 * An unrecognised engagement returns an EMPTY string rather than a guess. A number with no
 * unit is ambiguous; a number with the wrong unit is a lie, and this one is about money.
 */
function rateUnit(slug) {
  const e = ENGAGEMENTS_BY_SLUG.get(slug);
  return e ? e.rateUnit : '';
}

/** What the rate field is called on a form, so the author knows which number to type. */
function rateNoun(slug) {
  const e = ENGAGEMENTS_BY_SLUG.get(slug);
  return e ? e.rateNoun : 'Rate';
}

/**
 * Whether a duration in months means anything for this engagement.
 *
 * It does not for a permanent role, and a row carrying both said "permanent" and "3 months"
 * on the same card. The write path clears it rather than leaving a contradiction in the
 * table for every reader to interpret.
 */
function hasDuration(slug) {
  const e = ENGAGEMENTS_BY_SLUG.get(slug);
  return e ? e.hasDuration : false;
}

module.exports = {
  ENGAGEMENT_TYPES,
  WORK_MODES,
  ENGAGEMENT_SLUGS,
  WORK_MODE_SLUGS,
  engagementLabel,
  workModeLabel,
  rateUnit,
  rateNoun,
  hasDuration
};
