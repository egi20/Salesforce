'use strict';

const fs = require('fs');
const path = require('path');
const { shouldCount } = require('../../utils/salesAgentOpens');

const ROOT = path.join(__dirname, '..', '..');
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.1';

/*
 * WHY THIS FILE EXISTS.
 *
 * An agent's "opens" read low while their sign-ups kept growing. The sign-ups were real: they
 * arrived through /auth/register?a=<code>, the address left in the bar after /s/<code>
 * redirects, which is the one people copy and forward — and opens were only ever counted at
 * /s/. And the other way round, an agent opening their own link while signed in was counted
 * once per device. These hold the rule and the fact that both addresses ask the same function.
 */
describe('what counts as one open of an agent link', () => {
  test('a person, not signed in, the first time this session', () => {
    expect(shouldCount({ signedIn: false, userAgent: BROWSER, alreadyCounted: [], code: 'AB12CD34' })).toBe(true);
  });

  test('never somebody signed in — commonly the agent checking their own link', () => {
    expect(shouldCount({ signedIn: true, userAgent: BROWSER, alreadyCounted: [], code: 'AB12CD34' })).toBe(false);
  });

  test('once per session, so the redirect from /s/ landing on the form is not a second open', () => {
    expect(shouldCount({ signedIn: false, userAgent: BROWSER, alreadyCounted: ['AB12CD34'], code: 'AB12CD34' })).toBe(false);
    expect(shouldCount({ signedIn: false, userAgent: BROWSER, alreadyCounted: ['ZZ99ZZ99'], code: 'AB12CD34' })).toBe(true);
  });

  test('not a crawler, not a chat app drawing a preview, not an empty user agent', () => {
    for (const ua of ['Googlebot/2.1', 'WhatsApp/2.23.20.0 A', 'facebookexternalhit/1.1', 'curl/8.4.0', '']) {
      expect(shouldCount({ signedIn: false, userAgent: ua, alreadyCounted: [], code: 'AB12CD34' })).toBe(false);
    }
  });

  test('the link and the form it lands on both count through the one helper', () => {
    const index = fs.readFileSync(path.join(ROOT, 'routes', 'index.js'), 'utf8');
    const auth = fs.readFileSync(path.join(ROOT, 'routes', 'auth.js'), 'utf8');
    expect(index).toMatch(/countOpenOnce\(req, agent\)/);
    expect(auth).toMatch(/countOpenOnce\(req, await SalesAgent\.findActiveByCode\(agentCode\)\)/);
    // Nobody counts an open any other way.
    for (const src of [index, auth]) expect(src).not.toMatch(/SalesAgent\.countOpen\(/);
  });
});
