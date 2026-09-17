'use strict';

/**
 * The finance area: invoices, costs and a profit-and-loss view.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER FEATURE HERE. A job posting that is wrong
 * gets edited. An invoice that is wrong has already been sent to a customer and, in most
 * jurisdictions, recorded for tax. So this module has one rule the rest of the codebase
 * does not need:
 *
 *   AN ISSUED INVOICE IS IMMUTABLE, AND ITS NUMBER IS NEVER REUSED OR FREED.
 *
 * The reference implementation breaks both halves. `CompanyInvoice.remove(id)` is a hard
 * `DELETE FROM finance_invoices WHERE id = ?` reachable from a button on the list, at any
 * status — deleting an issued invoice leaves a gap in the sequence, which is the specific
 * thing an auditor looks for, and it cannot be undone. And the number itself comes from
 *
 *   SELECT COALESCE(MAX(invoice_seq), 0) + 1 FROM finance_invoices WHERE invoice_year = ?
 *
 * read outside any transaction, then inserted. Two invoices issued in the same second read
 * the same maximum and both get the same number. Two invoices bearing one number is not a
 * display bug.
 *
 * Here the number is allocated from a counter row locked FOR UPDATE inside the same
 * transaction that writes the invoice, with UNIQUE (year, seq) in the schema behind it —
 * belt and braces, the way every other idempotency rule in this codebase is enforced.
 *
 * ON VAT, AND WHY THIS IS NOT THE TAX REFUSAL. `utils/contractorEconomics.js` refuses to
 * compute tax because it would be GUESSING at somebody's jurisdiction and position. Here
 * nothing is guessed: the person issuing the invoice types the rate that applies, and this
 * module multiplies. Stating a rate you chose is bookkeeping; inferring one you did not is
 * advice. There is no default rate anywhere in this file for exactly that reason.
 */

/**
 * The invoice lifecycle.
 *
 * `draft` is the only editable state. Everything after it is a statement made to a
 * customer on a date.
 *
 * There is no `deleted`. A draft can be discarded because it was never issued and holds no
 * number; an issued invoice is CANCELLED, which keeps the row, keeps the number used, and
 * is visible on every report as a cancellation rather than as an absence.
 */
const INVOICE_TRANSITIONS = Object.freeze({
  draft: ['issued'],
  issued: ['paid', 'cancelled'],
  paid: ['cancelled'],
  cancelled: []
});

const INVOICE_STATUSES = Object.freeze(Object.keys(INVOICE_TRANSITIONS));

/** Statuses whose rows may never be edited. A draft is the only thing that can change. */
const IMMUTABLE_STATUSES = Object.freeze(INVOICE_STATUSES.filter((s) => s !== 'draft'));

/**
 * What a cost is for. Named categories rather than free text, for the same reason
 * `utils/contractorEconomics.js` names its non-billable days: "other: 4,200" a year later
 * is a number nobody can act on.
 */
const COST_CATEGORIES = Object.freeze([
  { value: 'software', label: 'Software and subscriptions' },
  { value: 'hosting', label: 'Hosting and infrastructure' },
  { value: 'contractors', label: 'Contractors and freelancers' },
  { value: 'salaries', label: 'Salaries' },
  { value: 'marketing', label: 'Marketing and advertising' },
  { value: 'office', label: 'Office, travel and equipment' },
  { value: 'professional', label: 'Accounting, legal and professional' },
  { value: 'banking', label: 'Bank charges and payment fees' },
  { value: 'other', label: 'Something else' }
]);

const COST_CATEGORY_VALUES = Object.freeze(COST_CATEGORIES.map((c) => c.value));

/** How often a recurring cost lands, and how many times a year that is. */
const COST_INTERVALS = Object.freeze([
  { value: 'monthly', label: 'Every month', perYear: 12 },
  { value: 'quarterly', label: 'Every quarter', perYear: 4 },
  { value: 'yearly', label: 'Once a year', perYear: 1 }
]);

