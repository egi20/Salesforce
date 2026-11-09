'use strict';

const fs = require('fs');
const path = require('path');

const { payrollProblems } = require('../public/js/tax-calculator');

/**
 * The Albania employment program behind /tax-optimization ("Tax optimization").
 *
 * WHAT CHANGED, AND WHY THIS IS NOT THE CALCULATOR THIS CODEBASE REFUSED. The reference's
 * `/tax-optimization/calculate` subtracted an admin-editable flat percentage of gross from
 * anybody's pay, anywhere, and called the difference a saving. Its number was a marketing
 * dial. The program here is a real thing with a real payroll: a consultant is employed by
 * the Albania entity and paid through Albanian payroll. So the calculator applies THAT
 * payroll — its contribution rates, its income-tax brackets, its fee — and nothing else:
 *
 *  - The parameters live in config/tax-program.json, owned by finance and legal and changed
 *    by a reviewed commit, never by a settings checkbox. Every value starts null, and null
 *    HIDES: no parameters, no figure ("Figures aren't available yet — ask about your setup").
 *  - The arithmetic is one file, `public/js/tax-calculator.js`, which runs in the browser.
 *    Nothing typed into it is posted or stored; there is no endpoint to post it to.
 *  - Every result carries the sentence that keeps it honest: home-country tax obligations
 *    still apply. The figure is the program's payroll, not somebody's tax position.
 *
 * Every other number on the page (typical saving, tax treaties, onboarding weeks, review
 * hours) is here too, and is hidden when null. Nothing is copied from another site.
 *
 * `TAX_PROGRAM_FILE` points at a different file — a staging environment, or a test fixture.
 */

const DEFAULT_FILE = path.join(__dirname, 'tax-program.json');

/** Below this many active participants, the trust card says "active consultants" without a number. */
const ACTIVE_COUNT_FLOOR = 10;

function isCount(n) {
  return Number.isInteger(n) && n >= 0;
}

function optionalCount(value, name, problems) {
  if (value === null || value === undefined) return null;
  if (!isCount(value)) {
    problems.push(`${name} must be a whole number or null`);
    return null;
  }
  return value;
}

function optionalText(value, name, problems, max = 160) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    problems.push(`${name} must be text of at most ${max} characters, or null`);
    return null;
  }
  return value.trim();
}

/**
 * Read and validate the facts. Throws on a malformed file: these figures are published, and
 * a typo in a rate must stop the deploy rather than reach a page — the same standing
 * `config/estimation.js` takes on percentages that do not sum to 100.
 *
 * THE FILE (config/tax-program.json, snake_case, amounts in minor units, rates in basis
 * points; every key may be null and null hides what depends on it):
 *
 *   program_fee            { label, rate_bps, fixed_monthly_minor } — publishable on its own
 *   income_tax_bands       [{ from_monthly_minor, rate_bps }], marginal, first band from 0
 *   employee_contributions [{ label, rate_bps, cap_monthly_minor|null, reduces_taxable_income }]
 *   employer_contributions [{ label, rate_bps, cap_monthly_minor|null, paid_from_gross }]
 *   months_per_year        whole number of salary payments a year
 *
 * The calculator is ON when the four payroll keys and the fee are all set — an empty list is
 * "none", and has to be written as [] by somebody who knows. Half of them set is refused:
 * a calculator that silently leaves out the contributions nobody filled in would print a
 * take-home far above the real one.
 *
 * The Dynamics Hub calculator (same Albania entity) is the special case
 *   new net = gross − (gross × percentRate / 100 + fixedFee)
 * whose percentRate and fixedFee are admin settings in DH's database (Admin > Settings >
 * Tax Calculator). Its exact equivalent here is: program_fee { rate_bps: percentRate × 100,
 * fixed_monthly_minor: fixedFee × 100 }, income_tax_bands [{ from_monthly_minor: 0,
 * rate_bps: 0 }], both contribution lists [], months_per_year 12. Copy the values from that
 * screen; the 5 % in DH's code is a fallback, not the rate the program charges.
 */
