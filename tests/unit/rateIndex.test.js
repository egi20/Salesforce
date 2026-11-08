'use strict';

const fs = require('fs');
const path = require('path');

const model = require('../../config/rateModel');
const { ROLE_SLUGS } = require('../../config/roleTaxonomy');
const { inputsFrom, benchmark, benchmarkProblems, confidenceFor, positionBar } = require('../../utils/rateBenchmark');
const { project } = require('../../utils/contractorEconomics');
const { windowTrend, recentWeeks, recentDays, weekStart, meanOfPeople } = require('../../utils/rateAggregation');
const { trendGeometry } = require('../../utils/rateCharts');
const { contractBudgets, permanentSalaries } = require('../../utils/jobRates');

const identity = (amount) => amount;

describe('config/rateModel', () => {
  test('the boot assertion passes', () => {
    expect(model.assertRateModel()).toBe(true);
  });

  test('experience brackets are the seniority bands, not a second set', () => {
    expect(model.EXPERIENCE.map((e) => e.label)).toEqual(['0–2 years', '3–5 years', '6–9 years', '10+ years']);
  });

  test('every EU country is in exactly one region', () => {
    expect(model.rateModelProblems()).toEqual([]);
  });
});

describe('utils/rateBenchmark — the editorial model', () => {
  const base = { b_role: 'cpq-consultant', b_exp: 'senior', b_region: 'western-europe', b_certs: '3', b_skills: '2', b_mode: 'hybrid', b_industry: 'financial-services', b_contract: 'time-materials' };

  test('works the example through to the euro', () => {
    const b = benchmark(inputsFrom(base));
    // 800 × 1.0 × 1.0 × (1 + 4.5% + 2% + 3% + 10%) = 956 → €955; ∓15% → 812/1098 → €810/€1,100.
    expect([b.min, b.recommended, b.max]).toEqual([810, 955, 1100]);
    expect(b.steps.adjustmentBps).toBe(1950);
  });

  test('every role, experience and region passes its own check', () => {
    for (const role of ROLE_SLUGS) {
      for (const e of model.EXPERIENCE) {
        for (const r of model.REGIONS) {
          const b = benchmark(inputsFrom({ ...base, b_role: role, b_exp: e.value, b_region: r.value }));
          expect(benchmarkProblems(b)).toEqual([]);
        }
      }
    }
  });

  test('the year comes from the contract rate calculator, not rate × 220', () => {
    const b = benchmark(inputsFrom(base));
    const year = project({ dayRate: b.recommended });
    expect(b.year.annual).toBe(year.money.revenue);
    expect(b.year.billableDays).toBe(year.days.billable);
    expect(b.year.equivalentSalary).toBe(year.money.netBeforeTax);
    expect(b.year.annual).not.toBe(b.recommended * 220);
  });

  test('no role means no benchmark; unknown options fall back to neutral', () => {
    expect(inputsFrom({})).toBeNull();
    expect(inputsFrom({ b_role: '__proto__' })).toBeNull();
    const i = inputsFrom({ b_role: ROLE_SLUGS[0], b_region: '__proto__', b_industry: 'toString', b_certs: '99', b_skills: '-3' });
    expect(i).toMatchObject({ region: 'western-europe', industry: 'general', certifications: model.CERTIFICATIONS.max, skills: 0 });
  });

  test('confidence follows how many people stand behind the comparison', () => {
    expect(confidenceFor(0)).toBe('Low');
    expect(confidenceFor(2)).toBe('Low');
    expect(confidenceFor(3)).toBe('Medium');
    expect(confidenceFor(10)).toBe('High');
  });

  test('no position bar against a bucket below the floor', () => {
    expect(positionBar(900, { suppressed: true, median: null })).toBeNull();
    const bar = positionBar(900, { suppressed: false, p25: 700, median: 800, p75: 950 });
    expect(bar.p25).toBeLessThan(bar.median);
    expect(bar.median).toBeLessThan(bar.p75);
    expect(bar.you).toBeGreaterThan(bar.median);
  });

  test('none of the Dynamics Hub calculator figures are copied', () => {
    // DH's adjustments were tuned for Dynamics 365 work: finance +15%, pharma +12%, energy
    // +10%; fixed price +5%, retainer −5%, staff augmentation −3%. Ours are decided, not copied.
    const bps = (list, value) => list.find((i) => i.value === value).bps;
    expect(bps(model.INDUSTRIES, 'financial-services')).not.toBe(1500);
    expect(bps(model.INDUSTRIES, 'life-sciences')).not.toBe(1200);
    expect(bps(model.INDUSTRIES, 'energy')).not.toBe(1000);
    expect(bps(model.CONTRACT_TYPES, 'fixed-price')).not.toBe(500);
    expect(bps(model.CONTRACT_TYPES, 'retainer')).not.toBe(-500);
    expect(bps(model.CONTRACT_TYPES, 'staff-augmentation')).not.toBe(-300);
  });
});

