'use strict';

const fs = require('fs');
const path = require('path');

const WIDGET_JS = path.join(__dirname, '..', '..', 'public', 'js', 'assistant.js');
const source = fs.readFileSync(WIDGET_JS, 'utf8');

/**
 * The client-side renderer for assistant replies.
 *
 * A model reply is attacker-influenceable text: whatever a visitor types can steer it.
 * The moment that text is parsed as markup, a prompt-injected reply becomes stored XSS on
 * every page of the site — and rendering markdown "just for the links" through innerHTML
 * is exactly how that happens.
 *
 * The file is browser code in an IIFE, so these tests assert against its source: the one
 * regex that decides whether a link is safe, and the absence of the one API that would
 * make all of it moot.
 */

function extractRegex(name) {
  const match = source.match(new RegExp(`var ${name} = (/.*/);`));
  if (!match) throw new Error(`${name} not found in public/js/assistant.js`);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${match[1]};`)();
}

describe('assistant reply rendering', () => {
  it('never uses innerHTML, outerHTML or insertAdjacentHTML on model output', () => {
    expect(source).not.toMatch(/\.innerHTML/);
    expect(source).not.toMatch(/\.outerHTML/);
    expect(source).not.toMatch(/insertAdjacentHTML/);
    expect(source).not.toMatch(/document\.write/);
  });

  it('builds every node explicitly', () => {
    expect(source).toMatch(/document\.createElement/);
    expect(source).toMatch(/document\.createTextNode/);
  });
});

describe('the link allowlist', () => {
  const SAFE_PATH = extractRegex('SAFE_PATH');

  it('accepts the site-relative paths the assistant is told to use', () => {
    const good = [
      '/jobs',
      '/jobs/new',
      '/rates/submit',
      '/community',
      '/payments/history',
      '/auth/register',
      '/quotes/new',
      '/jobs?role=admin&seniority=senior',
      '/faq#rates'
    ];
    for (const href of good) expect(SAFE_PATH.test(href)).toBe(true);
  });

  it('rejects anything that could leave this origin', () => {
    const bad = [
      'https://evil.example/steal',
      'http://evil.example',
      '//evil.example',            // protocol-relative: a full off-site URL
      '/\\evil.example',           // some browsers normalise the backslash to a slash
      'javascript:alert(1)',       // eslint-disable-line no-script-url
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'mailto:someone@example.com',
      'jobs',                      // relative, resolves against the current page
      '',
      ' /jobs'
    ];
    for (const href of bad) expect(SAFE_PATH.test(href)).toBe(false);
  });

  it('rejects a path carrying characters that only matter inside markup', () => {
    for (const href of ['/jobs"onmouseover=alert(1)', "/jobs'x", '/jobs<script>', '/jobs>x']) {
      expect(SAFE_PATH.test(href)).toBe(false);
    }
  });
});
