'use strict';

/**
 * Checking a generated narrative before anyone sees it.
 *
 * This module exists because of what the drafting feature writes INTO: a quote is a
 * statement made to a client on a date, and `utils/sowEstimation.js` goes to some length
 * to make sure its parts reconcile. A paragraph that says "roughly 40 days of build" next
 * to a table saying 23 undoes all of it, and the client is the one who finds the
 * discrepancy.
 *
 * THE RULE: **the narrative may not contain a numeral that the estimate does not
 * contain.** Not "should not" — the check runs on every draft and a draft that fails it is
 * never stored or shown. It is the prose equivalent of `assertDocumentOpens`: a machine
 * check on the way out, because the alternative is a human noticing.
 *
 * The model is told to write numbers as words ("three phases") and to quote figures only
 * by reading them off the estimate. Anything else is a hallucinated commercial term.
 *
 * Pure — no database, no API — so the rule can be argued with in a test.
 */

/** Words that commit the author to something a generated paragraph has no business promising. */
const FORBIDDEN_TERMS = [
  'guarantee',
  'guaranteed',
  'warrant',
  'warranty',
  'warranties',
  'indemnif', // indemnify, indemnity, indemnification
  'penalty',
  'penalties',
  'fixed price',
  'fixed-price'
];

/** Text the model left behind when it did not know something. */
const PLACEHOLDER_PATTERNS = [
  /\[[^\]]*\]/, // [insert client name]
  /\{\{/, // {{ template }}
  /\bTBD\b/i,
  /\bTBC\b/i,
  /\bXXX+\b/i,
  /\bTODO\b/i,
  /\bLorem ipsum\b/i,
  /<insert/i
];

/**
 * Every numeral in a piece of text, normalised.
 *
 * Thousands separators are stripped so "63,800" and "63800" are the same figure, and a
 * trailing ".00" is dropped so "1,100.00" matches a rate of 1100. Ordinal and possessive
 * suffixes are left alone — they attach to a numeral that is still checked.
 */
function numbersIn(text) {
  const found = [];
  const matches = String(text || '').match(/\d[\d,. ]*\d|\d/g) || [];

  for (const raw of matches) {
    // A run like "2, 3" is two figures, not one; split on anything that is not a digit,
    // a decimal point or a thousands separator directly between digits.
    const cleaned = raw.replace(/[,\s](?=\d{3}\b)/g, '');
    for (const part of cleaned.split(/[^\d.]+/)) {
      if (!part) continue;
      const value = Number(part.replace(/\.$/, ''));
      if (Number.isFinite(value)) found.push(value);
    }
  }

  return found;
}

/**
 * Every figure the estimate actually contains.
 *
 * Built from the stored breakdown rather than recomputed, for the same reason the document
 * generators render rather than recompute: a permitted set derived a second way would
 * eventually permit a number the quote does not contain.
 */
function permittedNumbers(estimate) {
  const allowed = new Set();
  const add = (value) => {
    const n = Number(value);
    if (Number.isFinite(n)) allowed.add(n);
  };

  if (!estimate || typeof estimate !== 'object') return allowed;

  for (const key of [
    'totalManDays',
    'baseEffort',
    'contingencyDays',
    'contingencyPercentage',
    'implementationBudget',
    'supportBudget',
    'totalBudget',
    'averageDailyRate',
    'projectDurationWeeks',
    'projectDurationMonths'
  ]) {
    add(estimate[key]);
  }

  for (const phase of estimate.phaseBreakdown || []) {
    add(phase.days);
    add(phase.percentage);
  }
  for (const resource of estimate.resourceAllocation || []) {
    add(resource.days);
    add(resource.percentage);
    add(resource.dailyRate);
    add(resource.totalCost);
  }
  for (const entry of estimate.timeline || []) {
    add(entry.startWeek);
    add(entry.endWeek);
    add(entry.durationWeeks);
    add(entry.days);
  }
  for (const group of [estimate.familyBreakdown, estimate.moduleBreakdown, estimate.isvBreakdown]) {
    for (const row of group || []) {
      add(row.days);
      add(row.percentage);
      add(row.cost);
    }
  }

  const multipliers = estimate.multipliers || {};
  for (const multiplier of Object.values(multipliers)) {
    if (!multiplier || typeof multiplier !== 'object') continue;
    add(multiplier.value);
    add(multiplier.count);
    add(multiplier.daysEach);
  }

  return allowed;
}

/**
 * @param {string} [context] text the model was GIVEN. Numerals in it are permitted too.
 *
 * That second set is not a loophole, it is a correction the verifier itself exposed:
 * legitimate names carry digits — "B2B Commerce", "Five9", "Bulk API 2.0" — and a
 * narrative that names a product in scope was flagged for inventing the figure 2. The
 * model may repeat a numeral it was handed; it cannot repeat a day count or a cost,
 * because `factsFor()` deliberately never gives it one.
 *
 * @returns {number[]} every figure in the draft that neither source contains.
 */
function unsupportedNumbers(text, estimate, context = '') {
  const allowed = permittedNumbers(estimate);
  for (const value of numbersIn(context)) allowed.add(value);

  const seen = new Set();
  const unsupported = [];

  for (const value of numbersIn(text)) {
    if (allowed.has(value) || seen.has(value)) continue;
    seen.add(value);
    unsupported.push(value);
  }

  return unsupported;
}

/**
 * Everything wrong with one drafted section.
 *
 * Returns reasons rather than throwing, because the caller shows them to the author: a
 * draft that failed is worth explaining, and "the model invented a figure" is exactly the
 * thing somebody should see happen rather than have quietly retried away.
 *
 * @returns {string[]} empty when the draft is safe to show.
 */
function problemsWith(text, estimate, { minWords = 30, maxWords = 400, context = '' } = {}) {
  const problems = [];
  const body = String(text || '').trim();

  if (!body) return ['the draft is empty'];

  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < minWords) problems.push(`too short to be useful (${words} words)`);
  if (words > maxWords) problems.push(`too long for this section (${words} words)`);

  const unsupported = unsupportedNumbers(body, estimate, context);
  if (unsupported.length) {
    // The headline failure. A figure that is not in the estimate is a commercial term
    // nobody agreed to, sitting in a document a client is quoted from.
    problems.push(`contains figures the estimate does not: ${unsupported.join(', ')}`);
  }

  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(body)) {
      problems.push('contains placeholder text the model did not fill in');
      break;
    }
  }

  const lower = body.toLowerCase();
  const promised = FORBIDDEN_TERMS.filter((term) => lower.includes(term));
  if (promised.length) {
    problems.push(`makes a commitment this document cannot make: ${promised.join(', ')}`);
  }

  return problems;
}

module.exports = {
  FORBIDDEN_TERMS,
  numbersIn,
  permittedNumbers,
  unsupportedNumbers,
  problemsWith
};
