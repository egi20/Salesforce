'use strict';

const { aggregate, aggregateBy, trendSeries, recentPeriods, percentile } = require('../../utils/rateAggregation');

const row = (userId, amount, period = '2026-01') => ({ user_id: userId, amount_eur: amount, period });

describe('rate aggregation privacy floor', () => {
  it('suppresses a bucket below the floor but keeps the contributor count', () => {
    const result = aggregate([row(1, 600), row(2, 800)], 3);
    expect(result.suppressed).toBe(true);
    expect(result.contributors).toBe(2);
    expect(result.median).toBeNull();
    expect(result.p25).toBeNull();
    expect(result.max).toBeNull();
  });

  it('counts people, not submissions', () => {
    // One person submitting five times is a sample of one, and must stay suppressed.
    const result = aggregate([row(9, 700), row(9, 800), row(9, 900), row(9, 650), row(9, 750)], 3);
    expect(result.contributors).toBe(1);
    expect(result.suppressed).toBe(true);
  });

  it('uses a person median so one outlier submission cannot move the bucket', () => {
    const rows = [row(1, 600), row(1, 10000), row(1, 620), row(2, 700), row(3, 800)];
    const result = aggregate(rows, 3);
    expect(result.contributors).toBe(3);
    // Person 1 contributes 620 (their median), not 10000.
    expect(result.median).toBe(700);
    expect(result.max).toBe(800);
  });

  it('publishes once the floor is met', () => {
    const result = aggregate([row(1, 600), row(2, 700), row(3, 800), row(4, 900)], 3);
    expect(result.suppressed).toBe(false);
    expect(result.contributors).toBe(4);
    expect(result.median).toBe(750);
    expect(result.min).toBe(600);
    expect(result.max).toBe(900);
  });

  it('ignores rows with an unusable amount', () => {
    const result = aggregate([row(1, 0), row(2, -5), row(3, null), row(4, 'x'), row(5, 700)], 1);
    expect(result.contributors).toBe(1);
    expect(result.median).toBe(700);
  });

  it('reports zero contributors for an empty or missing set', () => {
    expect(aggregate([], 3).contributors).toBe(0);
    expect(aggregate(null, 3).suppressed).toBe(true);
  });
});

describe('percentile', () => {
  it('uses nearest rank, so it never emits a value nobody submitted', () => {
    const values = [100, 200, 300, 400];
    expect(percentile(values, 0.25)).toBe(100);
    expect(percentile(values, 0.5)).toBe(200);
    expect(percentile(values, 0.75)).toBe(300);
    expect(percentile(values, 1)).toBe(400);
  });
});

describe('aggregateBy', () => {
  it('aggregates each group independently', () => {
    const rows = [
      { user_id: 1, amount_eur: 600, role: 'apex-developer' },
      { user_id: 2, amount_eur: 700, role: 'apex-developer' },
      { user_id: 3, amount_eur: 800, role: 'apex-developer' },
      { user_id: 4, amount_eur: 900, role: 'sales-cloud' }
    ];
    const grouped = aggregateBy(rows, (r) => r.role, 3);
    expect(grouped.get('apex-developer').suppressed).toBe(false);
    expect(grouped.get('sales-cloud').suppressed).toBe(true);
    expect(grouped.get('sales-cloud').contributors).toBe(1);
  });
});

describe('trendSeries', () => {
  it('renders a suppressed period as a gap, never as a zero', () => {
    const rows = [
      row(1, 600, '2026-01'), row(2, 700, '2026-01'), row(3, 800, '2026-01'),
      row(4, 900, '2026-02')
    ];
    const series = trendSeries(rows, ['2025-12', '2026-01', '2026-02'], 3);

    expect(series[0]).toMatchObject({ period: '2025-12', value: null, contributors: 0, suppressed: true });
    expect(series[1]).toMatchObject({ period: '2026-01', value: 700, suppressed: false });
    expect(series[2]).toMatchObject({ period: '2026-02', value: null, contributors: 1, suppressed: true });

    // No point is ever 0: a zero would be drawn as a real datum.
    expect(series.every((p) => p.value === null || p.value > 0)).toBe(true);
  });
});

describe('recentPeriods', () => {
  it('returns YYYY-MM oldest first, ending with the given month', () => {
    expect(recentPeriods(4, new Date('2026-01-15T00:00:00Z'))).toEqual(['2025-10', '2025-11', '2025-12', '2026-01']);
  });

  it('crosses a year boundary correctly', () => {
    expect(recentPeriods(2, new Date('2026-03-31T23:59:59Z'))).toEqual(['2026-02', '2026-03']);
  });
});
