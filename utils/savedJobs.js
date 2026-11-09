'use strict';

/**
 * Ordering for /dashboard/saved. Pure, over rows `Job.listSaved` already fetched, so the
 * three orders are testable without a database.
 *
 * "Highest rate" ranks only what the company PUBLISHED: a rate an employer hid on the job
 * page must not decide where its card sits, or the order would leak it. Day rates and annual
 * salaries are different units, so contract roles come first by their EUR day rate,
 * permanent roles after them by their EUR salary, and roles with no published figure last —
 * putting a €700 day next to a €70,000 year and calling one "higher" would be nonsense.
 */

const SAVED_SORTS = Object.freeze([
  { value: 'recent', label: 'Recently saved' },
  { value: 'newest', label: 'Newest posting' },
  { value: 'rate', label: 'Highest rate' }
]);

function sortFrom(raw) {
  return SAVED_SORTS.some((s) => s.value === raw) ? raw : 'recent';
}

const time = (value) => (value ? new Date(value).getTime() || 0 : 0);

/** The published top of the range in EUR, or null when the company shows no figure. */
function publishedRateEur(job, toEur) {
  if (!job.rate_visible) return null;
  const max = Number(job.rate_max);
  const min = Number(job.rate_min);
  const top = Number.isFinite(max) && max > 0 ? max : Number.isFinite(min) && min > 0 ? min : null;
  return top == null ? null : toEur(top, job.currency || 'EUR');
}

function rateTier(job, rate) {
  if (rate == null) return 2;
  return job.engagement_type === 'permanent' ? 1 : 0;
}

function sortSaved(rows, sort, toEur) {
  const list = [...(rows || [])];
  const bySaved = (a, b) => time(b.saved_at) - time(a.saved_at) || b.id - a.id;
  if (sort === 'newest') return list.sort((a, b) => time(b.published_at) - time(a.published_at) || bySaved(a, b));
  if (sort === 'rate') {
    const rate = new Map(list.map((j) => [j.id, publishedRateEur(j, toEur)]));
    return list.sort((a, b) => {
      const ra = rate.get(a.id);
      const rb = rate.get(b.id);
      return rateTier(a, ra) - rateTier(b, rb) || (rb || 0) - (ra || 0) || bySaved(a, b);
    });
  }
  return list.sort(bySaved);
}

module.exports = { SAVED_SORTS, sortFrom, sortSaved, publishedRateEur };