describe('trend windows keep gaps as gaps', () => {
  const from = new Date('2026-11-08T12:00:00Z');

  test('weeks start on Monday and count back', () => {
    expect(weekStart(new Date('2026-11-08T12:00:00Z'))).toBe('2026-11-02');
    expect(recentWeeks(3, from)).toEqual(['2026-10-19', '2026-10-26', '2026-11-02']);
    expect(recentDays(2, from)).toEqual(['2026-11-07', '2026-11-08']);
  });

  test('a day with fewer than three people is a gap with its count kept', () => {
    const rows = [
      { user_id: 1, amount_eur: 700, updated_at: new Date('2026-11-08T09:00:00Z') },
      { user_id: 2, amount_eur: 800, updated_at: new Date('2026-11-08T10:00:00Z') },
      { user_id: 3, amount_eur: 900, updated_at: new Date('2026-11-08T11:00:00Z') },
      { user_id: 4, amount_eur: 600, updated_at: new Date('2026-11-07T11:00:00Z') }
    ];
    const series = windowTrend(rows, '30d', from);
    expect(series).toHaveLength(30);
    expect(series[29]).toMatchObject({ value: 800, contributors: 3, suppressed: false });
    expect(series[28]).toMatchObject({ value: null, contributors: 1, suppressed: true });
  });

  test('the chart breaks its line at a gap and never draws it at zero', () => {
    const g = trendGeometry([
      { period: 'a', value: 700, contributors: 3 },
      { period: 'b', value: 720, contributors: 4 },
      { period: 'c', value: null, contributors: 1 },
      { period: 'd', value: 750, contributors: 5 }
    ]);
    expect(g.segments).toHaveLength(2);
    expect(g.segments[0]).toHaveLength(2);
    expect(g.segments[1]).toHaveLength(1);
    expect(g.bars[2]).toMatchObject({ gap: true, contributors: 1 });
    for (const seg of g.segments) for (const p of seg) expect(p.y).toBeLessThan(g.plot.y + g.plot.height);
  });
});

describe('asked on applications', () => {
  test('one figure per PERSON, and nothing below the floor', () => {
    const rows = [
      { user_id: 1, amount_eur: 600 }, { user_id: 1, amount_eur: 600 }, { user_id: 1, amount_eur: 600 },
      { user_id: 2, amount_eur: 900 }
    ];
    expect(meanOfPeople(rows)).toEqual({ people: 2, suppressed: true, mean: null });
    expect(meanOfPeople([...rows, { user_id: 3, amount_eur: 750 }])).toEqual({ people: 3, suppressed: false, mean: 750 });
  });
});

describe('job postings', () => {
  test('contract budgets: medians of each end, one end standing in for both', () => {
    const rows = [
      { role: 'admin', engagement_type: 'contract', rate_min: 400, rate_max: 600, currency: 'EUR' },
      { role: 'admin', engagement_type: 'contract', rate_min: 500, rate_max: null, currency: 'EUR' },
      { role: 'admin', engagement_type: 'permanent', rate_min: 60000, rate_max: 80000, currency: 'EUR' }
    ];
    expect(contractBudgets(rows, identity)).toEqual([{ role: 'admin', postings: 2, medianMin: 450, medianMax: 550 }]);
  });

  test('salaries: averages, the range, and a per-day figure from the paid days', () => {
    const rows = [
      { role: 'admin', seniority: 'mid', engagement_type: 'permanent', rate_min: 60000, rate_max: 80000, currency: 'EUR' },
      { role: 'admin', seniority: 'senior', engagement_type: 'permanent', rate_min: 80000, rate_max: 100000, currency: 'EUR' }
    ];
    const s = permanentSalaries(rows, identity);
    expect(s).toMatchObject({ postings: 2, avgMin: 70000, avgMax: 90000, rangeMin: 60000, rangeMax: 100000 });
    expect(s.perDayMin).toBe(Math.round(70000 / s.paidDays));
    expect(s.bySeniority.map((r) => r.seniority)).toEqual(['mid', 'senior']);
    expect(permanentSalaries([], identity)).toEqual({ postings: 0 });
  });
});

describe('public/js/rates-page.js', () => {
  test('sends nothing and writes no markup', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'rates-page.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/fetch\(|XMLHttpRequest|innerHTML|localStorage/);
  });
});