function loadProgram(file = process.env.TAX_PROGRAM_FILE || DEFAULT_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = [];
  const has = (key) => raw[key] !== undefined && raw[key] !== null;

  const currency = typeof raw.currency === 'string' && /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : null;
  if (!currency) problems.push('currency must be a three-letter ISO code');

  const typical = raw.typical_saving_annual_minor || {};
  const program = {
    currency,
    entityName: optionalText(raw.entity_name, 'entity_name', problems),
    techPark: optionalText(raw.tech_park, 'tech_park', problems),
    typicalSavingAnnualMinor: {
      min: optionalCount(typical.min, 'typical_saving_annual_minor.min', problems),
      max: optionalCount(typical.max, 'typical_saving_annual_minor.max', problems)
    },
    averageSavingAnnualMinor: optionalCount(raw.average_saving_annual_minor, 'average_saving_annual_minor', problems),
    taxTreaties: optionalCount(raw.tax_treaties, 'tax_treaties', problems),
    onboardingWeeks: optionalCount(raw.onboarding_weeks, 'onboarding_weeks', problems),
    reviewHours: optionalCount(raw.review_hours, 'review_hours', problems),
    minimumGrossMonthlyMinor: optionalCount(raw.minimum_gross_monthly_minor, 'minimum_gross_monthly_minor', problems),
    fee: null,
    payroll: null
  };

  /*
   * The fee is its own key so it can be PUBLISHED before the payroll rates: "what does it
   * cost" is the first question somebody asks. It is still ONE value — the calculator receives
   * this object inside the payroll — so the fee the FAQ states and the fee the calculator
   * deducts can never be two different numbers.
   */
  if (has('program_fee')) {
    const f = raw.program_fee;
    const ok = f && typeof f === 'object' && typeof f.label === 'string' && f.label.trim() &&
      Number.isInteger(f.rate_bps) && f.rate_bps >= 0 && f.rate_bps <= 10000 && isCount(f.fixed_monthly_minor);
    if (ok) program.fee = Object.freeze({ label: f.label.trim(), rateBps: f.rate_bps, fixedMonthlyMinor: f.fixed_monthly_minor });
    else problems.push('program_fee needs a label, a rate_bps of 0-10000 and a fixed_monthly_minor (0 when there is none), or null');
  }

  const PAYROLL_KEYS = ['income_tax_bands', 'employee_contributions', 'employer_contributions', 'months_per_year'];
  const set = PAYROLL_KEYS.filter(has);
  if (set.length && set.length < PAYROLL_KEYS.length) {
    problems.push(`set all of ${PAYROLL_KEYS.join(', ')} or none (missing: ${PAYROLL_KEYS.filter((k) => !has(k)).join(', ')}); use [] for "there are none"`);
  } else if (set.length) {
    if (!program.fee) problems.push('the payroll needs program_fee: the calculator would otherwise leave the fee out');
    const list = (key) => (Array.isArray(raw[key]) ? raw[key] : null);
    const payroll = {
      monthsPerYear: raw.months_per_year,
      contributions: list('employee_contributions') && list('employee_contributions').map((c) => ({
        label: c && c.label, rateBps: c && c.rate_bps, capMonthlyMinor: c ? c.cap_monthly_minor : undefined,
        reducesTaxableIncome: c && c.reduces_taxable_income
      })),
      employerContributions: list('employer_contributions') && list('employer_contributions').map((c) => ({
        label: c && c.label, rateBps: c && c.rate_bps, capMonthlyMinor: c ? c.cap_monthly_minor : undefined,
        paidFromGross: c && c.paid_from_gross
      })),
      incomeTax: {
        label: 'Income tax',
        brackets: list('income_tax_bands') && list('income_tax_bands').map((b) => ({ fromMonthlyMinor: b && b.from_monthly_minor, rateBps: b && b.rate_bps }))
      },
      fee: program.fee
    };
    if (program.fee) {
      for (const p of payrollProblems(payroll)) problems.push(`payroll: ${p}`);
      program.payroll = payroll;
    }
  }

  const { min, max } = program.typicalSavingAnnualMinor;
  if ((min === null) !== (max === null)) problems.push('typical_saving_annual_minor needs both min and max, or neither');
  if (min !== null && max !== null && min > max) problems.push('typical_saving_annual_minor.min is above max');

  if (problems.length) {
    throw new Error(`${path.basename(file)} is not usable:\n  - ${problems.join('\n  - ')}`);
  }
  return Object.freeze(program);
}

