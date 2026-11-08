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
 *    HIDES: no parameters, no figure ("Calculator coming soon — ask us about your setup").
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
 */
function loadProgram(file = process.env.TAX_PROGRAM_FILE || DEFAULT_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = [];

  const currency = typeof raw.currency === 'string' && /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : null;
  if (!currency) problems.push('currency must be a three-letter ISO code');

  const typical = raw.typicalSavingAnnualMinor || {};
  const program = {
    currency,
    entityName: optionalText(raw.entityName, 'entityName', problems),
    techPark: optionalText(raw.techPark, 'techPark', problems),
    typicalSavingAnnualMinor: {
      min: optionalCount(typical.min, 'typicalSavingAnnualMinor.min', problems),
      max: optionalCount(typical.max, 'typicalSavingAnnualMinor.max', problems)
    },
    averageSavingAnnualMinor: optionalCount(raw.averageSavingAnnualMinor, 'averageSavingAnnualMinor', problems),
    taxTreaties: optionalCount(raw.taxTreaties, 'taxTreaties', problems),
    onboardingWeeks: optionalCount(raw.onboardingWeeks, 'onboardingWeeks', problems),
    reviewHours: optionalCount(raw.reviewHours, 'reviewHours', problems),
    minimumGrossMonthlyMinor: optionalCount(raw.minimumGrossMonthlyMinor, 'minimumGrossMonthlyMinor', problems),
    payroll: raw.payroll === undefined ? null : raw.payroll
  };

  const { min, max } = program.typicalSavingAnnualMinor;
  if ((min === null) !== (max === null)) problems.push('typicalSavingAnnualMinor needs both min and max, or neither');
  if (min !== null && max !== null && min > max) problems.push('typicalSavingAnnualMinor.min is above max');

  if (program.payroll !== null) {
    for (const p of payrollProblems(program.payroll)) problems.push(`payroll: ${p}`);
  }

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

function percent(bps) {
  return `${(bps / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}%`;
}

/** The program fee in words, or null when the payroll is not configured. */
function feeText(program = PROGRAM) {
  if (!program.payroll) return null;
  const { rateBps, fixedMonthlyMinor } = program.payroll.fee;
  const parts = [];
  if (rateBps > 0) parts.push(`${percent(rateBps)} of gross`);
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
          ? `No. The program fee is ${fee}, the calculator includes it, and the Hub charges nothing else.`
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
  money
};
