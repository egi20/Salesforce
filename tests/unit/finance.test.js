'use strict';

const fs = require('fs');

const finance = require('../../config/finance');
const FinanceCost = require('../../models/FinanceCost');
const FinanceInvoice = require('../../models/FinanceInvoice');
const pl = require('../../services/profitAndLoss');

/** Comments stripped, string literals kept — an SQL string is the thing being asserted on. */
function sqlOf(modulePath) {
  return fs
    .readFileSync(require.resolve(modulePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the finance catalogue', () => {
  test('passes its boot assertion', () => {
    expect(finance.assertFinanceIntegrity()).toBe(true);
  });

  test('cancelled is terminal and a draft stays editable', () => {
    expect(finance.INVOICE_TRANSITIONS.cancelled).toEqual([]);
    expect(finance.isImmutable('draft')).toBe(false);
    for (const status of ['issued', 'paid', 'cancelled']) {
      expect(finance.isImmutable(status)).toBe(true);
    }
  });

  test('there is no transition out of any status back to draft', () => {
    // A draft is the only editable state. A route that could push an issued invoice back to
    // draft would be an edit path wearing a status change.
    for (const targets of Object.values(finance.INVOICE_TRANSITIONS)) {
      expect(targets).not.toContain('draft');
    }
  });

  test('no VAT rate is defaulted anywhere in the module', () => {
    // The refusal that separates this from `utils/contractorEconomics.js`: the issuer states
    // the rate and this module multiplies. A "standard rate" constant here would be the app
    // guessing somebody's jurisdiction, which is the thing the rate calculator refuses to do.
    const source = sqlOf('../../config/finance');
    expect(source).not.toMatch(/DEFAULT_VAT|STANDARD_VAT|vatBps\s*=\s*\d+/);
  });
});

describe('line arithmetic', () => {
  test('rounds once per line, and the total is the sum of the printed lines', () => {
    // Three lines of 0.33 at 20%. Each line's VAT rounds to 7 cents, so the printed VAT is
    // 21 — not the 20 that rounding the summed net would give. The customer checks the
    // printed lines against the printed total, and those are what must agree.
    const lines = [
      { quantityMilli: 1000, unitPriceMinor: 33, vatBps: 2000 },
      { quantityMilli: 1000, unitPriceMinor: 33, vatBps: 2000 },
      { quantityMilli: 1000, unitPriceMinor: 33, vatBps: 2000 }
    ];
    const per = lines.map((l) => finance.lineTotals(l));
    const totals = finance.invoiceTotals(lines);

    expect(per.every((p) => p.vatMinor === 7)).toBe(true);
    expect(totals.netMinor).toBe(per.reduce((s, p) => s + p.netMinor, 0));
    expect(totals.vatMinor).toBe(per.reduce((s, p) => s + p.vatMinor, 0));
    expect(totals.grossMinor).toBe(totals.netMinor + totals.vatMinor);
  });

  test('a fractional quantity stays on integers', () => {
    expect(finance.lineTotals({ quantityMilli: 7500, unitPriceMinor: 1234, vatBps: 2100 })).toEqual({
      netMinor: 9255,
      vatMinor: 1944,
      grossMinor: 11_199
    });
  });

  test('zero VAT is valid, not missing', () => {
    // Reverse charge, exempt, outside scope. An invoice with no VAT is ordinary.
    expect(finance.lineTotals({ quantityMilli: 1000, unitPriceMinor: 10_000, vatBps: 0 })).toEqual({
      netMinor: 10_000,
      vatMinor: 0,
      grossMinor: 10_000
    });
  });

  test('a non-integer input contributes nothing rather than a float', () => {
    // A form field that arrived unvalidated must not become a fraction of a cent on an
    // invoice. It becomes zero, which `reconciliationProblems` then catches loudly.
    expect(finance.lineTotals({ quantityMilli: 1.5, unitPriceMinor: 100, vatBps: 2000 }).netMinor).toBe(0);
  });
});

describe('reconciliation', () => {
  const lines = [{ quantityMilli: 2000, unitPriceMinor: 5000, vatBps: 2000 }];

  test('accepts an invoice whose stored totals match its lines', () => {
    expect(
      finance.reconciliationProblems({ lines, net_minor: 10_000, vat_minor: 2000, gross_minor: 12_000 })
    ).toEqual([]);
  });

  test('refuses one where a stored total drifted', () => {
    const problems = finance.reconciliationProblems({
      lines,
      net_minor: 10_000,
      vat_minor: 2000,
      gross_minor: 12_001
    });
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('a typed decimal', () => {
  const { decimalToScaled } = FinanceInvoice;

  test('accepts both separators, because half of Europe writes a comma', () => {
    expect(decimalToScaled('12.34', 2)).toBe(1234);
    expect(decimalToScaled('12,34', 2)).toBe(1234);
  });

  test('cuts a third decimal rather than rounding it', () => {
    // Rounding silently produces an amount the person did not type. Cutting is visible the
    // moment they read the invoice back.
    expect(decimalToScaled('12.349', 2)).toBe(1234);
  });

  test('pads a short fraction', () => {
    expect(decimalToScaled('12.3', 2)).toBe(1230);
    expect(decimalToScaled('12', 2)).toBe(1200);
  });

  test('refuses anything that is not a number', () => {
    for (const bad of ['abc', '1.2.3', '.', '-', '12e5']) {
      expect(Number.isNaN(decimalToScaled(bad, 2))).toBe(true);
    }
  });

  test('a blank or absent field is refused, never read as a zero', () => {
    // This returned 0, and that made a line whose `vat_percent` key never arrived — a
    // renamed form field, a request assembled by hand — an invoice at 0% VAT with nothing
    // said, and a missing `unit_price` an invoice for nothing. A zero on an invoice is a
    // claim somebody makes, so it has to be typed.
    for (const missing of ['', '   ', null, undefined]) {
      expect(Number.isNaN(decimalToScaled(missing, 2))).toBe(true);
    }
  });

  test('a line missing its VAT or price is refused by name', () => {
    const line = { description: 'Discovery', quantity: '1', unit_price: '100', vat_percent: '19' };
    expect(() => FinanceInvoice.normaliseLines([line])).not.toThrow();

    for (const [field, code] of [['vat_percent', 'LINE_VAT'], ['unit_price', 'LINE_PRICE'], ['quantity', 'LINE_QUANTITY']]) {
      const without = { ...line };
      delete without[field];
      expect(() => FinanceInvoice.normaliseLines([without])).toThrow(expect.objectContaining({ code }));
    }
  });

  test('a typed zero is still accepted, because zero VAT is ordinary', () => {
    // Reverse charge, exempt, outside scope. Refusing absence must not refuse a real 0.
    const [line] = FinanceInvoice.normaliseLines([
      { description: 'Reverse charge supply', quantity: '1', unit_price: '100', vat_percent: '0' }
    ]);
    expect(line.vatBps).toBe(0);
    expect(line.vatMinor).toBe(0);
  });

  test('there is only one parser for a typed decimal', () => {
    // It existed twice, with a comment in the second saying "same rule as the invoice
    // lines" while the two had already drifted on negatives and on blanks. Two parsers
    // deciding what a number means is two answers to what the person typed.
    for (const modulePath of ['../../models/FinanceInvoice', '../../models/FinanceCost']) {
      const source = sqlOf(modulePath);
      expect(source).toMatch(/require\('\.\.\/utils\/decimalInput'\)/);
      expect(source).not.toMatch(/function (decimalToScaled|toMinor)\s*\(/);
    }
  });

  test('quantities scale to thousandths', () => {
    expect(decimalToScaled('7.5', 3)).toBe(7500);
    expect(decimalToScaled('1', 3)).toBe(1000);
  });
});

describe('the models refuse what the reference allowed', () => {
  test('nothing deletes an issued invoice', () => {
    const source = sqlOf('../../models/FinanceInvoice');
    // The reference's `CompanyInvoice.remove(id)` is a hard DELETE at any status, reachable
    // from a list button. Every DELETE here must be constrained to a draft, which holds no
    // number and therefore leaves no gap in the sequence.
    const deletes = source.match(/DELETE FROM finance_invoices[\s\S]{0,160}/g) || [];
    expect(deletes.length).toBeGreaterThan(0);
    for (const statement of deletes) {
      expect(statement).toMatch(/status\s*=\s*'draft'/);
    }
  });

  test('the number is allocated under a lock, never from a MAX()', () => {
    const source = sqlOf('../../models/FinanceInvoice');
    expect(source).toMatch(/FOR UPDATE/);
    expect(source).not.toMatch(/MAX\(invoice_seq\)/);
  });

  test('every finance query is parameterised', () => {
    const SQL = /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/;

    for (const modulePath of ['../../models/FinanceInvoice', '../../models/FinanceClient', '../../models/FinanceCost']) {
      const source = sqlOf(modulePath);

      // Only the backtick strings that are actually queries. An interpolation in an error
      // message is prose; one inside a query is a value reaching SQL unparameterised.
      const templates = (source.match(/`[^`]*`/g) || []).filter((t) => SQL.test(t));
      expect(templates.length).toBeGreaterThan(0);

      for (const template of templates) {
        // `${clause}` is the one permitted interpolation, and it is a clause of FIXED
        // fragments assembled by the builder beside a params[] array — never a value.
        const interpolations = (template.match(/\$\{([^}]+)\}/g) || []).filter((i) => i !== '${clause}');
        expect(interpolations).toEqual([]);
      }
    }
  });

  test('the finance route file is superadmin-gated before anything else', () => {
    const source = sqlOf('../../routes/finance');
    const gate = source.indexOf('isSuperadmin');
    const firstHandler = source.search(/router\.(get|post)\(/);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstHandler);
  });

  test('no route handler deletes an invoice', () => {
    const source = sqlOf('../../routes/finance');
    expect(source).not.toMatch(/FinanceInvoice\.(remove|destroy|delete)\b/);
  });
});

describe('what a cost contributes to a month', () => {
  const base = { amount_minor: 10_000, currency: 'EUR', category: 'software' };

  test('a date the driver returned as a Date works exactly like the string', () => {
    // THE BUG THIS WHOLE BLOCK MISSED. mysql2 hands a DATE column back as a JS Date, and
    // the apportionment did `String(cost.starts_on).slice(0, 10)` — 'Thu Jan 01'. Compared
    // as a string against '2026-02-01' that sorts after it, so EVERY recurring cost fell
    // outside EVERY window: the profit and loss showed zero costs beside real invoices,
    // with nothing in the log. These tests were green throughout, because a unit test
    // passes strings. So this one passes what the database actually returns.
    const asText = { ...base, recur_every: 'monthly', starts_on: '2026-01-01', ends_on: null };
    const asDate = { ...base, recur_every: 'monthly', starts_on: new Date('2026-01-01T00:00:00Z'), ends_on: null };

    for (const month of ['2025-12', '2026-01', '2026-06', '2027-03']) {
      expect(FinanceCost.monthlyShare(asDate, month)).toBe(FinanceCost.monthlyShare(asText, month));
    }
    expect(FinanceCost.monthlyShare(asDate, '2026-06')).toBe(10_000);
  });

  test('an end date returned as a Date closes the window', () => {
    const cost = {
      ...base,
      recur_every: 'monthly',
      starts_on: new Date('2026-01-01T00:00:00Z'),
      ends_on: new Date('2026-04-30T00:00:00Z')
    };
    expect(FinanceCost.monthlyShare(cost, '2026-04')).toBe(10_000);
    expect(FinanceCost.monthlyShare(cost, '2026-05')).toBe(0);
  });

  test('a cost with an unreadable start contributes nothing rather than everything', () => {
    expect(FinanceCost.monthlyShare({ ...base, recur_every: 'monthly', starts_on: null }, '2026-01')).toBe(0);
  });

  test('a one-off lands in its own month and nowhere else', () => {
    const cost = { ...base, recur_every: null, starts_on: '2026-03-14', ends_on: null };
    expect(FinanceCost.monthlyShare(cost, '2026-02')).toBe(0);
    expect(FinanceCost.monthlyShare(cost, '2026-03')).toBe(10_000);
    expect(FinanceCost.monthlyShare(cost, '2026-04')).toBe(0);
  });

  test('a monthly cost lands every month from its start', () => {
    const cost = { ...base, recur_every: 'monthly', starts_on: '2026-03-01', ends_on: null };
    for (const month of ['2026-03', '2026-04', '2026-05', '2027-01']) {
      expect(FinanceCost.monthlyShare(cost, month)).toBe(10_000);
    }
    expect(FinanceCost.monthlyShare(cost, '2026-02')).toBe(0);
  });

  test('a yearly cost lands on its anniversary, not spread over twelve', () => {
    // A P&L that disagrees with the bank statement is a P&L nobody trusts. The bank shows
    // the whole charge in March.
    const cost = { ...base, recur_every: 'yearly', starts_on: '2026-03-10', ends_on: null };
    expect(FinanceCost.monthlyShare(cost, '2026-03')).toBe(10_000);
    expect(FinanceCost.monthlyShare(cost, '2026-04')).toBe(0);
    expect(FinanceCost.monthlyShare(cost, '2027-03')).toBe(10_000);
  });

  test('a quarterly cost lands every third month', () => {
    const cost = { ...base, recur_every: 'quarterly', starts_on: '2026-01-05', ends_on: null };
    const landed = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-07', '2026-10'].filter(
      (m) => FinanceCost.monthlyShare(cost, m) > 0
    );
    expect(landed).toEqual(['2026-01', '2026-04', '2026-07', '2026-10']);
  });

  test('ending a cost keeps every past month and stops every future one', () => {
    // The reason `end` exists and `remove` refuses a cost that reached a past month:
    // deleting a subscription paid for four months removes four months of real expense
    // from statements that were already filed.
    const cost = { ...base, recur_every: 'monthly', starts_on: '2026-01-01', ends_on: '2026-04-30' };
    expect(FinanceCost.monthlyShare(cost, '2026-01')).toBe(10_000);
    expect(FinanceCost.monthlyShare(cost, '2026-04')).toBe(10_000);
    expect(FinanceCost.monthlyShare(cost, '2026-05')).toBe(0);
  });

  test('remove is constrained to a cost that has not reached a past month', () => {
    const source = sqlOf('../../models/FinanceCost');
    const deletes = source.match(/DELETE FROM finance_costs[^`']*/g) || [];
    expect(deletes.length).toBeGreaterThan(0);
    for (const statement of deletes) {
      expect(statement).toMatch(/starts_on\s*>=/);
    }
  });
});

describe('the profit and loss statement', () => {
  const months = pl.monthsBetween('2026-01', '2026-03');

  test('walks the window month by month, oldest first', () => {
    expect(months).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(pl.monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  test('keeps currencies apart rather than inventing a rate', () => {
    // Two currencies are two answers. Merging them would make the bottom line depend on
    // which day the page was opened.
    const statement = pl.build({
      months,
      revenueRows: [
        { period: '2026-01', currency: 'EUR', net_minor: 100_000, paid_net_minor: 100_000, invoices: 1 },
        { period: '2026-01', currency: 'USD', net_minor: 50_000, paid_net_minor: 0, invoices: 1 }
      ],
      costRows: []
    });

    expect(statement.currencies).toEqual(['EUR', 'USD']);
    const eur = statement.byCurrency.find((b) => b.currency === 'EUR');
    const usd = statement.byCurrency.find((b) => b.currency === 'USD');
    expect(eur.totals.revenueMinor).toBe(100_000);
    expect(usd.totals.revenueMinor).toBe(50_000);
    expect(pl.reconciliationProblems(statement)).toEqual([]);
  });

  test('each month reconciles and the months sum to the total', () => {
    const statement = pl.build({
      months,
      revenueRows: [{ period: '2026-02', currency: 'EUR', net_minor: 300_000, paid_net_minor: 0, invoices: 2 }],
      costRows: [
        { currency: 'EUR', category: 'hosting', amount_minor: 5000, recur_every: 'monthly', starts_on: '2026-01-01', ends_on: null }
      ]
    });

    const block = statement.byCurrency[0];
    expect(block.totals.costMinor).toBe(15_000);
    expect(block.totals.resultMinor).toBe(300_000 - 15_000);
    expect(block.rows.reduce((s, r) => s + r.resultMinor, 0)).toBe(block.totals.resultMinor);
    expect(pl.reconciliationProblems(statement)).toEqual([]);
  });

  test('a late payment is a note, not a reconciliation failure', () => {
    // Cash received in a month can exceed that month's invoicing: a January invoice paid in
    // March lands in March. Reporting that under a banner saying the statement does not
    // reconcile teaches whoever reads the page to ignore the banner.
    const statement = pl.build({
      months,
      revenueRows: [{ period: '2026-01', currency: 'EUR', net_minor: 0, paid_net_minor: 100_000, invoices: 1 }],
      costRows: []
    });

    expect(pl.reconciliationProblems(statement)).toEqual([]);
    expect(pl.statementNotes(statement).length).toBe(1);
  });

  test('a requested window is refused rather than walked when it is absurd', () => {
    // `monthsBetween` walks month by month and every month walks every cost row, so an
    // unclamped `?from=0001-01&to=9999-12` is a hundred thousand iterations of that on a
    // page anyone signed in can reload.
    const wide = pl.windowFrom('0001-01', '9999-12');
    expect(pl.monthsBetween(wide.from, wide.to).length).toBeLessThanOrEqual(pl.MAX_WINDOW_MONTHS);

    expect(pl.windowFrom('2026-13', '2026-12')).toEqual(pl.defaultWindow(12));
    expect(pl.windowFrom('2026-06', '2025-01')).toEqual(pl.defaultWindow(12));
    expect(pl.windowFrom('2024-01', '2024-12')).toEqual({ from: '2024-01', to: '2024-12' });
  });

  test('revenue is fetched for the window that was asked for', () => {
    // It used to be fetched as "the last N months" whatever the window was, so last year's
    // statement showed this year's revenue rows — which matched none of the requested
    // months and rendered as a year of zeros beside real costs.
    const source = sqlOf('../../models/FinanceInvoice');
    expect(source).toMatch(/revenueByMonth\(\{ from, to \}/);
    expect(source).not.toMatch(/DATE_SUB\(DATE_FORMAT\(CURDATE\(\)/);
  });

  test('the default window is twelve months ending this month', () => {
    const w = pl.defaultWindow(12, new Date('2026-09-17T00:00:00Z'));
    expect(w).toEqual({ from: '2025-10', to: '2026-09' });
    expect(pl.monthsBetween(w.from, w.to).length).toBe(12);
  });

  test('it computes no tax and converts no currency', () => {
    // The same refusal `utils/contractorEconomics.js` carries, and the reason this area
    // could be built at all: it reports what was invoiced and what was spent, and stops.
    const source = sqlOf('../../services/profitAndLoss');
    expect(source).not.toMatch(/taxRate|taxDue|taxSaving|exchangeRate|convertTo|fxRate/i);
    expect(Object.keys(pl)).not.toContain('tax');
  });
});
