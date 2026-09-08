'use strict';

const {
  apportionDays,
  overrideConfigMap,
  computeProjectDurationWeeks,
  countFreeTextItems,
  calculateEstimation,
  reconciliationProblems
} = require('../../utils/sowEstimation');
const { estimationProblems, PHASE_DISTRIBUTION, DEFAULT_RESOURCE_ALLOCATION } = require('../../config/estimation');

const BASE_INPUT = {
  selectedFamilies: ['sales-cloud'],
  selectedModules: ['lead-management', 'opportunity-management'],
  complexity: 'moderate',
  numberOfUsers: 50,
  numberOfOrgs: 1
};

describe('estimation configuration', () => {
  it('is internally consistent, so boot will not throw', () => {
    expect(estimationProblems()).toEqual([]);
  });

  it('has phase percentages summing to exactly 100', () => {
    const total = Object.values(PHASE_DISTRIBUTION).reduce((s, p) => s + p.percentage, 0);
    expect(total).toBe(100);
  });

  it('has resource percentages summing to exactly 100', () => {
    const total = Object.values(DEFAULT_RESOURCE_ALLOCATION).reduce((s, r) => s + r.percentage, 0);
    expect(total).toBe(100);
  });
});

describe('apportionDays', () => {
  it('distributes exactly, with no rounding drift', () => {
    const parts = apportionDays(100, [33, 33, 34]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('sums exactly for awkward totals that naive rounding would break', () => {
    // Independent Math.round(total * pct/100) calls drift here; Hamilton does not.
    for (const total of [7, 13, 101, 337, 1049, 9973]) {
      const parts = apportionDays(total, [10, 15, 35, 15, 10, 8, 5, 2]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('gives leftovers to the largest fractional parts', () => {
    // 10 across [1,1,1]: 3.33 each -> floors to 3,3,3 with 1 left over, to the first.
    expect(apportionDays(10, [1, 1, 1])).toEqual([4, 3, 3]);
  });

  it('is deterministic when fractions tie', () => {
    expect(apportionDays(10, [1, 1, 1])).toEqual(apportionDays(10, [1, 1, 1]));
  });

  it('treats zero and negative weights as no share', () => {
    expect(apportionDays(10, [1, 0, -5])).toEqual([10, 0, 0]);
  });

  it('returns all zeroes when there is nothing to distribute', () => {
    expect(apportionDays(0, [1, 2])).toEqual([0, 0]);
    expect(apportionDays(100, [0, 0])).toEqual([0, 0]);
    expect(apportionDays(-5, [1, 1])).toEqual([0, 0]);
  });
});

describe('computeProjectDurationWeeks', () => {
  it('sums sequential phases rather than dividing the whole project by one team', () => {
    // 400 days over 4 people at 5 days a week is 20 weeks if fully parallel. Phases run
    // sequentially, so the real span is longer.
    const phases = [40, 60, 140, 60, 40, 32, 20, 8];
    const naive = Math.ceil(400 / 4 / 5);
    expect(computeProjectDurationWeeks(phases)).toBeGreaterThan(naive);
  });

  it('gives every active phase at least a week', () => {
    expect(computeProjectDurationWeeks([1, 1, 1])).toBe(3);
  });

  it('excludes zero-day phases entirely', () => {
    expect(computeProjectDurationWeeks([20, 0, 0])).toBe(computeProjectDurationWeeks([20]));
  });

  it('never returns less than one week', () => {
    expect(computeProjectDurationWeeks([])).toBe(1);
    expect(computeProjectDurationWeeks([0, 0])).toBe(1);
  });

  it('guards against a zero or negative team size', () => {
    expect(computeProjectDurationWeeks([100], 0)).toBeGreaterThan(0);
    expect(computeProjectDurationWeeks([100], -3, -1)).toBeGreaterThan(0);
  });
});

describe('overrideConfigMap', () => {
  const defaults = { a: { name: 'A', days: 10 }, b: { name: 'B', days: 20 } };

  it('shallow-merges a partial override and keeps untouched keys', () => {
    const merged = overrideConfigMap(defaults, { a: { days: 99 } });
    expect(merged.a).toEqual({ name: 'A', days: 99 });
    expect(merged.b).toEqual({ name: 'B', days: 20 });
  });

  it('ignores a non-object override rather than replacing the table', () => {
    expect(overrideConfigMap(defaults, null)).toBe(defaults);
    expect(overrideConfigMap(defaults, 'nonsense')).toBe(defaults);
    expect(overrideConfigMap(defaults, [1, 2])).toBe(defaults);
  });

  it('does not mutate the defaults', () => {
    overrideConfigMap(defaults, { a: { days: 1 } });
    expect(defaults.a.days).toBe(10);
  });
});

describe('countFreeTextItems', () => {
  it('counts across commas, semicolons and newlines', () => {
    expect(countFreeTextItems('a, b; c\nd')).toBe(4);
  });

  it('ignores empty and whitespace-only input', () => {
    expect(countFreeTextItems('')).toBe(0);
    expect(countFreeTextItems('   ')).toBe(0);
    expect(countFreeTextItems(null)).toBe(0);
    expect(countFreeTextItems(',,, ;;')).toBe(0);
  });
});

describe('calculateEstimation reconciliation', () => {
  it('produces an estimate whose parts all agree', () => {
    expect(reconciliationProblems(calculateEstimation(BASE_INPUT))).toEqual([]);
  });

  it('reconciles across a wide sweep of inputs', () => {
    const complexities = ['simple', 'moderate', 'complex', 'enterprise'];
    const users = [1, 50, 500, 25000];
    const orgs = [1, 3];
    const contingencies = [0, 7, 15, 33];

    for (const complexity of complexities) {
      for (const numberOfUsers of users) {
        for (const numberOfOrgs of orgs) {
          for (const contingencyPercentage of contingencies) {
            const estimate = calculateEstimation(
              { ...BASE_INPUT, complexity, numberOfUsers, numberOfOrgs, numberOfIntegrations: 2 },
              { contingencyPercentage }
            );
            expect(reconciliationProblems(estimate)).toEqual([]);
          }
        }
      }
    }
  });

  it('still reconciles when training and hypercare are excluded', () => {
    const estimate = calculateEstimation({ ...BASE_INPUT, includeTraining: false, includeSupport: false });
    expect(reconciliationProblems(estimate)).toEqual([]);
    expect(estimate.phaseBreakdown.find((p) => p.id === 'training').days).toBe(0);
    expect(estimate.phaseBreakdown.find((p) => p.id === 'support').days).toBe(0);
    expect(estimate.supportBudget).toBe(0);
  });

  it('redistributes an excluded phase into build rather than shrinking the project', () => {
    const withTraining = calculateEstimation(BASE_INPUT);
    const without = calculateEstimation({ ...BASE_INPUT, includeTraining: false });
    expect(without.totalManDays).toBe(withTraining.totalManDays);
    expect(without.phaseBreakdown.find((p) => p.id === 'build').days).toBeGreaterThan(
      withTraining.phaseBreakdown.find((p) => p.id === 'build').days
    );
  });

  it('reconciles with an empty scope, using the minimum base effort', () => {
    const estimate = calculateEstimation({});
    expect(reconciliationProblems(estimate)).toEqual([]);
    expect(estimate.totalManDays).toBeGreaterThan(0);
  });
});

describe('calculateEstimation scope handling', () => {
  it('charges max(family setup, sum of its modules), never both', () => {
    // sales-cloud setup is 12d; lead-management + opportunity-management is 18d.
    const estimate = calculateEstimation({ selectedFamilies: ['sales-cloud'], selectedModules: ['lead-management', 'opportunity-management'] }, { contingencyPercentage: 0 });
    const family = estimate.familyBreakdown.find((f) => f.id === 'sales-cloud');
    expect(family.effectiveDays).toBe(Math.max(family.foundationDays, family.moduleDays));
    expect(family.effectiveDays).toBeLessThan(family.foundationDays + family.moduleDays);
  });

  it('counts a module whose family was not ticked', () => {
    const estimate = calculateEstimation({ selectedModules: ['cpq'] }, { contingencyPercentage: 0 });
    expect(estimate.familyBreakdown.map((f) => f.id)).toContain('revenue-cloud');
  });

  it('costs free-text scope explicitly rather than assuming it is free', () => {
    const withText = calculateEstimation({ ...BASE_INPUT, otherModules: 'legacy pricing, custom approvals' });
    const without = calculateEstimation(BASE_INPUT);
    expect(withText.unmapped.modules).toBe(2);
    expect(withText.unmapped.days).toBeGreaterThan(0);
    expect(withText.totalManDays).toBeGreaterThan(without.totalManDays);
  });

  it('falls back to the "other" allowance for an unknown add-on', () => {
    const estimate = calculateEstimation({ ...BASE_INPUT, selectedIsvs: ['isv-not-a-real-one'] });
    expect(estimate.isvBreakdown[0].days).toBeGreaterThan(0);
    expect(reconciliationProblems(estimate)).toEqual([]);
  });

  it('floors the user multiplier so a tiny pilot is not costed at nothing', () => {
    const tiny = calculateEstimation({ ...BASE_INPUT, numberOfUsers: 1 });
    expect(tiny.multipliers.users.value).toBeGreaterThanOrEqual(0.8);
  });

  it('scales users logarithmically, not linearly', () => {
    const fifty = calculateEstimation({ ...BASE_INPUT, numberOfUsers: 50 });
    const fiveThousand = calculateEstimation({ ...BASE_INPUT, numberOfUsers: 5000 });
    expect(fiveThousand.totalManDays).toBeGreaterThan(fifty.totalManDays);
    expect(fiveThousand.totalManDays).toBeLessThan(fifty.totalManDays * 2);
  });

  it('adds a fifth per additional org', () => {
    const one = calculateEstimation({ ...BASE_INPUT, numberOfOrgs: 1 });
    const three = calculateEstimation({ ...BASE_INPUT, numberOfOrgs: 3 });
    expect(three.multipliers.orgs.value).toBeCloseTo(1.4, 5);
    expect(three.totalManDays).toBeGreaterThan(one.totalManDays);
  });

  it('makes the timeline agree with the headline duration', () => {
    const estimate = calculateEstimation({ ...BASE_INPUT, complexity: 'enterprise', numberOfIntegrations: 4 });
    const timelineWeeks = estimate.timeline.reduce((s, t) => s + t.durationWeeks, 0);
    expect(timelineWeeks).toBe(estimate.projectDurationWeeks);
    expect(estimate.timeline.every((t) => t.milestone && t.milestone.length > 0)).toBe(true);
  });

  it('is deterministic for identical input', () => {
    const a = calculateEstimation(BASE_INPUT);
    const b = calculateEstimation(BASE_INPUT);
    expect(a.totalManDays).toBe(b.totalManDays);
    expect(a.totalBudget).toBe(b.totalBudget);
    expect(a.phaseBreakdown).toEqual(b.phaseBreakdown);
  });
});

describe('reconciliationProblems', () => {
  it('detects a tampered estimate', () => {
    const estimate = calculateEstimation(BASE_INPUT);
    estimate.phaseBreakdown[0].days += 1;
    expect(reconciliationProblems(estimate).length).toBeGreaterThan(0);
  });
});
