'use strict';

const FinanceInvoice = require('../models/FinanceInvoice');
const FinanceCost = require('../models/FinanceCost');
const { COST_CATEGORIES } = require('../config/finance');

/**
 * The profit-and-loss view.
 *
 * DERIVED AT READ TIME, never stored. The same rule the rate index follows and for a
 * stronger reason: a stored P&L is a number that can disagree with the invoices and costs
 * it was computed from, and the day it does, nobody can say which one is the business.
 *
 * TWO THINGS IT REFUSES TO DO, both of which would make it look more complete and mean
 * less:
 *
 * 1. IT DOES NOT CONVERT BETWEEN CURRENCIES. A figure that silently turned dollars into
 *    euros at a rate nobody recorded, on a date nobody recorded, is not a figure anybody
 *    can reconcile with a bank statement. Each currency gets its own column and its own
 *    bottom line; a business invoicing in two currencies has two answers, and that is the
 *    truth rather than a limitation.
 * 2. IT DOES NOT COMPUTE TAX. This is not revenue minus costs minus what you will owe —
 *    it is revenue minus costs. What that leaves after tax depends on jurisdiction, entity
 *    and a dozen things this application does not know, exactly as
 *    `utils/contractorEconomics.js` says.
 *
 * Revenue counts an invoice on its ISSUE DATE, not when it was paid — that is accrual, and
 * it is what makes a month's figure stable rather than moving every time a late payment
 * lands. Cash actually received is shown alongside it, as a separate line, because the two
 * answer different questions and conflating them is how a profitable month runs out of money.
 */

