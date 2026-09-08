'use strict';

const Quote = require('../../models/Quote');
const { catalogueVersion } = require('../../config/estimation');

describe('quote lifecycle', () => {
  it('allows only draft to sent from a draft', () => {
    expect(Quote.canTransition('draft', 'sent')).toBe(true);
    expect(Quote.canTransition('draft', 'accepted')).toBe(false);
    expect(Quote.canTransition('draft', 'declined')).toBe(false);
  });

  it('allows a sent quote to be decided, expired, or pulled back to draft', () => {
    for (const to of ['accepted', 'declined', 'expired', 'draft']) {
      expect(Quote.canTransition('sent', to)).toBe(true);
    }
  });

  it('treats accepted and declined as final', () => {
    expect(Quote.TRANSITIONS.accepted).toEqual([]);
    expect(Quote.TRANSITIONS.declined).toEqual([]);
    expect(Quote.canTransition('accepted', 'declined')).toBe(false);
    expect(Quote.canTransition('declined', 'sent')).toBe(false);
  });

  it('lets an expired quote be revived as a draft only', () => {
    expect(Quote.canTransition('expired', 'draft')).toBe(true);
    expect(Quote.canTransition('expired', 'accepted')).toBe(false);
  });

  it('rejects unknown statuses on either side', () => {
    expect(Quote.canTransition('nonsense', 'sent')).toBe(false);
    expect(Quote.canTransition('draft', 'nonsense')).toBe(false);
  });
});

describe('quote reference', () => {
  it('has a stable shape', () => {
    expect(Quote.generateReference()).toMatch(/^Q-[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it('omits the characters people mistype when reading one aloud', () => {
    const sample = Array.from({ length: 200 }, () => Quote.generateReference()).join('');
    expect(sample).not.toMatch(/[ILOU]/);
  });

  it('is not obviously repeating', () => {
    const refs = new Set(Array.from({ length: 500 }, () => Quote.generateReference()));
    expect(refs.size).toBe(500);
  });
});

describe('hydrate', () => {
  it('passes an already-parsed JSON column straight through', () => {
    const row = Quote.hydrate({ id: 1, inputs: { a: 1 }, estimate: { totalManDays: 10 } });
    expect(row.inputs).toEqual({ a: 1 });
    expect(row.estimate.totalManDays).toBe(10);
  });

  it('parses a JSON column that came back as a string', () => {
    const row = Quote.hydrate({ id: 1, inputs: '{"a":1}', estimate: '{"totalManDays":10}' });
    expect(row.inputs).toEqual({ a: 1 });
    expect(row.estimate.totalManDays).toBe(10);
  });

  it('degrades to null rather than throwing on unparseable content', () => {
    const row = Quote.hydrate({ id: 1, inputs: 'not json', estimate: null });
    expect(row.inputs).toBeNull();
    expect(row.estimate).toBeNull();
  });
});

describe('catalogue version', () => {
  it('is stable across calls', () => {
    expect(catalogueVersion()).toBe(catalogueVersion());
  });

  it('is short enough to display and long enough to distinguish', () => {
    expect(catalogueVersion()).toMatch(/^[0-9a-f]{12}$/);
  });
});
