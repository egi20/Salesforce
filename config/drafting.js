'use strict';

/**
 * AI drafting for the narrative sections of a scope estimate.
 *
 * This is the highest-risk feature in the application, and the constraints below are what
 * make it defensible rather than reckless. A quote is a statement made to a client on a
 * date; `utils/sowEstimation.js` exists to make its parts reconcile exactly. Putting
 * generated prose next to those figures can only ADD risk, so every choice here is about
 * bounding it:
 *
 *  1. **The model never sees a blank page and never produces a figure.** It is given the
 *     computed estimate as facts and told to write numbers as words. Every draft is then
 *     checked by `utils/draftVerification.js`, which refuses any numeral the estimate does
 *     not contain. That check is not advisory — a failing draft is never stored or shown.
 *  2. **A draft is a draft.** It goes into its own table, not into `quote.estimate`, and
 *     it reaches a document only after the author has read it and accepted it. The author
 *     can edit it freely; what they accept is what appears.
 *  3. **It drafts the sections that are prose anyway** — the summary, the approach
 *     narrative, project assumptions and risks. It never writes scope, effort, rates,
 *     timeline or price. Those come from the engine and stay there.
 */

const { GLOBAL_MONTHLY_BUDGET_USD } = require('./assistant');

/**
 * Claude Opus 5.
 *
 * The assistant runs on Haiku because it answers "where is the rate index". This writes
 * paragraphs a consultant puts in front of a client under their own name, which is the one
 * place in this application where the quality difference is worth paying for. It is also
 * bounded: a handful of drafts per quote, not one per page view.
 */
const MODEL = process.env.DRAFTING_MODEL || 'claude-opus-5';

/**
 * Deliberately low. Each section is a few paragraphs — the verifier rejects anything over
 * 400 words anyway — so a large ceiling would only pay for a runaway.
 */
const MAX_OUTPUT_TOKENS = 4000;

/** Published list price per MILLION tokens, USD. Here to be CHECKED against an invoice. */
const PRICE_PER_MTOK_INPUT = Number(process.env.DRAFTING_PRICE_INPUT_USD || 5);
const PRICE_PER_MTOK_OUTPUT = Number(process.env.DRAFTING_PRICE_OUTPUT_USD || 25);

/**
 * How many times one quote may be drafted.
 *
 * Regenerating is the natural response to a draft you do not like, and at Opus prices an
 * unbounded "try again" button on a page is a bill. Ten is enough to iterate and small
 * enough to notice.
 */
const MAX_DRAFTS_PER_QUOTE = 10;

/**
 * The sections, and the boundary each one must not cross.
 *
 * `writes` is what goes in the prompt; `neverWrites` is in the prompt too, because telling
 * a model what is out of bounds works better than hoping the instruction to stay in bounds
 * covers it — and it documents the boundary for whoever reads this next.
 */
const SECTIONS = Object.freeze({
  executive_summary: {
    key: 'executive_summary',
    label: 'Executive summary',
    heading: 'Executive summary',
    minWords: 60,
    maxWords: 250,
    writes: 'what this programme is for, in the client\'s own business terms, and what they will be able to do at the end of it',
    neverWrites: 'any figure, any date, any commitment about price or duration'
  },
  approach: {
    key: 'approach',
    label: 'Delivery approach',
    heading: 'How we will run it',
    minWords: 80,
    maxWords: 400,
    writes: 'how the phases fit together, what happens in each, and what the client is expected to do alongside them',
    neverWrites: 'effort in days, cost, team size, or any date — the phase table already states those'
  },
  assumptions: {
    key: 'assumptions',
    label: 'Project assumptions',
    heading: 'Assumptions specific to this engagement',
    minWords: 40,
    maxWords: 300,
    writes: 'the assumptions that follow from THIS scope — data quality, access, availability of the client\'s people, existing integrations',
    neverWrites: 'the standard assumptions already printed in the document, and anything that reads as a contractual term'
  },
  risks: {
    key: 'risks',
    label: 'Risks',
    heading: 'What could move this estimate',
    minWords: 40,
    maxWords: 300,
    writes: 'what would most plausibly make this take longer or cost more, and what would reduce each one',
    neverWrites: 'a probability, a contingency percentage, or a revised figure of any kind'
  }
});

const SECTION_KEYS = Object.freeze(Object.keys(SECTIONS));

function isSection(key) {
  return Object.prototype.hasOwnProperty.call(SECTIONS, key);
}

function costUsd(inputTokens, outputTokens) {
  const input = (Number(inputTokens) || 0) / 1e6;
  const output = (Number(outputTokens) || 0) / 1e6;
  return input * PRICE_PER_MTOK_INPUT + output * PRICE_PER_MTOK_OUTPUT;
}

/**
 * Boot assertion. The one that matters is the last: a section with no stated boundary is a
 * section whose prompt does not say what it must not write.
 */
function assertDraftingIntegrity() {
  if (!MODEL) throw new Error('Drafting: no model configured');
  if (MAX_OUTPUT_TOKENS <= 0) throw new Error('Drafting: MAX_OUTPUT_TOKENS must be positive');
  for (const value of [PRICE_PER_MTOK_INPUT, PRICE_PER_MTOK_OUTPUT]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Drafting: prices must be non-negative numbers');
  }
  if (!Number.isInteger(MAX_DRAFTS_PER_QUOTE) || MAX_DRAFTS_PER_QUOTE <= 0) {
    throw new Error('Drafting: MAX_DRAFTS_PER_QUOTE must be a positive integer');
  }
  for (const [key, section] of Object.entries(SECTIONS)) {
    if (section.key !== key) throw new Error(`Drafting: section "${key}" disagrees with its own key`);
    if (!section.writes || !section.neverWrites) {
      throw new Error(`Drafting: section "${key}" does not state what it must not write`);
    }
    if (section.minWords >= section.maxWords) {
      throw new Error(`Drafting: section "${key}" has an impossible length range`);
    }
  }
  return true;
}

module.exports = {
  MODEL,
  MAX_OUTPUT_TOKENS,
  PRICE_PER_MTOK_INPUT,
  PRICE_PER_MTOK_OUTPUT,
  MAX_DRAFTS_PER_QUOTE,
  SECTIONS,
  SECTION_KEYS,
  // Drafting shares the assistant's month-to-date budget rather than having its own: one
  // cap on one ledger is a number somebody can actually reconcile with an invoice.
  GLOBAL_MONTHLY_BUDGET_USD,
  isSection,
  costUsd,
  assertDraftingIntegrity
};
