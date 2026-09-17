'use strict';

/**
 * The one parser for a decimal somebody typed into a money or quantity field.
 *
 * ONE PARSER, for the same reason there is one filter builder per browsable thing. This
 * existed twice — once in `models/FinanceInvoice.js` for invoice lines and once in
 * `models/FinanceCost.js` for cost amounts — with a comment in the second saying "same rule
 * as the invoice lines". They had already drifted: one accepted a leading minus and the
 * other did not, and only one of them treated a blank field as zero. Two parsers deciding
 * what a number means is two answers to "what did this person type".
 *
 * Deliberately strict about the SHAPE and forgiving about the SEPARATORS. A comma decimal is
 * how most of Europe writes it, and refusing it produces an invoice for a hundred times the
 * intended amount the moment somebody retypes the figure without the comma. Non-breaking and
 * narrow no-break spaces are stripped because that is what a copied-in thousands separator
 * actually is.
 *
 * AN ABSENT OR BLANK FIELD IS NOT A ZERO. This returned 0 for an empty string, and against a
 * real database that meant a line whose `vat_percent` key never arrived — a renamed form
 * field, a request assembled by hand — was invoiced at 0% VAT without a word, and a missing
 * `unit_price` became an invoice for nothing. A zero on an invoice is a claim somebody
 * makes: it has to be typed. Every caller already refuses NaN with a named error naming the
 * field, so refusing here costs nothing and closes both holes at once.
 */

const SEPARATORS = /[\s\u00A0\u202F]/g;

/**
 * `decimalToScaled('12.34', 2)` is 1234; `decimalToScaled('7,5', 3)` is 7500.
 *
 * Extra decimals are CUT, never rounded: rounding silently produces an amount the person did
 * not type, and cutting is visible the moment they read the invoice back.
 *
 * Returns NaN for anything that is not a number, including blank. Callers check with
 * `Number.isInteger` and fail with a message naming the field.
 */
function decimalToScaled(value, scale, { allowNegative = true } = {}) {
  const raw = String(value ?? '').trim().replace(SEPARATORS, '').replace(',', '.');
  if (!raw) return NaN;

  const shape = allowNegative ? /^-?\d*\.?\d*$/ : /^\d*\.?\d*$/;
  if (!shape.test(raw) || raw === '.' || raw === '-') return NaN;

  const negative = raw.startsWith('-');
  const [whole = '0', fraction = ''] = raw.replace('-', '').split('.');
  const scaled = Number(`${whole || '0'}${fraction.padEnd(scale, '0').slice(0, scale)}`);
  if (!Number.isSafeInteger(scaled)) return NaN;
  return negative ? -scaled : scaled;
}

/**
 * A date column as `YYYY-MM-DD`, whatever the driver handed back.
 *
 * `mysql2` returns a DATE as a JS `Date`, so `String(row.starts_on).slice(0, 10)` is
 * `'Thu Jan 01'` — which then compares as a string against `'2026-02-01'` and, because 'T'
 * sorts after '2', places every recurring cost outside every window. The profit and loss
 * showed zero costs against real invoices and no error anywhere.
 *
 * That bug survived a green unit test, because a unit test passes strings. It lives here so
 * that anything comparing a stored date to a `YYYY-MM` window goes through one normalisation.
 */
function isoDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // UTC. The driver parses a DATE at midnight; reading it back in a local timezone west of
    // UTC would move it to the previous day, and a cost would start a month early once a
    // year.
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

module.exports = { decimalToScaled, isoDate };
