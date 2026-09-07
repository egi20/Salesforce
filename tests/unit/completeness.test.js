'use strict';

const ConsultantProfile = require('../../models/ConsultantProfile');

const FULL = {
  headline: 'Senior CPQ consultant',
  bio: 'Ten years of Revenue Cloud delivery.',
  primary_role: 'cpq-consultant',
  seniority: 'senior',
  country: 'DE',
  day_rate: 800,
  availability: 'immediate',
  profile_picture: '/consultants/photo/1?v=1'
};

describe('profile completeness', () => {
  it('is zero for an empty profile', () => {
    expect(ConsultantProfile.completenessOf({})).toBe(0);
    expect(ConsultantProfile.completenessOf(null)).toBe(0);
  });

  it('reaches 100 for a fully populated profile', () => {
    expect(
      ConsultantProfile.completenessOf(FULL, { skillCount: 5, certificationCount: 2, experienceCount: 3 })
    ).toBe(100);
  });

  it('never exceeds 100', () => {
    expect(
      ConsultantProfile.completenessOf(FULL, { skillCount: 50, certificationCount: 20, experienceCount: 20 })
    ).toBe(100);
  });

  it('does not count "not available" as an answered availability', () => {
    const withAvailability = ConsultantProfile.completenessOf(FULL);
    const without = ConsultantProfile.completenessOf({ ...FULL, availability: 'not_available' });
    expect(without).toBeLessThan(withAvailability);
  });

  it('treats whitespace-only text as missing', () => {
    const blank = ConsultantProfile.completenessOf({ ...FULL, headline: '   ', bio: '' });
    expect(blank).toBeLessThan(ConsultantProfile.completenessOf(FULL));
  });

  it('leaves a bare profile below the publishing floor', () => {
    const bare = ConsultantProfile.completenessOf({ headline: 'x', primary_role: 'apex-developer' });
    expect(bare).toBeLessThan(ConsultantProfile.MIN_COMPLETENESS_TO_PUBLISH);
  });
});
