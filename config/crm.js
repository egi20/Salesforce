'use strict';

/**
 * The internal sales CRM: leads, and the three rules that make holding them defensible.
 *
 * WHAT THIS FEATURE ACTUALLY IS. Every other table in this application holds data somebody
 * gave us: an account they created, a profile they published, a rate they contributed, an
 * enquiry they sent. This one holds the names, email addresses, phone numbers and job
 * titles of people who have not asked to be contacted, so that somebody can contact them.
 * That is a different kind of object and it carries obligations the reference
 * implementation's `crm_leads` has none of: a lawful basis, a record of where the contact
 * came from, a way to object, and a suppression list that outlives the row.
 *
 * So three rules, and each one is enforced in the schema or in a pure function rather than
 * left to a handler to remember:
 *
 * 1. A LEAD CANNOT EXIST WITHOUT A SOURCE. `source` is NOT NULL and must be one of the
 *    values below, and `source_detail` is required for most of them. "Where did you get
 *    this person's email" is the first question anybody will ask, and the answer has to be
 *    recorded at the moment of the import rather than reconstructed afterwards.
 *
 * 2. SUPPRESSION SURVIVES DELETION. `crm_suppressions` is keyed on a hash of the address
 *    and has no foreign key to `crm_leads`. Deleting a lead is exactly how the reference
 *    would lose the fact that its subject asked never to be contacted again — and a
 *    re-import next quarter would then write them straight back in.
 *
 * 3. NOTHING IS SENT FROM HERE. A draft is written, a person reads it, a person sends it
 *    from their own mail client, and a person records that they did. The reference has a
 *    "send queue"; an application that can mail a thousand strangers on a schedule is a
 *    different product with a different risk profile.
 */

/**
 * Where a contact came from. The list is deliberately short and concrete: a free-text
 * "source" field fills up with "web" and tells nobody anything a year later.
 *
 * `needsDetail` marks the ones where the category alone is not an answer — "a public
 * directory" is only meaningful with the directory named.
 */
const LEAD_SOURCES = Object.freeze([
  {
    value: 'inbound',
    label: 'They contacted us',
    needsDetail: true,
    help: 'A form, an email or a call from them. Name which.'
  },
  {
    value: 'event',
    label: 'Met at an event',
    needsDetail: true,
    help: 'Name the event and roughly when.'
  },
  {
    value: 'referral',
    label: 'Introduced by someone',
    needsDetail: true,
    help: 'Who made the introduction.'
  },
  {
    value: 'public_directory',
    label: 'A public business directory',
    needsDetail: true,
    help: 'Name the directory. A business address published for business contact is not the same as a personal one.'
  },
  {
    value: 'company_website',
    label: 'Published on the company website',
    needsDetail: true,
    help: 'The page it was published on.'
  },
  {
    value: 'existing_customer',
    label: 'Already a customer',
    needsDetail: false,
    help: 'They have an account or have paid for something.'
  }
]);

const SOURCE_VALUES = Object.freeze(LEAD_SOURCES.map((s) => s.value));

/**
 * The pipeline. Declared transitions, like `models/Application.js` — an undeclared move is
 * refused rather than written, so the board cannot reach a state the screen has no column
 * for.
 *
 * `unsubscribed` is terminal and is the ONLY status that writes a suppression. It is
 * reachable from anywhere, because somebody can ask to be left alone at any point.
 */
const TRANSITIONS = Object.freeze({
  new: ['contacted', 'parked', 'unsubscribed', 'disqualified'],
  contacted: ['replied', 'parked', 'unsubscribed', 'disqualified'],
  replied: ['qualified', 'parked', 'unsubscribed', 'disqualified'],
  qualified: ['won', 'lost', 'unsubscribed'],
  parked: ['contacted', 'unsubscribed', 'disqualified'],
  won: [],
  lost: [],
  disqualified: [],
  unsubscribed: []
});

const STATUSES = Object.freeze(Object.keys(TRANSITIONS));

/** Statuses after which nothing else happens. */
const TERMINAL = Object.freeze(STATUSES.filter((s) => TRANSITIONS[s].length === 0));

