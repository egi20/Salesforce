'use strict';

const {
  FORBIDDEN_TERMS,
  numbersIn,
  permittedNumbers,
  unsupportedNumbers,
  problemsWith
} = require('../../utils/draftVerification');
const { calculateEstimation } = require('../../utils/sowEstimation');
const { SECTIONS, assertDraftingIntegrity } = require('../../config/drafting');

/**
 * The check that makes AI drafting defensible.
 *
 * A quote is a statement made to a client on a date, and `utils/sowEstimation.js` goes to
 * some length to make its parts reconcile exactly. A generated paragraph saying "roughly
 * forty days of build" next to a table saying twenty-three undoes all of it, and the
 * client is the one who finds the discrepancy. So: the narrative may not contain a numeral
 * the estimate does not contain, and a draft that fails is never stored or shown.
 */
const ESTIMATE = calculateEstimation({
  modules: ['lead-management', 'opportunity-management'],
  complexity: 'standard',
  customization: 'moderate',
  industry: 'Technology',
  companySize: 'Medium (51-500)',
  isvSolutions: [],
  includeTraining: true,
  includeHypercare: true
});

/** Enough words to clear the length floor without saying anything numeric. */
const FILLER = 'We will work through the phases described above with your team. '.repeat(8);

describe('extracting figures from prose', () => {
  it('finds plain numerals', () => {
    expect(numbersIn('It takes 23 days.')).toEqual([23]);
  });

  it('normalises thousands separators, so 63,800 is the same figure as 63800', () => {
    expect(numbersIn('The budget is 63,800 EUR.')).toEqual([63800]);
    expect(numbersIn('The budget is 63800 EUR.')).toEqual([63800]);
  });

  it('normalises a trailing decimal, so 1,100.00 matches a rate of 1100', () => {
    expect(numbersIn('at 1,100.00 a day')).toEqual([1100]);
  });

  it('separates figures in a list rather than joining them', () => {
    // "2, 3" is two numbers. Joining them into 23 would let a fabricated figure through
    // by accident, which is the worst possible way to pass.
    expect(numbersIn('phases 2, 3 and 4')).toEqual([2, 3, 4]);
  });

  it('finds numerals attached to words and punctuation', () => {
    expect(numbersIn('a 20% contingency').includes(20)).toBe(true);
    expect(numbersIn('week 1.').includes(1)).toBe(true);
    expect(numbersIn('the 3rd phase').includes(3)).toBe(true);
  });

  it('finds nothing in prose that has no numerals', () => {
    expect(numbersIn('Twenty-three days across eight weeks.')).toEqual([]);
    expect(numbersIn('')).toEqual([]);
    expect(numbersIn(null)).toEqual([]);
  });
});

describe('the permitted set', () => {
  it('contains the figures the estimate actually states', () => {
    const allowed = permittedNumbers(ESTIMATE);
    expect(allowed.has(ESTIMATE.totalManDays)).toBe(true);
    expect(allowed.has(ESTIMATE.totalBudget)).toBe(true);
    expect(allowed.has(ESTIMATE.projectDurationWeeks)).toBe(true);
    expect(allowed.has(ESTIMATE.averageDailyRate)).toBe(true);
  });

  it('contains every phase, resource and timeline figure', () => {
    const allowed = permittedNumbers(ESTIMATE);
    for (const phase of ESTIMATE.phaseBreakdown) {
      expect(allowed.has(phase.days)).toBe(true);
      expect(allowed.has(phase.percentage)).toBe(true);
    }
    for (const resource of ESTIMATE.resourceAllocation) {
      expect(allowed.has(resource.dailyRate)).toBe(true);
      expect(allowed.has(resource.totalCost)).toBe(true);
    }
  });

  it('is empty rather than throwing for a missing estimate', () => {
    expect(permittedNumbers(null).size).toBe(0);
    expect(permittedNumbers(undefined).size).toBe(0);
    expect(permittedNumbers('not an estimate').size).toBe(0);
  });
});

