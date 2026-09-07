'use strict';

const { returnTo } = require('../../utils/returnTo');

describe('returnTo', () => {
  it('uses an explicit redirectTo field from the form', () => {
    expect(returnTo({ method: 'POST', body: { redirectTo: '/profile/consultant' } })).toBe('/profile/consultant');
  });

  it('rejects an off-site redirectTo and uses the fallback', () => {
    expect(returnTo({ method: 'POST', body: { redirectTo: 'https://evil.example' } }, '/dashboard')).toBe('/dashboard');
    expect(returnTo({ method: 'POST', body: { redirectTo: '//evil.example' } }, '/dashboard')).toBe('/dashboard');
  });

  it('falls back to the given path on a POST with no redirectTo', () => {
    expect(returnTo({ method: 'POST', body: {} }, '/jobs/abc')).toBe('/jobs/abc');
  });

  it('returns a GET to itself', () => {
    expect(returnTo({ method: 'GET', body: {}, originalUrl: '/jobs?role=apex-developer' })).toBe('/jobs?role=apex-developer');
  });

  it('never consults the Referer header', () => {
    // Referrer-Policy: no-referrer means Referer is empty on real browser POSTs, so a
    // Referer-based "go back" silently lands on / and looks like a bug.
    const req = {
      method: 'POST',
      body: {},
      get: () => {
        throw new Error('returnTo must not read request headers');
      }
    };
    expect(() => returnTo(req, '/dashboard')).not.toThrow();
    expect(returnTo(req, '/dashboard')).toBe('/dashboard');
  });

  it('sanitises the fallback itself', () => {
    expect(returnTo({ method: 'POST', body: {} }, 'https://evil.example')).toBe('/');
  });
});