const INTERVAL_VALUES = Object.freeze(COST_INTERVALS.map((i) => i.value));

/**
 * Currencies the finance area will accept.
 *
 * Deliberately a short list and NOT free text: a report that sums rows in three currencies
 * as though they were one is worse than a report that refuses the third. Nothing here
 * converts between them — a P&L is produced per currency.
 */
const CURRENCIES = Object.freeze(['EUR', 'USD', 'GBP', 'CHF', 'ALL']);

const LIMITS = Object.freeze({
  clientName: 200,
  address: 500,
  taxId: 64,
  email: 190,
  reference: 64,
  description: 300,
  note: 2000,
  lines: 50,
  // Minor units. A single line above ten million of anything is a typo, and a typo on an
  // invoice is the kind that gets paid.
  amountMinor: 1_000_000_000,
  quantityMilli: 1_000_000
});

/**
 * VAT rates are entered per line as BASIS POINTS — 2100 is 21.00%.
 *
 * Integers for the same reason every amount here is an integer: `19.6%` as a float times a
 * cent figure lands a cent away from what the customer's accountant computes, and an
 * invoice that is a cent out is an invoice somebody queries.
 *
 * Zero is valid and common (reverse charge, exempt, outside scope). There is no default:
 * the issuer states the rate.
 */
const MAX_VAT_BPS = 10_000;

function isInvoiceStatus(value) {
  return INVOICE_STATUSES.includes(value);
}

function canTransition(from, to) {
  return Boolean(INVOICE_TRANSITIONS[from] && INVOICE_TRANSITIONS[from].includes(to));
}

function isImmutable(status) {
  return IMMUTABLE_STATUSES.includes(status);
}

function isCostCategory(value) {
  return COST_CATEGORY_VALUES.includes(value);
}

function isInterval(value) {
  return INTERVAL_VALUES.includes(value);
}

function isCurrency(value) {
  return CURRENCIES.includes(value);
}

function perYear(interval) {
  const found = COST_INTERVALS.find((i) => i.value === interval);
  return found ? found.perYear : 0;
}

/**
 * The invoice number as it is printed.
 *
 * Year-scoped and sequential — `7/2026` — which is the shape most European jurisdictions
 * expect. Derived from the two stored columns rather than stored as a third: a label and
 * the numbers it is built from can otherwise disagree, and then nobody knows which is the
 * invoice.
 */
function invoiceLabel(year, seq) {
  return `${seq}/${year}`;
}

/**
 * Line arithmetic, as a pure function over integers.
 *
 * `quantityMilli` is thousandths, so 7.5 hours is 7500. Rounding happens ONCE, at the end
 * of each line, and the invoice total is the sum of the rounded lines — never the rounding
 * of a summed float. That is what makes the printed total equal the sum of the printed
 * lines, which is the only property a customer actually checks.
 */
function lineTotals({ quantityMilli, unitPriceMinor, vatBps }) {
  const q = Number.isInteger(quantityMilli) ? quantityMilli : 0;
  const unit = Number.isInteger(unitPriceMinor) ? unitPriceMinor : 0;
  const vat = Number.isInteger(vatBps) ? vatBps : 0;

  // Rounded half away from zero, matching what a person doing this on paper would write.
  const netMinor = Math.round((q * unit) / 1000);
  const vatMinor = Math.round((netMinor * vat) / 10_000);

  return { netMinor, vatMinor, grossMinor: netMinor + vatMinor };
}

/** An invoice's totals: the sum of its lines, each already rounded. */
function invoiceTotals(lines) {
  return (lines || []).reduce(
    (acc, line) => {
      const totals = lineTotals(line);
      return {
        netMinor: acc.netMinor + totals.netMinor,
        vatMinor: acc.vatMinor + totals.vatMinor,
        grossMinor: acc.grossMinor + totals.grossMinor
      };
    },
    { netMinor: 0, vatMinor: 0, grossMinor: 0 }
  );
}