describe('the numeral rule', () => {
  it('accepts a draft that quotes the estimate correctly', () => {
    const text = `The programme runs to ${ESTIMATE.totalManDays} days of effort across `
      + `${ESTIMATE.projectDurationWeeks} weeks.`;
    expect(unsupportedNumbers(text, ESTIMATE)).toEqual([]);
  });

  it('CATCHES a figure the estimate does not contain', () => {
    // The failure this whole module exists for.
    expect(unsupportedNumbers('We expect roughly 41 days of build.', ESTIMATE)).toEqual([41]);
  });

  it('catches an invented budget', () => {
    expect(unsupportedNumbers('A budget of 95,000 EUR.', ESTIMATE)).toEqual([95000]);
  });

  it('reports each invented figure once, not once per mention', () => {
    expect(unsupportedNumbers('41 days, and again 41 days, plus 42.', ESTIMATE)).toEqual([41, 42]);
  });

  it('permits numerals the model was HANDED in its facts', () => {
    /*
     * Not a loophole — a correction this verifier exposed. Legitimate names carry digits:
     * "B2B Commerce", "Five9", "Bulk API 2.0". A narrative naming a product in scope was
     * flagged for inventing the figure 2. The model may repeat a numeral it was given; it
     * cannot repeat a day count, because the facts never contain one.
     */
    const facts = 'Scope, as chosen:\n  - B2B Commerce';
    expect(unsupportedNumbers('We will deliver B2B Commerce.', ESTIMATE, facts)).toEqual([]);
    // And the guard still holds for everything else.
    expect(unsupportedNumbers('B2B Commerce in 41 days.', ESTIMATE, facts)).toEqual([41]);
  });
});

describe('the whole check', () => {
  it('passes a well-behaved draft', () => {
    expect(problemsWith(FILLER, ESTIMATE)).toEqual([]);
  });

  it('rejects an empty draft', () => {
    expect(problemsWith('', ESTIMATE)).toEqual(['the draft is empty']);
    expect(problemsWith('   ', ESTIMATE)).toEqual(['the draft is empty']);
  });

  it('rejects a draft that is too short to be worth reading', () => {
    expect(problemsWith('Short.', ESTIMATE).join(' ')).toMatch(/too short/);
  });

  it('rejects a draft that ran away', () => {
    const long = 'word '.repeat(500);
    expect(problemsWith(long, ESTIMATE, { maxWords: 400 }).join(' ')).toMatch(/too long/);
  });

  it('rejects placeholder text the model did not fill in', () => {
    for (const placeholder of ['[insert client name]', '{{client}}', 'TBD', 'TBC', 'XXXX', 'TODO', '<insert name>']) {
      const problems = problemsWith(`${FILLER} ${placeholder}`, ESTIMATE, { maxWords: 500 });
      expect(problems.join(' ')).toMatch(/placeholder/);
    }
  });

  it('rejects a commitment the document cannot make', () => {
    // A generated paragraph must not agree terms on somebody's behalf.
    for (const term of ['we guarantee delivery', 'a warranty applies', 'we will indemnify you', 'a fixed price']) {
      const problems = problemsWith(`${FILLER} ${term}.`, ESTIMATE, { maxWords: 500 });
      expect(problems.join(' ')).toMatch(/commitment/);
    }
  });

  it('names every problem at once rather than stopping at the first', () => {
    // The author sees what the model did, all of it.
    const problems = problemsWith('We guarantee 41 days. [insert]', ESTIMATE);
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.join(' ')).toMatch(/41/);
    expect(problems.join(' ')).toMatch(/placeholder/);
    expect(problems.join(' ')).toMatch(/guarantee/);
  });

  it('lists the forbidden terms rather than hiding them in a regex', () => {
    // They are exported so the accept path can apply the same rule to an author's edit.
    expect(FORBIDDEN_TERMS).toContain('guarantee');
    expect(FORBIDDEN_TERMS).toContain('indemnif');
  });
});

describe('the drafting catalogue', () => {
  it('starts only if every section states what it must NOT write', () => {
    expect(assertDraftingIntegrity()).toBe(true);
    for (const section of Object.values(SECTIONS)) {
      expect(section.neverWrites.length).toBeGreaterThan(0);
      expect(section.minWords).toBeLessThan(section.maxWords);
    }
  });

  it('drafts only prose sections — never scope, effort, rates or price', () => {
    /*
     * Stated as a test so the boundary survives someone adding a section in a hurry. The
     * figures come from utils/sowEstimation.js and stay there; there is no path from a
     * model response to quotes.estimate.
     */
    const keys = Object.keys(SECTIONS).join(' ');
    expect(keys).not.toMatch(/scope|effort|rate|price|cost|budget|timeline/);
  });
});
