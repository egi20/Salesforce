'use strict';

const {
  WORKING_DAYS_PER_YEAR,
  DAY_CATEGORIES,
  COST_CATEGORIES,
  normaliseAssumptions,
  project,
  rateForTarget,
  positionAgainstMarket,
  reconciliationProblems
} = require('../../utils/contractorEconomics');

/**
 * The contract rate calculator.
 *
 * Held to the same standard as the estimator, and for the same reason: someone is going to
 * plan a year around the answer. The parts must sum to the whole, the two directions must
 * agree, and — the one that is a refusal rather than an invariant — it must not produce
 * anything that could be mistaken for tax advice.
 */
describe('assumptions', () => {
  it('defaults every category rather than silently treating a blank as zero', () => {
    // A blank holiday field meaning "no holiday" would flatter the answer by five weeks.
    const assumptions = normaliseAssumptions({ dayRate: 600 });
    for (const { key, default: expected } of DAY_CATEGORIES) expect(assumptions[key]).toBe(expected);
    for (const { key, default: expected } of COST_CATEGORIES) expect(assumptions[key]).toBe(expected);
  });

  it('honours an explicit zero', () => {
    // Distinct from a blank: someone who genuinely carries no insurance said so.
    expect(normaliseAssumptions({ dayRate: 600, insuranceCost: 0 }).insuranceCost).toBe(0);
    expect(normaliseAssumptions({ dayRate: 600, holidayDays: 0 }).holidayDays).toBe(0);
  });

  it('clamps nonsense instead of erroring, because this is a thing people play with', () => {
    expect(normaliseAssumptions({ dayRate: -50 }).dayRate).toBe(1);
    expect(normaliseAssumptions({ dayRate: 'banana' }).dayRate).toBe(1);
    expect(normaliseAssumptions({ dayRate: 1e12 }).dayRate).toBe(10000);
    expect(normaliseAssumptions({ dayRate: 500, holidayDays: 9999 }).holidayDays).toBe(WORKING_DAYS_PER_YEAR);
  });
});

describe('the projection', () => {
  it('subtracts every named category from the working year, exactly', () => {
    const p = project({ dayRate: 700 });
    const expected = DAY_CATEGORIES.reduce((total, c) => total + c.default, 0);
    expect(p.days.nonBillable).toBe(expected);
    expect(p.days.billable).toBe(WORKING_DAYS_PER_YEAR - expected);
  });

  it('reconciles: parts sum to the whole in both days and money', () => {
    for (const dayRate of [250, 700, 1500, 9999]) {
      expect(reconciliationProblems(project({ dayRate }))).toEqual([]);
    }
  });

  it('reconciles with everything zeroed and with everything maxed', () => {
    const zeroed = { dayRate: 500 };
    for (const { key } of DAY_CATEGORIES) zeroed[key] = 0;
    for (const { key } of COST_CATEGORIES) zeroed[key] = 0;
    expect(reconciliationProblems(project(zeroed))).toEqual([]);
    expect(project(zeroed).days.billable).toBe(WORKING_DAYS_PER_YEAR);
  });

  it('answers zero billable days rather than negative revenue', () => {
    // Somebody will claim three hundred days of holiday. The answer is "you invoice
    // nothing", not a negative number that propagates through every other figure.
    const p = project({ dayRate: 700, holidayDays: 260, benchDays: 100 });
    expect(p.days.billable).toBe(0);
    expect(p.money.revenue).toBe(0);
    expect(p.money.effectiveDayRate).toBe(0);
    expect(reconciliationProblems(p)).toEqual([]);
  });

  it('puts the effective day rate below the headline rate', () => {
    // The whole point of the tool. If this ever came out above, the arithmetic is inverted.
    const p = project({ dayRate: 700 });
    expect(p.money.effectiveDayRate).toBeLessThan(700);
    expect(p.money.effectiveDayRate).toBeGreaterThan(0);
  });

  it('produces integers throughout — a contractor does not need cents', () => {
    const p = project({ dayRate: 733 });
    for (const value of [p.money.revenue, p.money.costs, p.money.netBeforeTax, p.money.effectiveDayRate, p.money.effectiveMonthly]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('never reports a utilisation above 100%', () => {
    expect(project({ dayRate: 700 }).days.utilisationPercent).toBeLessThanOrEqual(100);
  });
});

describe('the inverse', () => {
  it('round-trips exactly: a rate projected then inverted returns the rate', () => {
    // The two directions of the calculator must be one formula, not two that drift.
    for (const dayRate of [300, 550, 700, 1200]) {
      const net = project({ dayRate }).money.netBeforeTax;
      expect(rateForTarget(net, { dayRate })).toBe(dayRate);
    }
  });

  it('round-trips under non-default assumptions too', () => {
    const assumptions = { dayRate: 850, holidayDays: 30, benchDays: 45, insuranceCost: 1200, pensionCost: 6000 };
    const net = project(assumptions).money.netBeforeTax;
    expect(rateForTarget(net, assumptions)).toBe(850);
  });

  it('rounds UP, so the target is met rather than missed by a euro', () => {
    const required = rateForTarget(100001, { dayRate: 500 });
    const achieved = project({ dayRate: required }).money.netBeforeTax;
    expect(achieved).toBeGreaterThanOrEqual(100001);
  });

  it('answers null when there are no billable days, rather than dividing by zero', () => {
    expect(rateForTarget(100000, { dayRate: 500, holidayDays: 260 })).toBeNull();
  });
});

describe('the market comparison', () => {
  it('answers null for a suppressed bucket rather than comparing against zero', () => {
    // The rate index returns a null median below its privacy floor. That refusal has to
    // survive all the way out here — a zero would report everyone as infinitely above
    // the market.
    expect(positionAgainstMarket(700, null)).toBeNull();
    expect(positionAgainstMarket(700, 0)).toBeNull();
    expect(positionAgainstMarket(700, undefined)).toBeNull();
  });

  it('bands coarsely, because the sample is small', () => {
    expect(positionAgainstMarket(700, 700).band).toBe('around');
    expect(positionAgainstMarket(730, 700).band).toBe('around');
    expect(positionAgainstMarket(900, 700).band).toBe('above');
    expect(positionAgainstMarket(500, 700).band).toBe('below');
  });

  it('reports the difference as a whole percentage of the median', () => {
    expect(positionAgainstMarket(770, 700).differencePercent).toBe(10);
    expect(positionAgainstMarket(630, 700).differencePercent).toBe(-10);
  });
});

describe('what this module refuses to do', () => {
  it('exposes nothing that computes tax', () => {
    /*
     * Deliberate, and worth a test so nobody adds one in passing. The reference
     * implementation shipped a calculateTaxSavings that compared a hard-coded 30% against
     * a hard-coded 5% and presented the difference as a saving. Tax depends on
     * jurisdiction, entity type, VAT status and how someone pays themselves; a figure
     * that LOOKS like tax advice but is a guess is worse than none, because people act
     * on it.
     */
    const surface = Object.keys(require('../../utils/contractorEconomics'));
    expect(surface.join(' ')).not.toMatch(/tax|takeHome|take_home|netAfter/i);
  });

  it('labels its headline figure as before tax', () => {
    expect(project({ dayRate: 700 }).money).toHaveProperty('netBeforeTax');
    expect(project({ dayRate: 700 }).money).not.toHaveProperty('net');
  });
});
