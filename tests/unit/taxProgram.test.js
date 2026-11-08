'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const calc = require('../../public/js/tax-calculator');
const taxProgram = require('../../config/taxProgram');
const TaxProgram = require('../../models/TaxProgram');
const { PURGE } = require('../../models/AccountErasure');
const { OWNED } = require('../../services/dataExport');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'tax-program.json');
const fixture = taxProgram.loadProgram(FIXTURE);

function source(rel) {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
}

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * THE CALCULATOR KNOWS NO RATE. Every figure it applies arrives in the payroll parameters
 * from config/tax-program.json, owned by finance and legal. A rate typed into the script
 * would be a figure nobody reviewed, applied to somebody's pay.
 */
describe('public/js/tax-calculator.js', () => {
  test('contains no numeric literal beyond its unit constants', () => {
    const code = stripComments(source('public/js/tax-calculator.js'))
      // Regex quantifiers such as {1,9} and string contents are not rates.
      .replace(/\{\d+(,\d*)?\}/g, '')
      .replace(/'(?:\\.|[^'\\])*'/g, "''");
    const numbers = (code.match(/(?<![\w.])\d+(\.\d+)?(?![\w])/g) || []).map(Number);
    for (const n of numbers) expect([0, 1, 2, 80, 100, 10000]).toContain(n);
  });

  test('refuses to calculate without parameters', () => {
    expect(calc.payrollProblems(null)).toEqual(['not configured']);
    expect(calc.calculate(null, { grossMinor: 600000, currentNetMinor: 360000 })).toBeNull();
  });

  test('reports a malformed parameter set rather than guessing', () => {
    const bad = {
      monthsPerYear: 0,
      contributions: [{ label: '', rateBps: 20000, capMonthlyMinor: -1 }],
      incomeTax: { brackets: [{ fromMonthlyMinor: 5, rateBps: 100 }, { fromMonthlyMinor: 1, rateBps: 100 }] },
      fee: { label: 'Fee', rateBps: 100 }
    };
    const problems = calc.payrollProblems(bad);
    expect(problems.join('\n')).toMatch(/monthsPerYear/);
    expect(problems.join('\n')).toMatch(/needs a label/);
    expect(problems.join('\n')).toMatch(/rateBps must be 0-10000/);
    expect(problems.join('\n')).toMatch(/reducesTaxableIncome/);
    expect(problems.join('\n')).toMatch(/first bracket must start at 0/);
    expect(problems.join('\n')).toMatch(/ascending/);
    expect(problems.join('\n')).toMatch(/fixedMonthlyMinor/);
    expect(calc.calculate(bad, { grossMinor: 600000, currentNetMinor: 1 })).toBeNull();
  });

  test('applies the payroll exactly, on integers, and the lines add up', () => {
    const r = calc.calculate(fixture.payroll, { grossMinor: 700000, currentNetMinor: 400000 });
    // Social: capped at 5,000.00 -> 475.00. Health: 7,000 x 1.70% = 119.00. Not deductible: 70.00.
    // Taxable: 7,000 - 475 - 119 = 6,406. Tax: 3,000 x 13% + 406 x 23% = 390 + 93.38.
    // Fee: 3% of 7,000 = 210 + 50 fixed.
    expect(r.lines).toEqual([
      { label: 'Social insurance', amountMinor: 47500 },
      { label: 'Health insurance', amountMinor: 11900 },
      { label: 'Not deductible', amountMinor: 7000 },
      { label: 'Income tax', amountMinor: 48338 },
      { label: 'Program fee', amountMinor: 26000 }
    ]);
    const withheld = r.lines.reduce((s, l) => s + l.amountMinor, 0);
    expect(r.newNetMinor).toBe(700000 - withheld);
    expect(r.differenceMonthlyMinor).toBe(r.newNetMinor - 400000);
    expect(r.differenceYearlyMinor).toBe(r.differenceMonthlyMinor * 12);
  });

  test('income tax is marginal: crossing a threshold taxes only the part above it', () => {
    const brackets = fixture.payroll.incomeTax.brackets;
    expect(calc.incomeTaxOn(300000, brackets)).toBe(0);
    expect(calc.incomeTaxOn(300100, brackets)).toBe(13);
  });

  test('refuses inputs that are not amounts', () => {
    expect(calc.calculate(fixture.payroll, { grossMinor: 0, currentNetMinor: 0 })).toBeNull();
    expect(calc.calculate(fixture.payroll, { grossMinor: 1.5, currentNetMinor: 0 })).toBeNull();
    expect(calc.calculate(fixture.payroll, { grossMinor: NaN, currentNetMinor: 0 })).toBeNull();
  });

  test('parses what people type, and treats blank as nothing rather than zero', () => {
    expect(calc.parseAmount('6000')).toBe(600000);
    expect(calc.parseAmount('6,000')).toBe(600000);
    expect(calc.parseAmount('6 000.5')).toBe(600050);
    expect(calc.parseAmount('6000,25')).toBe(600025);
    expect(calc.parseAmount('')).toBeNaN();
    expect(calc.parseAmount('-5')).toBeNaN();
    expect(calc.parseAmount('5e3')).toBeNaN();
  });
});

