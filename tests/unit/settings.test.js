'use strict';

const {
  DEFINITIONS,
  KEYS,
  isValidKey,
  coerce,
  serialise,
  deserialise,
  defaults,
  assertSettingsIntegrity
} = require('../../config/settings');

/**
 * Runtime settings.
 *
 * The line these tests defend: a setting is an operational switch, and the declared list
 * is provably the WHOLE surface. If an admin form could write an arbitrary key, the
 * settings table would slowly become a second, unreviewable copy of the catalogues that
 * live in version control.
 */
describe('the settings registry', () => {
  it('starts only if every declaration is coherent', () => {
    expect(assertSettingsIntegrity()).toBe(true);
  });

  it('accepts only declared keys', () => {
    for (const key of KEYS) expect(isValidKey(key)).toBe(true);
    for (const key of ['rate_min_sample', 'day_rate_override', '__proto__', 'constructor']) {
      expect(isValidKey(key)).toBe(false);
      expect(coerce(key, 'anything')).toBeNull();
    }
  });

  it('does NOT expose the privacy floor or any catalogue value', () => {
    // RATE_MIN_SAMPLE is an environment variable on purpose: lowering it is a deployment
    // decision, not a checkbox that makes a sparse index look fuller.
    const joined = KEYS.join(' ');
    expect(joined).not.toMatch(/rate|sample|price|day_rate|multiplier|phase/i);
  });
});

describe('coercion', () => {
  it('reads an absent checkbox as false, not as unchanged', () => {
    // An unticked checkbox posts NOTHING. A body-driven loop would leave every switch that
    // was turned off silently on forever.
    expect(coerce('registration_open', undefined)).toBe(false);
    expect(coerce('registration_open', null)).toBe(false);
    expect(coerce('registration_open', '')).toBe(false);
  });

  it('reads the values a browser actually posts as true', () => {
    for (const raw of ['on', 'true', '1', true]) {
      expect(coerce('registration_open', raw)).toBe(true);
    }
  });

  it('bounds a text setting at its declared length', () => {
    const long = 'x'.repeat(5000);
    expect(coerce('site_notice', long).length).toBe(DEFINITIONS.site_notice.maxLength);
  });

  it('trims text so a notice of spaces is no notice at all', () => {
    // Otherwise the banner renders as an empty amber bar on every page.
    expect(coerce('site_notice', '   ')).toBe('');
  });
});

describe('storage round trip', () => {
  it('survives serialise then deserialise for every declared key', () => {
    const values = defaults();
    for (const key of KEYS) {
      expect(deserialise(key, serialise(key, values[key]))).toEqual(values[key]);
    }
  });

  it('round-trips a flipped boolean', () => {
    expect(deserialise('registration_open', serialise('registration_open', false))).toBe(false);
    expect(deserialise('community_read_only', serialise('community_read_only', true))).toBe(true);
  });

  it('falls back to the declared default for a missing row', () => {
    // A key added in a release the database has not seen a write for yet.
    expect(deserialise('registration_open', null)).toBe(DEFINITIONS.registration_open.default);
    expect(deserialise('site_notice', undefined)).toBe(DEFINITIONS.site_notice.default);
  });

  it('defaults to a site that is open and quiet', () => {
    expect(defaults()).toEqual({
      registration_open: true,
      site_notice: '',
      community_read_only: false
    });
  });
});
