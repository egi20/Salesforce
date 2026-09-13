'use strict';

/**
 * The tax advisory enquiry: what it collects, and — more importantly — what it does not.
 *
 * THE REFUSAL THAT DEFINES THIS FEATURE. The reference implementation ships a tax
 * calculator. `POST /tax-optimization/calculate` takes the gross and net a visitor types,
 * applies `newNet = gross - (gross * percentRate / 100 + fixedFee)` with `percentRate`
 * defaulting to 5, and returns `monthlySavings`, `annualSavings` and `percentIncrease`.
 * That arithmetic asserts that after restructuring, somebody's ENTIRE burden becomes five
 * per cent of gross — no jurisdiction, no entity type, no VAT position, no social
 * security floor, no accountant's fee. Worse, `percentRate` is an admin-editable setting,
 * so the "saving" a visitor is shown is a marketing dial with a number on it.
 *
 * None of that is ported. `utils/contractorEconomics.js` already states the rule and a
 * test enforces it: this codebase does not compute tax. Moving the same arithmetic into a
 * different file would move the refusal one directory to the left, so a test asserts this
 * module exposes nothing rate-, saving- or tax-shaped either.
 *
 * What IS real here is the introduction: a consultant wants to talk to somebody who knows
 * their jurisdiction. So this is an ENQUIRY, not a calculation, and every field below
 * earns its place by being needed to route that enquiry to the right person.
 *
 * WHAT THE REFERENCE COLLECTS, AND WHY IT IS NOT HERE. Its form takes forty fields from
 * an anonymous visitor with no rate limit and no consent record: current employer,
 * contract end date, notice period, gross and net monthly pay, current tax rate, whether
 * they hold a VAT number, desired and current day rate. That is a complete financial and
 * employment profile, handed over before anyone has agreed to anything, stored
 * indefinitely in a marketplace's database. It also stores `estimated_monthly_savings`
 * POSTED BACK FROM THE BROWSER, so the figure on the record is whatever the client sent.
 *
 * A first conversation needs six things. Everything else is asked by the specialist, in
 * that conversation, under their own engagement terms — which is also the only place a
 * professional duty of confidentiality actually attaches. It does not attach here.
 */

/**
 * What somebody can usefully be introduced about. A topic is routing information, not a
 * diagnosis: it decides who reads the enquiry, nothing else.
 */
const TOPICS = Object.freeze([
  { value: 'structure', label: 'How I should be set up (employed, freelance, company)' },
  { value: 'cross_border', label: 'Working for clients in another country' },
  { value: 'relocation', label: 'Moving country, or already moved' },
  { value: 'first_contract', label: 'Going contracting for the first time' },
  { value: 'other', label: 'Something else' }
]);

/**
 * How somebody works TODAY. Coarse on purpose: it is the one fact that decides whether
 * the service can help at all, and a finer answer belongs in the conversation.
 */
const ARRANGEMENTS = Object.freeze([
  { value: 'employed', label: 'Employed by one company' },
  { value: 'freelance', label: 'Freelancing as an individual' },
  { value: 'own_company', label: 'Through my own company' },
  { value: 'umbrella', label: 'Through an umbrella or agency payroll' },
  { value: 'other', label: 'Something else' }
]);

/**
 * The enquiry's declared state machine, the same shape as `models/Application.js`.
 *
 * An undeclared transition is refused rather than written, so the queue cannot reach a
 * state the admin screen has no rendering for. `closed` is terminal: an enquiry that was
 * handled and then comes back is a NEW enquiry, because the unique key below only ever
 * reserves one OPEN enquiry per address.
 *
 * The reference's enum has six states plus `assigned_to`, `priority` and `internal_notes`
 * — a CRM grown inside four route handlers. This has four, and `introduced` is the one
 * that matters, because it is the moment the Hub's involvement ends.
 */
const TRANSITIONS = Object.freeze({
  new: ['contacted', 'closed'],
  contacted: ['introduced', 'closed'],
  introduced: ['closed'],
  closed: []
});

const STATUSES = Object.freeze(Object.keys(TRANSITIONS));

/** Statuses that hold the one-open-enquiry-per-address reservation. */
const OPEN_STATUSES = Object.freeze(STATUSES.filter((s) => s !== 'closed'));

/**
 * Field bounds. Server-side validation is authoritative; the `maxlength` attributes in
 * the form are a convenience that a crafted POST does not have to respect.
 */
const LIMITS = Object.freeze({
  name: 120,
  email: 190,
  phone: 40,
  // Deliberately longer than the two characters a country code is. It bounds the input
  // before a pattern is run against it; the pattern is what decides validity. A bound of
  // exactly 2 would TRUNCATE `ALB` into the valid-looking `AL`, and `AUT` into Australia.
  country: 16,
  question: 2000,
  questionMin: 20
});

/**
 * How long an enquiry is kept.
 *
 * Declared here rather than left implicit because this is personal data collected for one
 * named purpose. Once the introduction is made or the enquiry is closed, the Hub has no
 * reason to hold it — the specialist has their own record, under their own terms.
 * `TaxEnquiry.purgeExpired()` deletes past this, and the admin screen shows the count due
 * so that "we keep it for 180 days" is a fact somebody can check rather than a sentence
 * in a policy.
 */
const RETENTION_DAYS = 180;

/**
 * What the page promises, in one place, so the marketing copy and the code cannot drift.
 * These strings are rendered escaped and are deliberately narrow: the Hub introduces, it
 * does not advise, and it publishes no figure.
 */
const PROMISE = Object.freeze({
  does: [
    'Passes what you write to a specialist who works in your country.',
    'Tells you who they are before anything else happens.',
    'Keeps your enquiry for a stated period and then deletes it.'
  ],
  doesNot: [
    'Calculate your tax, your take-home pay, or a saving.',
    'Ask for your salary, your employer, or your notice period.',
    'Give you advice. The Hub is not an accountant and is not regulated to be one.'
  ]
});

function isTopic(value) {
  return TOPICS.some((t) => t.value === value);
}

function isArrangement(value) {
  return ARRANGEMENTS.some((a) => a.value === value);
}

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

/**
 * Asserted at boot beside the role taxonomy, for the same reason: a value list that is
 * read by a form, a validator and a database enum has to agree with itself, and a
 * mismatch shows up as a silently rejected submission rather than as a failure.
 */
function assertAdvisoryIntegrity() {
  const seen = new Set();
  for (const list of [TOPICS, ARRANGEMENTS]) {
    for (const item of list) {
      if (!item.value || !item.label) throw new Error('every option needs a value and a label');
      const key = `${list === TOPICS ? 'topic' : 'arrangement'}:${item.value}`;
      if (seen.has(key)) throw new Error(`duplicate option ${key}`);
      seen.add(key);
    }
  }
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const to of targets) {
      if (!TRANSITIONS[to]) throw new Error(`transition ${from} -> ${to} names an undeclared status`);
    }
  }
  if (!OPEN_STATUSES.length) throw new Error('at least one status must hold the open reservation');
  if (!(RETENTION_DAYS > 0)) throw new Error('retention must be a positive number of days');
  if (LIMITS.questionMin >= LIMITS.question) throw new Error('question bounds are inverted');
  return true;
}

module.exports = {
  TOPICS,
  ARRANGEMENTS,
  TRANSITIONS,
  STATUSES,
  OPEN_STATUSES,
  LIMITS,
  RETENTION_DAYS,
  PROMISE,
  isTopic,
  isArrangement,
  canTransition,
  assertAdvisoryIntegrity
};