const PROGRAM = loadProgram();

/** `1250000` minor units in EUR -> "€12,500". Whole units: these are headline figures. */
function money(minor, currency = PROGRAM.currency) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0
  }).format(Math.round(minor / 100));
}

/** "€" for EUR — the label beside an amount field. */
function currencySymbol(currency = PROGRAM.currency) {
  const part = new Intl.NumberFormat('en-GB', { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency');
  return part ? part.value : currency;
}

function percent(bps) {
  return `${(bps / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}%`;
}

/** The program fee in words ("3% of your gross salary plus €50 a month"), or null when unset. */
function feeText(program = PROGRAM) {
  if (!program.fee) return null;
  const { rateBps, fixedMonthlyMinor } = program.fee;
  const parts = [];
  if (rateBps > 0) parts.push(`${percent(rateBps)} of your gross salary`);
  if (fixedMonthlyMinor > 0) parts.push(`${money(fixedMonthlyMinor, program.currency)} a month`);
  return parts.length ? parts.join(' plus ') : 'nothing';
}

/**
 * Who the program is for. Owned by finance and legal like the figures; a criterion that needs
 * a number appears only when that number is configured.
 */
function eligibility(program = PROGRAM) {
  const list = [
    'You work as a Salesforce consultant, developer, architect or administrator',
    'You work remotely, for clients you already have or are about to start with',
    'You are free to take up employment with a new employer',
    'You are willing to check your home-country position with a tax advisor before joining'
  ];
  if (program.minimumGrossMonthlyMinor !== null) {
    list.splice(2, 0, `Your gross pay is at least ${money(program.minimumGrossMonthlyMinor, program.currency)} a month`);
  }
  return list;
}

/** The three "Why Albania?" cards. */
function whyAlbania(program = PROGRAM) {
  return [
    {
      icon: 'bi-buildings',
      title: 'Special economic zone',
      text: `Our Albania entity operates in a technology park${program.techPark ? ` (${program.techPark})` : ''} where social contributions are reduced.`
    },
    {
      icon: 'bi-shield-check',
      title: 'Compliant structure',
      text:
        program.taxTreaties !== null
          ? `An ordinary Albanian employment contract. Albania has double-taxation treaties with ${program.taxTreaties} countries.`
          : 'An ordinary Albanian employment contract. Albania has double-taxation treaties with many countries — we check whether yours is one.'
    },
    {
      icon: 'bi-laptop',
      title: 'Flexible work',
      text: 'Keep working from where you live, for the clients you have. Where you live still decides your tax position — consult a tax advisor.'
    }
  ];
}

/**
 * The FAQ. Each answer is written so it stays true whatever is configured: a figure appears
 * only when the file has it. Legal and finance own the wording; "Is this legal?" must keep
 * its three points (home obligations apply, foreign tax credit, consult an advisor), and a
 * test asserts they are there.
 */
function faq(program = PROGRAM) {
  const fee = feeText(program);
  return [
    {
      q: 'Is this legal?',
      a: [
        'Yes. You are employed by our registered Albanian entity under an ordinary Albanian employment contract, and paid through Albanian payroll with tax and contributions withheld.',
        'Your home-country tax obligations still apply. Where you are tax-resident decides where you owe tax, and being employed in Albania does not change that.',
        'Albanian tax withheld from your salary may be claimable as a foreign tax credit at home, where your country has a double-taxation treaty with Albania.',
        'Consult a tax advisor in your country before joining. We will not tell you that your situation is fine without one.'
      ]
    },
    {
      q: 'Do I need to move to Albania?',
      a: [
        'No. You keep working from where you live now, for the same clients, with nothing about your day-to-day work changing.',
        'Where you live is exactly why your home-country rules still apply to you, which is why the application asks where you are tax-resident before anything else.'
      ]
    },
    {
      q: 'What about my existing clients?',
      a: [
        'You keep them: same clients, same projects, same people. The Albania entity becomes your employer and contracts with your clients for your work.',
        'What changes is who invoices them, not what you do for them. We agree how and when that switch happens with you before the contract starts.'
      ]
    },
    {
      q: 'How does payment work?',
      a: [
        'Your clients pay the Albania entity, and the entity pays you a monthly salary through Albanian payroll, with contributions and income tax withheld.',
        'Before you sign, you see in writing what payroll withholds from your gross, line by line. Once the rates are published, the calculator above shows the same lines.'
      ]
    },
    {
      q: 'Health insurance and pension?',
      a: [
        'As an employee of the Albania entity you are enrolled in Albanian social and health insurance through the contributions withheld from your salary.',
        'Whether those years count towards a pension at home depends on the social security agreement between your country and Albania, if there is one. Ask us, and check with your pension provider.'
      ]
    },
    {
      q: 'Can I switch back to my own company?',
      a: [
        'Yes. You end the employment with the notice period in your contract and go back to invoicing through your own company.',
        'Plan the change with your tax advisor: how it is taxed, and from which date, is decided by your home-country rules, not by the program.'
      ]
    },
    {
      q: 'Are there any hidden costs or fees?',
      a: [
        fee
          ? `No. The program fee is ${fee}, written into your contract${program.payroll ? ' and included in the calculator above' : ''}, and the Hub charges nothing else.`
          : 'No. The program fee is set out in your contract before you sign anything, and nothing is charged before then.',
        'What the program cannot include is your own home-country side: a tax return there, or a tax advisor\'s fee, stays with you.'
      ]
    },
    {
      q: 'How long does onboarding take?',
      a: [
        program.onboardingWeeks !== null
          ? `Usually about ${program.onboardingWeeks} weeks from approval to your first payroll.`
          : 'We give you a timeline when we approve your application.',
        'It is three steps: we review your application, you sign the employment contract, and you join the next monthly payroll.'
      ]
    }
  ];
}

/** What the program does and does not do — the "What we do / What we do not do" box. */
const PROMISE = Object.freeze({
  does: [
    'Employs you through our Albania entity, under an ordinary Albanian employment contract.',
    'Runs your Albanian payroll and shows you, before you sign, what it withholds.',
    'Keeps your application for a stated period and then deletes it.'
  ],
  doesNot: [
    'Take over your home-country tax obligations. They still apply.',
    'Give you tax advice. The Hub is not an accountant; consult a tax advisor before joining.',
    'Store anything you type into the calculator. It runs in your browser.'
  ]
});

/** Everything the page reads from this module, resolved once per request. */
function pageModel(program = PROGRAM) {
  const { min, max } = program.typicalSavingAnnualMinor;
  const stats = [
    program.averageSavingAnnualMinor !== null && {
      value: money(program.averageSavingAnnualMinor, program.currency),
      label: 'Average annual saving'
    },
    program.taxTreaties !== null && { value: String(program.taxTreaties), label: 'Tax treaties' },
    program.onboardingWeeks !== null && {
      value: `${program.onboardingWeeks} week${program.onboardingWeeks === 1 ? '' : 's'}`,
      label: 'To onboard'
    }
  ].filter(Boolean);

  return {
    currency: program.currency,
    entityName: program.entityName,
    techPark: program.techPark,
    savingRange: min !== null ? `${money(min, program.currency)}–${money(max, program.currency)}` : null,
    stats,
    reviewHours: program.reviewHours,
    payroll: program.payroll,
    fee: feeText(program),
    eligibility: eligibility(program),
    whyAlbania: whyAlbania(program),
    faq: faq(program),
    promise: PROMISE
  };
}

module.exports = {
  PROGRAM,
  PROMISE,
  ACTIVE_COUNT_FLOOR,
  loadProgram,
  pageModel,
  feeText,
  money,
  currencySymbol
};
