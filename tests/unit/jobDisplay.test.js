'use strict';

const { formatRateRange, jobLocation, postedAgo, companyInitials, companyTone } = require('../../utils/jobDisplay');

describe('job card formatting', () => {
  const contract = { rate_visible: 1, rate_min: '646.00', rate_max: '950.00', currency: 'EUR', engagement_type: 'contract' };
  const permanent = { rate_visible: 1, rate_min: '90000.00', rate_max: '132000.00', currency: 'EUR', engagement_type: 'permanent' };

  test('a day rate reads in units, a salary in thousands — decided by the engagement, not the size', () => {
    expect(formatRateRange(contract)).toBe('€646–950 / day');
    expect(formatRateRange(permanent)).toBe('€90k–132k / yr');
    // A large DAY rate stays a day rate.
    expect(formatRateRange({ ...contract, rate_min: 1500, rate_max: 2000 })).toBe('€1,500–2,000 / day');
  });

  test('a hidden or absent rate prints nothing', () => {
    expect(formatRateRange({ ...contract, rate_visible: 0 })).toBeNull();
    expect(formatRateRange({ ...contract, rate_min: null, rate_max: null })).toBeNull();
  });

  test('one-sided ranges say which side', () => {
    expect(formatRateRange({ ...contract, rate_max: null })).toBe('From €646 / day');
    expect(formatRateRange({ ...contract, rate_min: null })).toBe('Up to €950 / day');
    expect(formatRateRange({ ...permanent, rate_min: 92500, rate_max: null })).toBe('From €92.5k / yr');
  });

  test('the country is written out, and a remote role says so', () => {
    expect(jobLocation({ city: 'London', country: 'GB', work_mode: 'onsite' })).toBe('London, United Kingdom');
    expect(jobLocation({ city: null, country: 'ES', work_mode: 'remote' })).toBe('Remote · Spain');
    expect(jobLocation({ city: null, country: null, work_mode: 'remote' })).toBe('Remote');
  });

  test('posted dates are relative, from the render time', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(postedAgo('2026-11-10T08:00:00Z', now)).toBe('Posted today');
    expect(postedAgo('2026-11-09T08:00:00Z', now)).toBe('Posted yesterday');
    expect(postedAgo('2026-11-03T12:00:00Z', now)).toBe('Posted 7 days ago');
    expect(postedAgo('2026-10-20T12:00:00Z', now)).toBe('Posted 3 weeks ago');
    expect(postedAgo(null, now)).toBeNull();
  });

  test('a company with no logo gets stable initials and a tone', () => {
    expect(companyInitials('Northwind Cloud Partners')).toBe('NC');
    expect(companyInitials('')).toBe('?');
    expect(companyTone('Northwind')).toBe(companyTone('Northwind'));
    expect(companyTone('Northwind')).toMatch(/^tone-[1-6]$/);
  });
});