describe('public/js/tax-page.js', () => {
  test('sends nothing anywhere and writes no markup', () => {
    const code = stripComments(source('public/js/tax-page.js'));
    expect(code).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|innerHTML|localStorage|sessionStorage|\.submit\(\)/);
  });
});

describe('config/taxProgram', () => {
  test('the committed file publishes no figure until finance and legal fill it in', () => {
    const committed = taxProgram.loadProgram(path.join(__dirname, '..', '..', 'config', 'tax-program.json'));
    const model = taxProgram.pageModel(committed);
    expect(committed.payroll).toBeNull();
    expect(model.stats).toEqual([]);
    expect(model.savingRange).toBeNull();
    expect(model.reviewHours).toBeNull();
    expect(model.fee).toBeNull();
    expect(JSON.stringify(model.faq)).not.toMatch(/\d/);
  });

  test('a configured file fills the page from its own figures', () => {
    const model = taxProgram.pageModel(fixture);
    expect(model.savingRange).toBe('€6,000–€18,000');
    expect(model.stats.map((s) => s.value)).toEqual(['€11,000', '40', '2 weeks']);
    expect(model.eligibility.join(' ')).toMatch(/€4,000 a month/);
    expect(model.whyAlbania[1].text).toMatch(/40 countries/);
    expect(JSON.stringify(model.faq)).toMatch(/3% of your gross salary plus €50 a month/);
    expect(model.fee).toBe('3% of your gross salary plus €50 a month');
  });

  test('the fee can be published before the payroll, and is the one the calculator deducts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxprog-'));
    const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

    const PAYROLL_KEYS = ['income_tax_bands', 'employee_contributions', 'employer_contributions', 'months_per_year'];
    const without = (keys) => Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, keys.includes(k) ? null : v]));

    const feeOnly = path.join(dir, 'fee.json');
    fs.writeFileSync(feeOnly, JSON.stringify(without(PAYROLL_KEYS)));
    const early = taxProgram.loadProgram(feeOnly);
    expect(early.payroll).toBeNull();
    expect(taxProgram.pageModel(early).fee).toMatch(/3% of your gross salary/);
    // The calculator is not live yet, so the answer must not say it includes the fee.
    const earlyCosts = taxProgram.pageModel(early).faq.find((f) => /hidden costs/.test(f.q)).a.join(' ');
    expect(earlyCosts).toMatch(/written into your contract, and the Hub/);
    expect(earlyCosts).not.toMatch(/calculator/);
    const liveCosts = taxProgram.pageModel(fixture).faq.find((f) => /hidden costs/.test(f.q)).a.join(' ');
    expect(liveCosts).toMatch(/included in the calculator above/);

    expect(fixture.payroll.fee).toBe(fixture.fee);

    // Half a payroll would print a take-home far above the real one: refused, naming the gap.
    const half = path.join(dir, 'half.json');
    fs.writeFileSync(half, JSON.stringify(without(['employer_contributions'])));
    expect(() => taxProgram.loadProgram(half)).toThrow(/or none \(missing: employer_contributions\)/);

    const noFee = path.join(dir, 'nofee.json');
    fs.writeFileSync(noFee, JSON.stringify(without(['program_fee'])));
    expect(() => taxProgram.loadProgram(noFee)).toThrow(/needs program_fee/);
  });

  test("Dynamics Hub's formula is the special case: new net = gross − (gross × rate + fixed fee)", () => {
    // DH: totalCosts = gross * percentRate/100 + fixedFee. These two numbers are TEST values;
    // the real ones are admin settings in DH's database and are not in this repository.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxprog-'));
    const file = path.join(dir, 'dh.json');
    const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({
      ...raw,
      program_fee: { label: 'Statutory & service costs', rate_bps: 700, fixed_monthly_minor: 12000 },
      income_tax_bands: [{ from_monthly_minor: 0, rate_bps: 0 }],
      employee_contributions: [],
      employer_contributions: [],
      months_per_year: 12
    }));
    const dh = taxProgram.loadProgram(file);
    const r = calc.calculate(dh.payroll, { grossMinor: 800000, currentNetMinor: 520000 });
    // 8000 - (8000 * 7% + 120) = 7320
    expect(r.newNetMinor).toBe(732000);
    expect(r.differenceMonthlyMinor).toBe(212000);
    expect(r.differenceYearlyMinor).toBe(2544000);
  });

  test('employer contributions come out of the gross only when the config says they do', () => {
    const base = { ...fixture.payroll, contributions: [], incomeTax: { brackets: [{ fromMonthlyMinor: 0, rateBps: 1000 }] } };
    const fromGross = calc.calculate(
      { ...base, employerContributions: [{ label: 'Employer social', rateBps: 1500, capMonthlyMinor: null, paidFromGross: true }] },
      { grossMinor: 100000, currentNetMinor: 1 }
    );
    // 1000 gross: employer 150 out of it, salary 850, tax 10% = 85, fee 3% of gross + 50 = 80.
    expect(fromGross.lines.map((l) => l.amountMinor)).toEqual([15000, 8500, 8000]);
    expect(fromGross.newNetMinor).toBe(100000 - 15000 - 8500 - 8000);
    const onTop = calc.calculate(
      { ...base, employerContributions: [{ label: 'Employer social', rateBps: 1500, capMonthlyMinor: null, paidFromGross: false }] },
      { grossMinor: 100000, currentNetMinor: 1 }
    );
    expect(onTop.onTop).toEqual([{ label: 'Employer social', amountMinor: 15000 }]);
    expect(onTop.newNetMinor).toBe(100000 - 10000 - 8000);
  });

  test('refuses a malformed file instead of publishing it', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taxprog-')), 'p.json');
    fs.writeFileSync(file, JSON.stringify({
      currency: 'euro', tax_treaties: -1, typical_saving_annual_minor: { min: 5 },
      program_fee: { label: 'Fee', rate_bps: 100, fixed_monthly_minor: 0 },
      income_tax_bands: [], employee_contributions: [], employer_contributions: [], months_per_year: 12
    }));
    expect(() => taxProgram.loadProgram(file)).toThrow(/currency[\s\S]*tax_treaties[\s\S]*payroll:[\s\S]*both min and max/);
  });

  test('no FAQ answer is a one-liner', () => {
    for (const program of [fixture, taxProgram.loadProgram(path.join(__dirname, '..', '..', 'config', 'tax-program.json'))]) {
      for (const item of taxProgram.pageModel(program).faq) {
        expect(item.a.length).toBeGreaterThanOrEqual(2);
        for (const para of item.a) expect(para.length).toBeGreaterThan(40);
      }
    }
  });

  test('"Is this legal?" keeps the three points legal asked for', () => {
    const legal = taxProgram.pageModel(fixture).faq.find((f) => f.q === 'Is this legal?');
    const text = legal.a.join(' ');
    expect(text).toMatch(/home-country tax obligations still apply/i);
    expect(text).toMatch(/foreign tax credit/i);
    expect(text).toMatch(/consult a tax advisor/i);
  });
});

