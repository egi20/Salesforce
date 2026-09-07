'use strict';

const { parseId } = require('../../utils/ids');

describe('parseId', () => {
  it('accepts a plain positive integer string', () => {
    expect(parseId('44')).toBe(44);
    expect(parseId('1')).toBe(1);
  });

  it('rejects the sourcemap-probe shape that parseInt would accept', () => {
    // parseInt('44.map') === 44, which is exactly how a raw string reached SQL.
    expect(parseId('44.map')).toBeNull();
    expect(parseId('44abc')).toBeNull();
    expect(parseId('44 ')).toBeNull();
  });

  it('rejects non-numeric, zero, negative and float forms', () => {
    expect(parseId('abc')).toBeNull();
    expect(parseId('0')).toBeNull();
    expect(parseId('-1')).toBeNull();
    expect(parseId('1.5')).toBeNull();
    expect(parseId('')).toBeNull();
  });

  it('rejects values beyond the safe integer range', () => {
    expect(parseId('9007199254740993')).toBeNull();
  });

  it('accepts a real positive number and rejects other number shapes', () => {
    expect(parseId(7)).toBe(7);
    expect(parseId(0)).toBeNull();
    expect(parseId(-3)).toBeNull();
    expect(parseId(1.5)).toBeNull();
    expect(parseId(NaN)).toBeNull();
  });
});
