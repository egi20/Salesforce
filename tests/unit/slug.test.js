'use strict';

const { slugify, uniqueSlug } = require('../../utils/slug');

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Senior CPQ Consultant')).toBe('senior-cpq-consultant');
  });

  it('strips diacritics rather than dropping the letters', () => {
    expect(slugify('Përshëndetje Botë')).toBe('pershendetje-bote');
  });

  it('collapses runs of separators and trims them', () => {
    expect(slugify('  --a & b--  ')).toBe('a-b');
  });

  it('never returns an empty slug', () => {
    expect(slugify('!!!')).toBe('item');
    expect(slugify('', 'job')).toBe('job');
    expect(slugify(null)).toBe('item');
  });

  it('bounds the length', () => {
    expect(slugify('a'.repeat(500)).length).toBeLessThanOrEqual(180);
  });
});

describe('uniqueSlug', () => {
  it('returns the base when it is free', async () => {
    expect(await uniqueSlug('Apex Developer', async () => false)).toBe('apex-developer');
  });

  it('appends a counter until it finds a free one', async () => {
    const taken = new Set(['apex-developer', 'apex-developer-2']);
    expect(await uniqueSlug('Apex Developer', async (c) => taken.has(c))).toBe('apex-developer-3');
  });

  it('falls back to a suffixed slug rather than looping forever', async () => {
    const result = await uniqueSlug('Apex Developer', async () => true, { maxAttempts: 3 });
    expect(result.startsWith('apex-developer-')).toBe(true);
  });
});
