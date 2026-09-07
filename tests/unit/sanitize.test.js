'use strict';

const { sanitizeRichText, toPlainText, jsonForScript } = require('../../utils/sanitize');

describe('sanitizeRichText', () => {
  it('strips script tags and their contents', () => {
    const out = sanitizeRichText('<p>Hi</p><script>alert(1)</script>');
    expect(out).not.toContain('script');
    expect(out).toContain('<p>Hi</p>');
  });

  it('strips event handler attributes', () => {
    expect(sanitizeRichText('<p onclick="steal()">x</p>')).not.toContain('onclick');
  });

  it('drops javascript: hrefs', () => {
    expect(sanitizeRichText('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
  });

  it('adds rel and target to surviving links', () => {
    const out = sanitizeRichText('<a href="https://example.com">x</a>');
    expect(out).toContain('rel="nofollow noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it('keeps the allowed formatting tags', () => {
    const out = sanitizeRichText('<p><strong>a</strong><em>b</em><ul><li>c</li></ul></p>');
    expect(out).toContain('<strong>a</strong>');
    expect(out).toContain('<li>c</li>');
  });

  it('removes tags outside the allowlist', () => {
    const out = sanitizeRichText('<iframe src="https://evil.example"></iframe><style>body{}</style><p>ok</p>');
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('style');
    expect(out).toContain('<p>ok</p>');
  });

  it('returns an empty string for empty input', () => {
    expect(sanitizeRichText('')).toBe('');
    expect(sanitizeRichText(null)).toBe('');
  });
});

describe('toPlainText', () => {
  it('strips all markup and collapses whitespace', () => {
    expect(toPlainText('<p>a</p>\n\n  <p>b</p>')).toBe('a b');
  });

  it('truncates with an ellipsis when asked', () => {
    const out = toPlainText('<p>abcdefghij</p>', 6);
    expect(out.length).toBeLessThanOrEqual(6);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('jsonForScript', () => {
  it('escapes a closing script tag so it cannot end the block early', () => {
    const out = jsonForScript({ a: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('</script>');
    expect(out).toContain('\\u003c');
  });

  it('escapes ampersands and the JS line terminators that JSON allows raw', () => {
    expect(jsonForScript('a&b')).toContain('\\u0026');
    expect(jsonForScript('a b')).toContain('\\u2028');
    expect(jsonForScript('a b')).toContain('\\u2029');
  });

  it('serialises nullish as null', () => {
    expect(jsonForScript(undefined)).toBe('null');
    expect(jsonForScript(null)).toBe('null');
  });
});