/** How an outreach message would go out. Recorded, never used to send anything. */
const CHANNELS = Object.freeze([
  { value: 'email', label: 'Email' },
  { value: 'linkedin', label: 'LinkedIn message' },
  { value: 'phone', label: 'Phone' },
  { value: 'other', label: 'Something else' }
]);

const CHANNEL_VALUES = Object.freeze(CHANNELS.map((c) => c.value));

/** What an activity records. Append-only; there is no edit and no delete. */
const OUTCOMES = Object.freeze([
  { value: 'sent', label: 'Sent a message' },
  { value: 'replied', label: 'They replied' },
  { value: 'no_reply', label: 'No reply' },
  { value: 'meeting', label: 'Had a meeting' },
  { value: 'refused', label: 'They said no' },
  { value: 'note', label: 'Just a note' }
]);

const OUTCOME_VALUES = Object.freeze(OUTCOMES.map((o) => o.value));

const LIMITS = Object.freeze({
  company: 200,
  contactName: 200,
  email: 190,
  phone: 40,
  jobTitle: 200,
  url: 500,
  sourceDetail: 300,
  note: 2000,
  draft: 4000,
  // A CSV import is read into memory and previewed before anything is written, so it is
  // bounded at a size a person can actually review.
  importRows: 500
});

/**
 * How long a lead nobody has touched is kept.
 *
 * Declared for the same reason the tax advisory enquiry's retention is: this is personal
 * data held for one named purpose, and a purpose that has visibly stopped applying is not
 * a purpose. A lead with no activity for this long is stale by definition — the person has
 * changed jobs, and holding their old work email helps nobody.
 */
const STALE_AFTER_DAYS = 540;

/** The bulk operations a screen may run, and the interlock they all share. */
const BULK_ACTIONS = Object.freeze(['delete', 'park']);

function isSource(value) {
  return SOURCE_VALUES.includes(value);
}

function sourceNeedsDetail(value) {
  const source = LEAD_SOURCES.find((s) => s.value === value);
  return Boolean(source && source.needsDetail);
}

function isStatus(value) {
  return STATUSES.includes(value);
}

function isChannel(value) {
  return CHANNEL_VALUES.includes(value);
}

function isOutcome(value) {
  return OUTCOME_VALUES.includes(value);
}

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

function isTerminal(status) {
  return TERMINAL.includes(status);
}

/** Asserted at boot beside the other catalogues. */
function assertCrmIntegrity() {
  if (!LEAD_SOURCES.length) throw new Error('a lead needs at least one possible source');
  const seen = new Set();
  for (const source of LEAD_SOURCES) {
    if (!source.value || !source.label || !source.help) {
      throw new Error(`source ${source.value} is missing a value, label or help text`);
    }
    if (seen.has(source.value)) throw new Error(`duplicate source ${source.value}`);
    seen.add(source.value);
  }

  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const to of targets) {
      if (!TRANSITIONS[to]) throw new Error(`transition ${from} -> ${to} names an undeclared status`);
    }
  }

  // Every non-terminal status must be able to reach `unsubscribed` in ONE step. Somebody
  // asking to be left alone should never depend on the pipeline being in the right place.
  for (const status of STATUSES) {
    if (isTerminal(status)) continue;
    if (!TRANSITIONS[status].includes('unsubscribed')) {
      throw new Error(`status ${status} cannot reach unsubscribed directly`);
    }
  }

  if (!TERMINAL.includes('unsubscribed')) throw new Error('unsubscribed must be terminal');
  if (!(STALE_AFTER_DAYS > 0)) throw new Error('the stale threshold must be positive');
  return true;
}

module.exports = {
  LEAD_SOURCES,
  SOURCE_VALUES,
  TRANSITIONS,
  STATUSES,
  TERMINAL,
  CHANNELS,
  CHANNEL_VALUES,
  OUTCOMES,
  OUTCOME_VALUES,
  LIMITS,
  STALE_AFTER_DAYS,
  BULK_ACTIONS,
  isSource,
  sourceNeedsDetail,
  isStatus,
  isChannel,
  isOutcome,
  canTransition,
  isTerminal,
  assertCrmIntegrity
};
