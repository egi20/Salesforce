'use strict';

const { matchScore, MAX_SCORE, WEIGHTS } = require('../../utils/jobMatcher');

const JOB = {
  role: 'apex-developer',
  title: 'Senior Apex Developer',
  description: 'Apex triggers, SOQL and LWC on a large org.',
  seniority: 'senior',
  work_mode: 'remote',
  country: 'DE',
  rate_min: 600,
  rate_max: 800
};

describe('match score', () => {
  it('is 100 for a perfect fit', () => {
    const { score } = matchScore(
      JOB,
      { primary_role: 'apex-developer', seniority: 'senior', country: 'DE', day_rate: 700, availability: 'immediate' },
      { jobSkillIds: [1, 2], consultantSkillIds: [1, 2] }
    );
    expect(score).toBe(100);
  });

  it('is bounded to 0..100', () => {
    const { score } = matchScore(JOB, {});
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('gives partial credit when an alias appears in the job text', () => {
    const aliased = matchScore({ ...JOB, title: 'CPQ specialist', description: 'Configure price quote work' }, {
      primary_role: 'cpq-consultant',
      seniority: 'senior'
    });
    expect(aliased.breakdown.role).toBeGreaterThan(0);
    expect(aliased.breakdown.role).toBeLessThan(WEIGHTS.role);
  });

  it('does not penalise a consultant who is under the budget', () => {
    const under = matchScore(JOB, { primary_role: 'apex-developer', day_rate: 400 });
    expect(under.breakdown.rate).toBe(WEIGHTS.rate);
  });

  it('decays the rate score above the band and zeroes it well over', () => {
    const slightlyOver = matchScore(JOB, { primary_role: 'apex-developer', day_rate: 850 });
    const wayOver = matchScore(JOB, { primary_role: 'apex-developer', day_rate: 1200 });
    expect(slightlyOver.breakdown.rate).toBeGreaterThan(0);
    expect(slightlyOver.breakdown.rate).toBeLessThan(WEIGHTS.rate);
    expect(wayOver.breakdown.rate).toBe(0);
  });

  it('scores a remote job for any location', () => {
    const far = matchScore(JOB, { primary_role: 'apex-developer', country: 'AU' });
    expect(far.breakdown.location).toBe(WEIGHTS.location);
  });

  it('halves location for an onsite job when the consultant will travel', () => {
    const onsite = { ...JOB, work_mode: 'onsite' };
    const willTravel = matchScore(onsite, { primary_role: 'apex-developer', country: 'AL', willing_to_travel: true });
    const wontTravel = matchScore(onsite, { primary_role: 'apex-developer', country: 'AL' });
    expect(willTravel.breakdown.location).toBeGreaterThan(wontTravel.breakdown.location);
    expect(wontTravel.breakdown.location).toBe(0);
  });

  it('scores one seniority level apart at half, two apart at zero', () => {
    const oneApart = matchScore(JOB, { primary_role: 'apex-developer', seniority: 'mid' });
    const twoApart = matchScore(JOB, { primary_role: 'apex-developer', seniority: 'junior' });
    expect(oneApart.breakdown.seniority).toBe(Math.round(WEIGHTS.seniority / 2));
    expect(twoApart.breakdown.seniority).toBe(0);
  });

  it('treats a job with no stated skills as neutral rather than as a miss', () => {
    const neutral = matchScore(JOB, { primary_role: 'apex-developer' }, { jobSkillIds: [] });
    expect(neutral.breakdown.skills).toBe(Math.round(WEIGHTS.skills * 0.5));
  });

  it('has weights that sum to the documented maximum', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(MAX_SCORE);
  });
});
