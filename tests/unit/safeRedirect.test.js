'use strict';

const { safePath } = require('../../utils/safeRedirect');

describe('safePath', () => {
  it('allows a plain same-origin path', () => {
    expect(safePath('/jobs')).toBe('/jobs');
    expect(safePath('/jobs?role=apex-developer')).toBe('/jobs?role=apex-developer');
  });

  it('rejects protocol-relative URLs', () => {
    expect(safePath('//evil.example.com')).toBe('/');
  });

  it('rejects backslash variants that browsers normalise to //', () => {
    expect(safePath('/\\evil.example.com')).toBe('/');
    expect(safePath('\\\\evil.example.com')).toBe('/');
  });

  it('rejects absolute URLs', () => {
    expect(safePath('https://evil.example.com')).toBe('/');
    expect(safePath('javascript:alert(1)')).toBe('/');
  });

  it('rejects a scheme smuggled after a leading slash', () => {
    expect(safePath('/javascript:alert(1)')).toBe('/');
  });

  it('rejects CR/LF injection', () => {
    expect(safePath('/jobs\r\nSet-Cookie: a=b')).toBe('/');
    expect(safePath('/jobs\nX: y')).toBe('/');
  });

  it('falls back for non-strings and empties', () => {
    expect(safePath(null)).toBe('/');
    expect(safePath(undefined, '/dashboard')).toBe('/dashboard');
    expect(safePath('   ')).toBe('/');
    expect(safePath(42)).toBe('/');
  });
});