describe('models/TaxProgram', () => {
  test('publishes a first name and an initial, never the full name', () => {
    expect(TaxProgram.shortName('Arta Krasniqi')).toBe('Arta K.');
    expect(TaxProgram.shortName('Arta Maria Krasniqi')).toBe('Arta K.');
    expect(TaxProgram.shortName('Arta')).toBe('Arta');
    expect(TaxProgram.initialsOf('Arta Krasniqi')).toBe('AK');
  });

  test('a story is public only with consent, unwithdrawn, published, not hidden', () => {
    for (const clause of [
      's.consent_given_at IS NOT NULL',
      's.consent_withdrawn_at IS NULL',
      's.published_at IS NOT NULL',
      's.hidden_at IS NULL',
      'u.anonymised_at IS NULL'
    ]) {
      expect(TaxProgram.LIVE_STORY).toContain(clause);
    }
  });

  test('derives the differences from the two stored nets', () => {
    const s = TaxProgram.present({
      id: 1, name: 'Arta Krasniqi', role: 'Architect', country_code: 'DE', currency: 'EUR',
      gross_before_minor: 700000, net_before_minor: 400000, gross_after_minor: 700000, net_after_minor: 560000, quote: 'q'
    });
    expect(s.monthlyMinor).toBe(160000);
    expect(s.yearlyMinor).toBe(1920000);
  });

  test('both tables go with the account, and both are in the data export', () => {
    expect(PURGE).toEqual(expect.arrayContaining(['tax_program_participants', 'tax_program_stories']));
    expect(OWNED).toMatchObject({ tax_program_participants: 'user_id', tax_program_stories: 'user_id' });
  });
});

describe('config/regions countryGroups', () => {
  const { countryGroups, RESIDENCE_COUNTRY_CODES } = require('../../config/regions');
  const all = require('../../config/all-countries.json');

  test('puts the measured top first, then a short list, and drops uninhabited territories', () => {
    const g = countryGroups(all, ['IT', 'DE', 'ZZ']);
    expect(g.top.map((c) => c.code)).toEqual(['IT', 'DE']);
    expect(g.relevant.length).toBe(RESIDENCE_COUNTRY_CODES.length - 2);
    expect(g.relevant.map((c) => c.code)).not.toContain('IT');
    const everywhere = [...g.top, ...g.relevant, ...g.rest].map((c) => c.code);
    expect(new Set(everywhere).size).toBe(everywhere.length);
    for (const code of ['AQ', 'BV', 'HM']) expect(everywhere).not.toContain(code);
  });

  test('every code in the short list is a real country in the list', () => {
    const codes = new Set(all.map((c) => c.code));
    for (const code of RESIDENCE_COUNTRY_CODES) expect(codes).toContain(code);
    expect(new Set(RESIDENCE_COUNTRY_CODES).size).toBe(RESIDENCE_COUNTRY_CODES.length);
  });
});
