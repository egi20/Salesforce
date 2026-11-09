'use strict';

const { median } = require('./rateAggregation');
const { project } = require('./contractorEconomics');

/**
 * What companies PUBLISH on their adverts, summarised for /rates. Pure, over rows already
 * selected by `Job.rateRows` (open, not taken down, rate shown by the company).
 *
 * Unlike the community index this is not personal data — every figure is on a public job
 * page already — so there is no privacy floor. What there is instead is a count beside every
 * figure, because "median of 1 posting" is a different claim from "median of 40".
 *
 * Amounts are converted to EUR with the same frozen table the index uses
 * (`RateSubmission.toEur`), passed in so this stays testable without a database.
 */

function eurRange(row, toEur) {
  const min = row.rate_min == null ? null : toEur(Number(row.rate_min), row.currency || 'EUR');
  const max = row.rate_max == null ? null : toEur(Number(row.rate_max), row.currency || 'EUR');
  // One end published stands in for both: "from €700" is a budget of €700.
  return { min: min ?? max, max: max ?? min };
}

const sorted = (list) => [...list].sort((a, b) => a - b);

/** Contract adverts: per role, how many and the median of each end of the budget. */
function contractBudgets(rows, toEur) {
  const byRole = new Map();
  for (const row of rows || []) {
    if (row.engagement_type !== 'contract') continue;
    const range = eurRange(row, toEur);
    if (range.min == null) continue;
    const list = byRole.get(row.role) || [];
    list.push(range);
    byRole.set(row.role, list);
  }
  return [...byRole.entries()]
    .map(([role, list]) => ({
      role,
      postings: list.length,
      medianMin: Math.round(median(sorted(list.map((r) => r.min)))),
      medianMax: Math.round(median(sorted(list.map((r) => r.max))))
    }))
    .sort((a, b) => b.medianMax - a.medianMax);
}

const average = (list) => (list.length ? Math.round(list.reduce((s, v) => s + v, 0) / list.length) : null);

/**
 * Permanent adverts: average minimum, average maximum, the range, and the same per seniority.
 * "≈ €/day" divides by the working days an EMPLOYEE is paid for in the rate calculator's own
 * year — 260 less holiday — so the comparison with a day rate is like for like.
 */
function permanentSalaries(rows, toEur) {
  const ranges = [];
  const bySeniority = new Map();
  for (const row of rows || []) {
    if (row.engagement_type !== 'permanent') continue;
    const range = eurRange(row, toEur);
    if (range.min == null) continue;
    ranges.push(range);
    const list = bySeniority.get(row.seniority) || [];
    list.push(range);
    bySeniority.set(row.seniority, list);
  }
  if (!ranges.length) return { postings: 0 };

  const year = project({ dayRate: 1 });
  const paidDays = year.days.working - year.assumptions.holidayDays;
  const perDay = (annual) => (annual == null ? null : Math.round(annual / paidDays));

  const avgMin = average(ranges.map((r) => r.min));
  const avgMax = average(ranges.map((r) => r.max));
  return {
    postings: ranges.length,
    avgMin,
    avgMax,
    rangeMin: Math.min(...ranges.map((r) => r.min)),
    rangeMax: Math.max(...ranges.map((r) => r.max)),
    perDayMin: perDay(avgMin),
    perDayMax: perDay(avgMax),
    paidDays,
    bySeniority: ['junior', 'mid', 'senior', 'lead']
      .filter((s) => bySeniority.has(s))
      .map((s) => {
        const list = bySeniority.get(s);
        return { seniority: s, postings: list.length, avgMin: average(list.map((r) => r.min)), avgMax: average(list.map((r) => r.max)) };
      })
  };
}

module.exports = { contractBudgets, permanentSalaries };
