'use strict';

/*
 * The database module is replaced BEFORE the model loads: the model destructures
 * `withTransaction` at require time, so spying on it afterwards does not reach the model —
 * and a first version of this test wrote real rows into a local development database.
 */
const inserted = [];
jest.mock('../../config/database', () => ({
  pool: {},
  promisePool: { query: jest.fn(async () => [[]]) },
  withTransaction: jest.fn(async (fn) => fn({
    query: async (sql, params) => { if (/INSERT/.test(sql)) inserted.push(params[0]); return [[]]; }
  }))
}));

const ConsultantProfile = require('../../models/ConsultantProfile');

describe('what a profile needs before it can be listed', () => {
  const ready = { primary_role: 'apex-developer', availability: 'immediate', completeness: 80 };

  it('asks for a role, a cloud, availability and the completeness floor, and nothing once they are there', () => {
    expect(ConsultantProfile.listingProblems({ ...ready, availability: null }, { cloudCount: 1 })).toEqual(['set your availability']);
    expect(ConsultantProfile.listingProblems(ready, { cloudCount: 1 })).toEqual([]);
    expect(ConsultantProfile.listingProblems({ ...ready, primary_role: null }, { cloudCount: 1 })).toEqual(['choose your primary role']);
    expect(ConsultantProfile.listingProblems(ready, { cloudCount: 0 })).toEqual(['pick at least one cloud you work on']);
    expect(ConsultantProfile.listingProblems({ ...ready, completeness: 40 }, { cloudCount: 1 })[0]).toMatch(/reach 60% complete/);
  });
});

describe('the progress bar hint', () => {
  it('offers the biggest gain first, from the same weights completeness scores with', () => {
    const steps = ConsultantProfile.nextSteps({ headline: 'x', primary_role: 'apex-developer' }, { skillCount: 1 });
    expect(steps[0].gain).toBeGreaterThanOrEqual(steps[steps.length - 1].gain);
    expect(steps.map((s) => s.label)).toEqual(expect.arrayContaining(['write a short bio', 'add 2 more skills']));
    expect(steps.map((s) => s.label)).not.toContain('add a professional title');
  });
});

describe('the profile lists validate every element', () => {
  beforeEach(() => { inserted.length = 0; });

  it('keeps only real cloud families, and writes only those', async () => {
    const kept = await ConsultantProfile.setClouds(7, ['sales-cloud', 'not-a-cloud', '__proto__']);
    expect(kept).toEqual(['sales-cloud']);
    expect(inserted).toEqual([[[7, 'sales-cloud']]]);
  });

  it('keeps only real country codes, de-duplicated', async () => {
    expect(await ConsultantProfile.setWorkCountries(7, ['DE', 'XX', 'DE', 'AL'])).toEqual(['DE', 'AL']);
  });

  it('drops a language with an unknown level and a repeated language', async () => {
    const kept = await ConsultantProfile.setLanguages(7, [
      { language: 'English', level: 'native' },
      { language: 'english', level: 'basic' },
      { language: 'German', level: 'professional' },
      { language: '  ', level: 'basic' }
    ]);
    expect(kept).toEqual([['English', 'native']]);
  });
});
