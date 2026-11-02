'use strict';

/**
 * Issue reports: the catalogue and the lifecycle.
 *
 * Kinds are a fixed list rather than free text, for the same reason `config/crm.js` refuses a
 * free-text lead source: a free-text category field fills up with "other" and stops sorting
 * anything.
 */
const ISSUE_KINDS = Object.freeze([
  { value: 'bug', label: 'Something is broken' },
  { value: 'wrong', label: 'Something is wrong or misleading' },
  { value: 'access', label: 'I cannot get into something' },
  { value: 'content', label: 'A problem with something somebody posted' },
  { value: 'idea', label: 'A suggestion' },
  { value: 'other', label: 'Something else' }
]);

const ISSUE_KIND_VALUES = Object.freeze(ISSUE_KINDS.map((k) => k.value));

/*
 * How badly it hurts (migration 034). Optional: NULL is "did not say", which is a different
 * fact from "low". `critical` is for the site being down or data being lost, and the queue
 * puts it first. Not asked of an idea, which is not a fault.
 */
const ISSUE_SEVERITIES = Object.freeze([
  { value: 'low', label: 'A nuisance — I can work around it' },
  { value: 'normal', label: 'It gets in my way' },
  { value: 'high', label: 'I cannot do what I came to do' },
  { value: 'critical', label: 'The site is down, or data is being lost' }
]);
const ISSUE_SEVERITY_VALUES = Object.freeze(ISSUE_SEVERITIES.map((s) => s.value));

/*
 * Screenshots (migration 034). Images only, re-encoded by sharp, at most a few, and deleted
 * this many days after the report is CLOSED — the report text stays as the record of what
 * was reported, but a picture can carry anything that was on somebody's screen. Stated on
 * the form and in the privacy policy, and checkable on /admin/issues.
 */
const SCREENSHOTS = Object.freeze({
  maxFiles: 3,
  maxBytes: 8 * 1024 * 1024,
  maxEdgePx: 2000,
  retentionDaysAfterClose: 90
});

/** The one kind that can be published on /ideas, with its sender's consent. */
const IDEA_KIND = 'idea';
/** The kind whose report names a page of content somebody posted. */
const CONTENT_KIND = 'content';

/**
 * The lifecycle. `closed` is terminal.
 *
 * There is no `deleted`. A report somebody dismissed is evidence that a person complained and
 * nothing happened — which is the single most useful row in this table when the same thing is
 * reported for the fourth time. Same reasoning as moderation hiding rather than deleting.
 */
const ISSUE_TRANSITIONS = Object.freeze({
  new: ['open', 'closed'],
  open: ['closed'],
  closed: []
});

const ISSUE_STATUSES = Object.freeze(Object.keys(ISSUE_TRANSITIONS));

const LIMITS = Object.freeze({
  summary: 200,
  detail: 4000,
  pagePath: 300,
  email: 190,
  response: 4000
});

function isIssueKind(value) {
  return ISSUE_KIND_VALUES.includes(value);
}

function isIssueStatus(value) {
  return ISSUE_STATUSES.includes(value);
}

function canTransition(from, to) {
  return Boolean(ISSUE_TRANSITIONS[from] && ISSUE_TRANSITIONS[from].includes(to));
}

/** Asserted at boot beside the other catalogues. */
function assertIssueIntegrity() {
  for (const [from, targets] of Object.entries(ISSUE_TRANSITIONS)) {
    for (const to of targets) {
      if (!ISSUE_TRANSITIONS[to]) throw new Error(`transition ${from} -> ${to} names an undeclared status`);
    }
  }
  if (ISSUE_TRANSITIONS.closed.length) throw new Error('closed must be terminal');

  // Every status must be reachable from `new`, or it is a state nothing can enter.
  const reachable = new Set(['new']);
  let changed = true;
  while (changed) {
    changed = false;
    for (const status of [...reachable]) {
      for (const next of ISSUE_TRANSITIONS[status]) {
        if (!reachable.has(next)) {
          reachable.add(next);
          changed = true;
        }
      }
    }
  }
  for (const status of ISSUE_STATUSES) {
    if (!reachable.has(status)) throw new Error(`status ${status} cannot be reached from new`);
  }

  // Every non-terminal status must reach `closed` in ONE step. The same rule `config/crm.js`
  // asserts for `unsubscribed`: somebody dealing with a queue should never have to move a row
  // twice to be rid of it, because the step they skip is the one that closes it.
  for (const status of ISSUE_STATUSES) {
    if (status !== 'closed' && !ISSUE_TRANSITIONS[status].includes('closed')) {
      throw new Error(`status ${status} cannot be closed in one step`);
    }
  }

  if (!ISSUE_KINDS.length) throw new Error('at least one issue kind is needed');
  // The two kinds the code branches on must exist, or a branch is silently dead.
  for (const kind of [IDEA_KIND, CONTENT_KIND]) {
    if (!ISSUE_KIND_VALUES.includes(kind)) throw new Error(`issue kind ${kind} is referenced but not declared`);
  }
  return true;
}

module.exports = {
  ISSUE_KINDS,
  ISSUE_KIND_VALUES,
  ISSUE_SEVERITIES,
  ISSUE_SEVERITY_VALUES,
  SCREENSHOTS,
  IDEA_KIND,
  CONTENT_KIND,
  ISSUE_TRANSITIONS,
  ISSUE_STATUSES,
  LIMITS,
  isIssueKind,
  isIssueStatus,
  canTransition,
  assertIssueIntegrity
};
