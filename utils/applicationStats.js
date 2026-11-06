'use strict';

/**
 * The consultant's application tracker, as pure functions over rows already fetched.
 *
 * Kept out of the route and the template for the same reason the rate index and the
 * estimator are pure: the three figures at the top of the page (this month, % seen, average
 * time to a response), the timeline under each row and the follow-up nudge are each one
 * rule, and a rule worth showing is a rule worth testing on its own.
 *
 * "Seen" means the company showed ANY sign of life: it opened the application (viewed_at) or
 * moved it, whichever came first — `seen_at`, computed in the model. A company that rejects
 * without opening the page has still answered.
 */

/** What each status reads as on the consultant's side. Order is the order of the bar. */
const STATUS_LABELS = Object.freeze({
  submitted: 'Applied',
  reviewing: 'In review',
  shortlisted: 'Shortlisted',
  interviewing: 'Interview',
  offered: 'Offer',
  hired: 'Hired',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn'
});
const STATUS_ORDER = Object.freeze(Object.keys(STATUS_LABELS));

/** After this many days with no sign of life, suggest a follow-up. */
const FOLLOW_UP_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

/** A step as the consultant reads it: answering an offer is named as the answer it was. */
function stepLabel(e) {
  if (e.from_status === null) return 'Applied';
  if (e.from_status === 'withdrawn' && e.to_status === 'submitted') return 'Applied again';
  if (e.from_status === 'offered' && e.to_status === 'withdrawn') return 'Offer declined';
  if (e.from_status === 'offered' && e.to_status === 'hired') return 'Offer accepted';
  return statusLabel(e.to_status);
}

function toTime(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * The three summary figures. `seenPercent` and `avgResponseDays` are null — shown as "—",
 * never as 0 — when there is nothing to measure: 0% of nothing is not a fact about anyone.
 */
function summary(rows, now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const thisMonth = rows.filter((r) => {
    const d = new Date(r.created_at);
    return d.getUTCFullYear() === year && d.getUTCMonth() === month;
  }).length;

  const seen = rows.filter((r) => r.seen_at);
  const waits = seen
    .map((r) => (toTime(r.seen_at) - toTime(r.created_at)) / DAY_MS)
    .filter((d) => Number.isFinite(d) && d >= 0);

  return {
    total: rows.length,
    thisMonth,
    seenPercent: rows.length ? Math.round((seen.length / rows.length) * 100) : null,
    avgResponseDays: waits.length ? Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 10) / 10 : null
  };
}

/**
 * "No reply after 14 days — follow up?": still at Applied, the company has not shown a sign
 * of life, the role is still open, and the wait has passed. A closed role is not chased.
 */
function followUpDue(app, now = new Date()) {
  if (app.status !== 'submitted' || app.seen_at || app.job_status !== 'open') return false;
  const created = toTime(app.created_at);
  return created !== null && now.getTime() - created >= FOLLOW_UP_DAYS * DAY_MS;
}

/**
 * The timeline under a row: every status change from the append-only event log, with
 * "Viewed by company" slotted in by time. The view is a fact from `viewed_at`, not an
 * event row, because the event log records STATUS changes and opening a page is not one.
 */
function timeline(app, events = []) {
  const steps = events.map((e) => ({
    label: stepLabel(e),
    at: new Date(e.created_at),
    status: e.to_status
  }));
  if (app.viewed_at) steps.push({ label: 'Viewed by company', at: new Date(app.viewed_at), status: 'viewed' });
  return steps.sort((a, b) => a.at - b.at);
}

module.exports = { STATUS_LABELS, STATUS_ORDER, FOLLOW_UP_DAYS, statusLabel, summary, followUpDue, timeline };
