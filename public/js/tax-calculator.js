/*
 * The take-home calculator on /tax-optimization — the ONE implementation of its arithmetic.
 *
 * It runs in the browser (the figures somebody types never leave the page: there is no
 * endpoint to post them to and the inputs carry no `name`), and the same file is required by
 * the server, which uses `payrollProblems` to refuse a malformed parameter set at boot and to
 * decide whether the calculator is shown at all. One file, so the page and the boot check can
 * never disagree about what a parameter means.
 *
 * IT KNOWS NO RATE. Every rate, cap, bracket and fee arrives in `payroll`, which comes from
 * config/tax-program.json — owned by finance and legal, under version control, where a change
 * has an author and a review. A test asserts this file contains no numeric literal beyond the
 * unit constants below. With no payroll configured the page says "Calculator coming soon"
 * rather than showing a figure nobody stands behind.
 *
 * What it computes is narrow on purpose: the program's Albanian payroll applied to a gross,
 * against the net somebody says they take home today. It does NOT know their home country's
 * tax, which still applies to them — the page says so next to every result.
 *
 * Integers throughout: money is minor units, rates are basis points. Each line is rounded
 * once, and the net is gross minus the rounded lines, so the lines shown add up to the
 * difference shown — the same rule as an invoice.
 */
/* global module */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TaxCalculator = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BPS = 10000;
  var CENTS = 100;

  function isCount(n) {
    return Number.isInteger(n) && n >= 0;
  }

  function isLabel(s) {
    return typeof s === 'string' && s.trim().length > 0 && s.length <= 80;
  }

  /** Half-up rounding of `amount * bps / 10000`, on integers. */
  function share(amountMinor, bps) {
    return Math.round((amountMinor * bps) / BPS);
  }

  /**
   * Everything wrong with a parameter set, as sentences. An empty list means usable.
   * `null` is "not configured" and is reported as such, so the caller can tell the two apart.
   */
  function payrollProblems(payroll) {
    if (payroll === null || payroll === undefined) return ['not configured'];
    if (typeof payroll !== 'object') return ['payroll must be an object'];
    var problems = [];
    if (!(isCount(payroll.monthsPerYear) && payroll.monthsPerYear >= 1)) {
      problems.push('monthsPerYear must be a whole number of at least 1');
    }
    if (!Array.isArray(payroll.contributions)) {
      problems.push('contributions must be a list (it may be empty)');
    } else {
      payroll.contributions.forEach(function (c, i) {
        if (!c || !isLabel(c.label)) problems.push('contribution ' + i + ' needs a label');
        if (!c || !(isCount(c.rateBps) && c.rateBps <= BPS)) problems.push('contribution ' + i + ' rateBps must be 0-10000');
        if (c && c.capMonthlyMinor !== null && c.capMonthlyMinor !== undefined && !isCount(c.capMonthlyMinor)) {
          problems.push('contribution ' + i + ' capMonthlyMinor must be a whole number of minor units or null');
        }
        if (c && typeof c.reducesTaxableIncome !== 'boolean') {
          problems.push('contribution ' + i + ' must say whether it reducesTaxableIncome');
        }
      });
    }
    var tax = payroll.incomeTax;
    if (!tax || !Array.isArray(tax.brackets) || tax.brackets.length === 0) {
      problems.push('incomeTax.brackets must list at least one bracket');
    } else {
      tax.brackets.forEach(function (b, i) {
        if (!b || !isCount(b.fromMonthlyMinor)) problems.push('bracket ' + i + ' fromMonthlyMinor must be a whole number');
        if (!b || !(isCount(b.rateBps) && b.rateBps <= BPS)) problems.push('bracket ' + i + ' rateBps must be 0-10000');
        if (i === 0 && b && b.fromMonthlyMinor !== 0) problems.push('the first bracket must start at 0');
        if (i > 0 && b && tax.brackets[i - 1] && !(b.fromMonthlyMinor > tax.brackets[i - 1].fromMonthlyMinor)) {
          problems.push('brackets must be in ascending order');
        }
      });
    }
    var fee = payroll.fee;
    if (!fee || !isLabel(fee.label) || !(isCount(fee.rateBps) && fee.rateBps <= BPS) || !isCount(fee.fixedMonthlyMinor)) {
      problems.push('fee needs a label, a rateBps of 0-10000 and a fixedMonthlyMinor (0 when there is none)');
    }
    return problems;
  }

  /** Marginal income tax over the brackets, rounded once. */
  function incomeTaxOn(taxableMinor, brackets) {
    var scaled = 0;
    for (var i = 0; i < brackets.length; i += 1) {
      var from = brackets[i].fromMonthlyMinor;
      var to = i + 1 < brackets.length ? brackets[i + 1].fromMonthlyMinor : Infinity;
      if (taxableMinor <= from) break;
      scaled += (Math.min(taxableMinor, to) - from) * brackets[i].rateBps;
    }
    return Math.round(scaled / BPS);
  }

  /**
   * The program's payroll applied to `grossMinor`, compared with `currentNetMinor`.
   *
   * Returns null when the parameters are unusable or the inputs are not whole, non-negative
   * minor units — the caller shows "coming soon" or a field error, never a guessed figure.
   */
  function calculate(payroll, input) {
    if (payrollProblems(payroll).length) return null;
    var gross = input && input.grossMinor;
    var currentNet = input && input.currentNetMinor;
    if (!isCount(gross) || gross === 0 || !isCount(currentNet)) return null;

    var lines = [];
    var deductible = 0;
    payroll.contributions.forEach(function (c) {
      var base = c.capMonthlyMinor === null || c.capMonthlyMinor === undefined ? gross : Math.min(gross, c.capMonthlyMinor);
      var amount = share(base, c.rateBps);
      if (c.reducesTaxableIncome) deductible += amount;
      lines.push({ label: c.label, amountMinor: amount });
    });

    var taxable = Math.max(0, gross - deductible);
    lines.push({ label: payroll.incomeTax.label || 'Income tax', amountMinor: incomeTaxOn(taxable, payroll.incomeTax.brackets) });
    lines.push({ label: payroll.fee.label, amountMinor: share(gross, payroll.fee.rateBps) + payroll.fee.fixedMonthlyMinor });

    var withheld = lines.reduce(function (sum, l) { return sum + l.amountMinor; }, 0);
    var newNet = gross - withheld;
    var monthly = newNet - currentNet;
    return {
      grossMinor: gross,
      lines: lines,
      newNetMinor: newNet,
      differenceMonthlyMinor: monthly,
      differenceYearlyMinor: monthly * payroll.monthsPerYear,
      monthsPerYear: payroll.monthsPerYear
    };
  }

  /**
   * A typed amount to minor units: "6000", "6,000", "6 000.50", "6000,5". Returns NaN for
   * anything else, including blank — a blank is not a zero.
   */
  function parseAmount(value) {
    var raw = String(value === null || value === undefined ? '' : value).trim().replace(/[\s\u00A0\u202F]/g, '');
    if (!raw) return NaN;
    // A comma followed by exactly three digits is a thousands separator; otherwise a decimal.
    raw = /,\d{3}(?!\d)/.test(raw) ? raw.replace(/,/g, '') : raw.replace(',', '.');
    var m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(raw);
    if (!m) return NaN;
    var cents = m[2] ? Number((m[2] + '0').slice(0, 2)) : 0;
    return Number(m[1]) * CENTS + cents;
  }

  return { payrollProblems: payrollProblems, calculate: calculate, parseAmount: parseAmount, incomeTaxOn: incomeTaxOn };
});
