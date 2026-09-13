'use strict';

const fs = require('fs');

const advisory = require('../../config/taxAdvisory');
const TaxEnquiry = require('../../models/TaxEnquiry');

/**
 * Read a module's source with comments AND string literals stripped.
 *
 * The refusal tests below scan for tax- and saving-shaped identifiers, so anything that
 * only TALKS about the forbidden thing has to go first. Two kinds do:
 *
 *  - Comments. These files explain at length why a savings calculator is not here, which
 *    means a naive scan flags the very prose that documents the rule.
 *  - String literals. `config/taxAdvisory.js` publishes the sentence "Ask for your
 *    salary, your employer, or your notice period" in its list of things the Hub does
 *    NOT do. A scan that reads that as a violation would force the page to stop saying
 *    the true thing in order to pass a test about it.
 *
 * Arithmetic cannot hide in either: a computed saving needs an identifier. Comments are
 * stripped first, because a comment containing an apostrophe would otherwise look like
 * the start of a string.
 */
function codeOf(modulePath) {
  return fs
    .readFileSync(require.resolve(modulePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");
}

describe('config/taxAdvisory', () => {
  test('boot assertion passes', () => {
    expect(advisory.assertAdvisoryIntegrity()).toBe(true);
  });

  test('every declared transition names a declared status', () => {
    for (const [from, targets] of Object.entries(advisory.TRANSITIONS)) {
      expect(advisory.STATUSES).toContain(from);
      for (const to of targets) expect(advisory.STATUSES).toContain(to);
    }
  });

  test('closed is terminal, and is the only status outside the open reservation', () => {
    expect(advisory.TRANSITIONS.closed).toEqual([]);
    expect(advisory.OPEN_STATUSES).not.toContain('closed');
    for (const status of advisory.STATUSES) {
      if (status !== 'closed') expect(advisory.OPEN_STATUSES).toContain(status);
    }
  });

  test('every status can eventually reach closed', () => {
    // Otherwise an enquiry could be parked in a state that never releases the
    // one-open-enquiry-per-address reservation, and that address could never ask again.
    for (const status of advisory.STATUSES) {
      const seen = new Set();
      const queue = [status];
      let reached = status === 'closed';
      while (queue.length && !reached) {
        const current = queue.shift();
        for (const next of advisory.TRANSITIONS[current] || []) {
          if (next === 'closed') reached = true;
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect(reached).toBe(true);
    }
  });
});

/**
 * THE REFUSAL.
 *
 * `utils/contractorEconomics.js` carries the same test and the same reason: the reference
 * implementation ships a `calculateTaxSavings` that compares a hard-coded 30% against a
 * hard-coded 5% and presents the difference to a user as a saving. Its route version does
 * the same with an admin-editable percentage.
 *
 * A refusal stated only in a comment moves the moment somebody adds a helper "just for the
 * landing page", so it is asserted against the exported surface AND against the source of
 * both modules — otherwise the arithmetic could live in a private function that a template
 * calls through something innocuously named.
 */
describe('nothing here computes tax', () => {
  const FORBIDDEN = /tax(rate|savings?|burden|due|owed)|savings?(minor|amount|monthly|annual)?|nettakehome|effectiverate|takehome|grossup|deduction/i;

  test('the config exports nothing tax- or saving-shaped', () => {
    for (const key of Object.keys(advisory)) {
      // `taxAdvisory` and `TaxEnquiry` name the SUBJECT of an enquiry, not a calculation;
      // the pattern above deliberately does not match a bare "tax".
      expect(key).not.toMatch(FORBIDDEN);
    }
  });

  test('the model exports nothing tax- or saving-shaped', () => {
    const surface = [
      ...Object.keys(TaxEnquiry),
      ...Object.getOwnPropertyNames(TaxEnquiry).filter((n) => typeof TaxEnquiry[n] === 'function')
    ];
    for (const key of surface) expect(key).not.toMatch(FORBIDDEN);
  });

  test('no module in the feature contains arithmetic on a monetary field', () => {
    for (const modulePath of ['../../config/taxAdvisory', '../../models/TaxEnquiry', '../../routes/tax']) {
      const code = codeOf(modulePath);
      expect(code).not.toMatch(/gross|net_?monthly|salary|percentRate|fixedFee|monthlySavings|annualSavings/i);
      // The reference stores `estimated_monthly_savings` POSTED BACK FROM THE BROWSER.
      expect(code).not.toMatch(/estimated_?(monthly|annual)/i);
    }
  });

  test('the route does not expose a calculate endpoint', () => {
    const code = codeOf('../../routes/tax');
    expect(code).not.toMatch(/calculate/i);
  });
});

describe('TaxEnquiry.normaliseSubmission', () => {
  const valid = {
    fullName: '  Arta   Krasniqi ',
    email: '  Arta@Example.COM ',
    phone: ' +383 44 000 000 ',
    country: 'al',
    topic: 'cross_border',
    arrangement: 'freelance',
    question: 'I work for clients in Germany and Ireland and I am not sure how I should be set up.',
    consent: true,
    consentVersion: '2026-09-01'
  };

  test('accepts a complete submission and normalises it', () => {
    const out = TaxEnquiry.normaliseSubmission(valid);
    expect(out.fullName).toBe('Arta Krasniqi');
    expect(out.email).toBe('arta@example.com');
    expect(out.country).toBe('AL');
    expect(out.phone).toBe('+383 44 000 000');
  });

  test('refuses a missing consent rather than defaulting it', () => {
    // An unticked checkbox posts NOTHING, so absence has to mean refusal. Defaulting it
    // is the same class of bug as a settings loop that iterates the submitted body.
    expect(() => TaxEnquiry.normaliseSubmission({ ...valid, consent: false })).toThrow(/agreement/i);
    const { consent, ...withoutConsent } = valid;
    expect(consent).toBe(true);
    expect(() => TaxEnquiry.normaliseSubmission(withoutConsent)).toThrow(/agreement/i);
  });

  test('refuses an unknown topic or arrangement instead of storing it', () => {
    expect(() => TaxEnquiry.normaliseSubmission({ ...valid, topic: 'evasion' })).toThrow(/ask about/i);
    expect(() => TaxEnquiry.normaliseSubmission({ ...valid, arrangement: 'whatever' })).toThrow(/how you work/i);
  });

  test('refuses an address it could not reply to', () => {
    for (const email of ['', 'nope', 'a@b', 'a b@example.com']) {
      expect(() => TaxEnquiry.normaliseSubmission({ ...valid, email })).toThrow(/email/i);
    }
  });

  test('refuses a country that is not two letters', () => {
    for (const country of ['', 'A', 'ALB', '12']) {
      expect(() => TaxEnquiry.normaliseSubmission({ ...valid, country })).toThrow(/tax-resident/i);
    }
  });

  test('refuses a question too short to route', () => {
    expect(() => TaxEnquiry.normaliseSubmission({ ...valid, question: 'help' })).toThrow(/at least/i);
  });

  test('truncates rather than throwing on over-long input', () => {
    // A crafted POST is not bound by the form's maxlength, and a 2MB question is a row
    // nobody can read rather than an attack — so it is cut, not refused.
    const out = TaxEnquiry.normaliseSubmission({ ...valid, question: 'x'.repeat(50_000) });
    expect(out.question).toHaveLength(advisory.LIMITS.question);
  });

  test('ignores anything the reference would have collected', () => {
    const out = TaxEnquiry.normaliseSubmission({
      ...valid,
      currentGrossMonthly: 6000,
      currentNetMonthly: 3400,
      currentEmployer: 'Some GmbH',
      noticePeriod: '3 months',
      estimatedMonthlySavings: 2000
    });
    expect(Object.keys(out).sort()).toEqual(
      ['arrangement', 'consentVersion', 'country', 'email', 'fullName', 'phone', 'question', 'topic'].sort()
    );
  });
});

describe('TaxEnquiry.buildFilter', () => {
  test('is parameterised — no value reaches the clause', () => {
    const { clause, params } = TaxEnquiry.buildFilter({
      status: 'new',
      country: "al' OR 1=1 --",
      topic: 'relocation',
      q: "o'brien"
    });
    expect(clause).not.toMatch(/o'brien|1=1/);
    expect(params).toContain("%o'brien%");
    expect(params).toContain("AL");
  });

  test('escapes LIKE metacharacters in the search term', () => {
    const { params } = TaxEnquiry.buildFilter({ q: '50%' });
    // Unescaped, `%50%%` means "50 followed by anything" — see utils/likePattern.js.
    expect(params[0]).toBe('%50\\%%');
  });

  test('an unknown status is ignored rather than matched literally', () => {
    const { clause, params } = TaxEnquiry.buildFilter({ status: 'deleted' });
    expect(clause).toBe('1 = 1');
    expect(params).toEqual([]);
  });

  test('open_only expands to the declared open statuses', () => {
    const { clause, params } = TaxEnquiry.buildFilter({ open_only: true });
    expect(params).toEqual([...advisory.OPEN_STATUSES]);
    expect(clause).toContain('e.status IN');
  });

  test('an explicit status wins over open_only', () => {
    const { params } = TaxEnquiry.buildFilter({ open_only: true, status: 'closed' });
    expect(params).toEqual(['closed']);
  });
});