/** The months in a window, oldest first. `2026-01` through `2026-12`. */
function monthsBetween(fromMonth, toMonth) {
  const months = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [toY, toM] = toMonth.split('-').map(Number);
  while (y < toY || (y === toY && m <= toM)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

/** The window ending this month, `months` long. */
function defaultWindow(months = 12, now = new Date()) {
  const to = now.toISOString().slice(0, 7);
  const [y, m] = to.split('-').map(Number);
  const totalMonths = y * 12 + m - (months - 1);
  const fromY = Math.floor((totalMonths - 1) / 12);
  const fromM = ((totalMonths - 1) % 12) + 1;
  return { from: `${fromY}-${String(fromM).padStart(2, '0')}`, to };
}

/**
 * Build the statement. Pure over already-fetched rows, so the rules are testable without a
 * database — the same shape as `utils/rateAggregation.js`.
 */
function build({ months, revenueRows, costRows }) {
  const currencies = [
    ...new Set([...revenueRows.map((r) => r.currency), ...costRows.map((c) => c.currency)])
  ].sort();

  const byCurrency = currencies.map((currency) => {
    const rows = months.map((month) => {
      const revenue = revenueRows.find((r) => r.period === month && r.currency === currency);

      const costsForMonth = costRows
        .filter((c) => c.currency === currency)
        .map((c) => ({ cost: c, share: FinanceCost.monthlyShare(c, month) }))
        .filter((entry) => entry.share > 0);

      const costMinor = costsForMonth.reduce((sum, entry) => sum + entry.share, 0);

      // Net of VAT on both sides. VAT collected is not income and VAT paid is not a cost;
      // including either would flatter or punish a month depending on nothing but the rate.
      const revenueMinor = revenue ? Number(revenue.net_minor) : 0;
      const receivedMinor = revenue ? Number(revenue.paid_net_minor) : 0;

      const byCategory = {};
      for (const entry of costsForMonth) {
        byCategory[entry.cost.category] = (byCategory[entry.cost.category] || 0) + entry.share;
      }

      return {
        month,
        revenueMinor,
        receivedMinor,
        costMinor,
        resultMinor: revenueMinor - costMinor,
        invoices: revenue ? Number(revenue.invoices) : 0,
        byCategory
      };
    });

    const totals = rows.reduce(
      (acc, row) => ({
        revenueMinor: acc.revenueMinor + row.revenueMinor,
        receivedMinor: acc.receivedMinor + row.receivedMinor,
        costMinor: acc.costMinor + row.costMinor,
        resultMinor: acc.resultMinor + row.resultMinor
      }),
      { revenueMinor: 0, receivedMinor: 0, costMinor: 0, resultMinor: 0 }
    );

    const categoryTotals = COST_CATEGORIES.map((category) => ({
      ...category,
      minor: rows.reduce((sum, row) => sum + (row.byCategory[category.value] || 0), 0)
    })).filter((c) => c.minor > 0);

    return { currency, rows, totals, categoryTotals };
  });

  return { months, currencies, byCurrency };
}

/**
 * Re-checks the statement before it is rendered, and separates two things that must not be
 * shown as one.
 *
 * `problems` are ARITHMETIC. Revenue minus costs not equalling the result, or the months
 * not summing to the total, can only mean a bug in this module — the same standing as
 * `reconciliationProblems` in `utils/sowEstimation.js`.
 *
 * `notes` are SIGNALS about the underlying figures, and they are not faults. More cash
 * received in a month than was invoiced in it is ordinary: a January invoice paid in March
 * lands in March. Reporting that under a banner saying the statement does not reconcile
 * would teach whoever reads this page to ignore the banner, which is the one thing it
 * cannot afford.
 */
function reconciliationProblems(statement) {
  const problems = [];
  for (const block of statement.byCurrency) {
    for (const row of block.rows) {
      if (row.revenueMinor - row.costMinor !== row.resultMinor) {
        problems.push(`${block.currency} ${row.month}: revenue minus costs does not equal the result.`);
      }
    }
    const summed = block.rows.reduce((s, r) => s + r.resultMinor, 0);
    if (summed !== block.totals.resultMinor) {
      problems.push(`${block.currency}: the months do not sum to the total.`);
    }
    const summedRevenue = block.rows.reduce((s, r) => s + r.revenueMinor, 0);
    if (summedRevenue !== block.totals.revenueMinor) {
      problems.push(`${block.currency}: the months do not sum to the total revenue.`);
    }
  }
  return problems;
}

/** Observations about the figures. Never a fault — see above. */
function statementNotes(statement) {
  const notes = [];
  for (const block of statement.byCurrency) {
    for (const row of block.rows) {
      if (row.receivedMinor > row.revenueMinor) {
        notes.push(`${block.currency} ${row.month}: more was received than invoiced, which usually means an earlier invoice was paid this month.`);
      }
    }
  }
  return notes;
}

/**
 * The window a request may ask for.
 *
 * Both ends must be a real `YYYY-MM` and the window is capped, because `monthsBetween`
 * walks month by month and every month walks every cost row: `?from=0001-01&to=9999-12` is
 * twenty-four thousand iterations of that on a page anyone signed in as superadmin can
 * reload. A bad or oversized window falls back to the default rather than erroring — this
 * is a query string somebody edited, not an attack worth a stack trace.
 */
const MAX_WINDOW_MONTHS = 120;

function windowFrom(from, to) {
  const shape = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (!shape.test(String(from || '')) || !shape.test(String(to || ''))) return defaultWindow(12);
  if (from > to) return defaultWindow(12);

  const span = monthsBetween(from, to).length;
  if (span < 1 || span > MAX_WINDOW_MONTHS) return defaultWindow(12);
  return { from, to };
}

/** Fetch and build. The only thing a route calls. */
async function statementFor({ from, to } = {}) {
  const window = windowFrom(from, to);
  const months = monthsBetween(window.from, window.to);

  // Both sides get the SAME window. Revenue used to be fetched as "the last N months",
  // which silently answered a different question whenever the window was not the default.
  const [revenueRows, costRows] = await Promise.all([
    FinanceInvoice.revenueByMonth(window),
    FinanceCost.forWindow(window.from, window.to)
  ]);

  const statement = build({ months, revenueRows, costRows });
  return {
    ...statement,
    window,
    problems: reconciliationProblems(statement),
    notes: statementNotes(statement)
  };
}

module.exports = {
  monthsBetween,
  defaultWindow,
  windowFrom,
  MAX_WINDOW_MONTHS,
  build,
  reconciliationProblems,
  statementNotes,
  statementFor
};