/**
 * Re-check an invoice before it is shown, stored or downloaded, exactly as
 * `routes/quotes.js` re-checks an estimate. This combination can only mean a bug.
 */
function reconciliationProblems(invoice) {
  const problems = [];
  const lines = invoice.lines || [];

  const totals = invoiceTotals(lines);
  if (totals.netMinor !== invoice.net_minor) {
    problems.push(`Net is ${invoice.net_minor} but the lines sum to ${totals.netMinor}.`);
  }
  if (totals.vatMinor !== invoice.vat_minor) {
    problems.push(`VAT is ${invoice.vat_minor} but the lines sum to ${totals.vatMinor}.`);
  }
  if (totals.grossMinor !== invoice.gross_minor) {
    problems.push(`Total is ${invoice.gross_minor} but the lines sum to ${totals.grossMinor}.`);
  }
  if (invoice.net_minor + invoice.vat_minor !== invoice.gross_minor) {
    problems.push('Net plus VAT does not equal the total.');
  }
  for (const value of [invoice.net_minor, invoice.vat_minor, invoice.gross_minor]) {
    if (!Number.isInteger(value)) problems.push(`${value} is not an integer number of minor units.`);
  }
  return problems;
}

/** Asserted at boot beside the other catalogues. */
function assertFinanceIntegrity() {
  for (const [from, targets] of Object.entries(INVOICE_TRANSITIONS)) {
    for (const to of targets) {
      if (!INVOICE_TRANSITIONS[to]) throw new Error(`transition ${from} -> ${to} names an undeclared status`);
    }
  }
  if (INVOICE_TRANSITIONS.cancelled.length) throw new Error('cancelled must be terminal');
  if (IMMUTABLE_STATUSES.includes('draft')) throw new Error('a draft must stay editable');

  // Every status except draft must be reachable, or it is a state nothing can enter.
  const reachable = new Set(['draft']);
  let changed = true;
  while (changed) {
    changed = false;
    for (const status of [...reachable]) {
      for (const next of INVOICE_TRANSITIONS[status]) {
        if (!reachable.has(next)) {
          reachable.add(next);
          changed = true;
        }
      }
    }
  }
  for (const status of INVOICE_STATUSES) {
    if (!reachable.has(status)) throw new Error(`status ${status} cannot be reached from draft`);
  }

  if (!COST_CATEGORIES.length) throw new Error('at least one cost category is needed');
  if (COST_CATEGORY_VALUES.includes('')) throw new Error('a cost category needs a value');
  for (const interval of COST_INTERVALS) {
    if (!Number.isInteger(interval.perYear) || interval.perYear < 1) {
      throw new Error(`interval ${interval.value} has a bad perYear`);
    }
  }
  if (!CURRENCIES.length) throw new Error('at least one currency is needed');

  // The arithmetic, checked at boot with a case that has caught a rounding change before:
  // 7.5 units at 12.34 with 21% VAT.
  const sample = lineTotals({ quantityMilli: 7500, unitPriceMinor: 1234, vatBps: 2100 });
  if (sample.netMinor !== 9255 || sample.vatMinor !== 1944 || sample.grossMinor !== 11_199) {
    throw new Error(`line arithmetic changed: ${JSON.stringify(sample)}`);
  }
  return true;
}

module.exports = {
  INVOICE_TRANSITIONS,
  INVOICE_STATUSES,
  IMMUTABLE_STATUSES,
  COST_CATEGORIES,
  COST_CATEGORY_VALUES,
  COST_INTERVALS,
  INTERVAL_VALUES,
  CURRENCIES,
  LIMITS,
  MAX_VAT_BPS,
  isInvoiceStatus,
  canTransition,
  isImmutable,
  isCostCategory,
  isInterval,
  isCurrency,
  perYear,
  invoiceLabel,
  lineTotals,
  invoiceTotals,
  reconciliationProblems,
  assertFinanceIntegrity
};
