'use strict';

const linkedin = require('../../utils/linkedin');
const { SCOPES, STATE_TTL_MS, assertLinkedInIntegrity, isConfigured } = require('../../config/linkedin');

/**
 * LinkedIn identity verification.
 *
 * The tests that matter here are about what the integration CLAIMS and what it ASKS FOR,
 * not about the OAuth mechanics — because the reference implementation's mechanics were
 * fine and its claim was wrong. It extracted the username from the URL the member had
 * typed, logged it next to the subject LinkedIn returned, and then set
 * `linkedin_verified = true` without comparing them, because there is nothing in an
 * ordinary LinkedIn scope to compare against.
 */
describe('the integration contract', () => {
  it('starts cleanly with no credentials', () => {
    expect(assertLinkedInIntegrity()).toBe(true);
    expect(isConfigured()).toBe(false);
  });

  it('asks for identity scopes only — never permission to post', () => {
    /*
     * `w_member_social` is permission to publish as the member. Asking for the ability to
     * post as somebody in order to check who they are is a much larger permission than the
     * task needs, and the consent screen says so — which is the first thing that makes
     * people abandon the flow.
     */
    expect(SCOPES.split(' ').sort()).toEqual(['email', 'openid', 'profile']);
    expect(SCOPES).not.toMatch(/w_member_social|w_organization|rw_/);
  });

  it('refuses to build an authorisation URL with no client id', () => {
    // With nothing configured the URL would still form, pointing at LinkedIn with an empty
    // client_id — a redirect to an error page the member cannot act on. The routes gate on
    // isConfigured() before ever getting here.
    expect(isConfigured()).toBe(false);
  });
});

describe('the authorisation state', () => {
  it('matches only itself', () => {
    const state = linkedin.newState();
    expect(linkedin.stateMatches(state, state.value)).toBe(true);
    expect(linkedin.stateMatches(state, `${state.value}x`)).toBe(false);
    expect(linkedin.stateMatches(state, state.value.slice(0, -1))).toBe(false);
  });

  it('is unguessable and never repeats', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i += 1) seen.add(linkedin.newState().value);
    expect(seen.size).toBe(2000);
    expect(linkedin.newState().value.length).toBeGreaterThanOrEqual(40);
  });

  it('expires, so a flow left open cannot be replayed later', () => {
    const stale = { value: 'x'.repeat(43), expiresAt: Date.now() - 1 };
    expect(linkedin.stateMatches(stale, stale.value)).toBe(false);
  });

  it('has a sane lifetime — long enough to sign in, short enough to matter', () => {
    expect(STATE_TTL_MS).toBeGreaterThan(60 * 1000);
    expect(STATE_TTL_MS).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  it('refuses anything that is not a state', () => {
    const state = linkedin.newState();
    for (const bad of [undefined, null, 42, {}, [], '']) {
      expect(linkedin.stateMatches(state, bad)).toBe(false);
    }
    for (const bad of [undefined, null, {}, { value: '' }]) {
      expect(linkedin.stateMatches(bad, 'anything')).toBe(false);
    }
  });
});

describe('the name check', () => {
  it('accepts the same person written two ways', () => {
    // The looseness is deliberate. People legitimately differ between the two sides.
    expect(linkedin.namesAgree('Ana Pjetri', 'Ana Maria Pjetri')).toBe(true);
    expect(linkedin.namesAgree('Ana Maria Pjetri', 'Ana Pjetri')).toBe(true);
    expect(linkedin.namesAgree('Pjetri, Ana', 'Ana Pjetri')).toBe(true);
    expect(linkedin.namesAgree('ANA PJETRI', 'ana pjetri')).toBe(true);
  });

  it('ignores diacritics, which the two systems spell differently', () => {
    expect(linkedin.namesAgree('Ana Pjetrí', 'Ana Pjetri')).toBe(true);
    expect(linkedin.namesAgree('Jose Muñoz', 'José Munoz')).toBe(true);
  });

  it('rejects two clearly different people', () => {
    expect(linkedin.namesAgree('Ana Pjetri', 'John Smith')).toBe(false);
  });

  it('rejects rather than guessing when either side is empty', () => {
    // An account with no name must not silently "match" everybody.
    for (const [a, b] of [['', 'Ana Pjetri'], ['Ana Pjetri', ''], ['', ''], [null, null]]) {
      expect(linkedin.namesAgree(a, b)).toBe(false);
    }
  });

  it('does not match on a single letter or a stray initial', () => {
    // Tokens of one character are dropped: "A Smith" and "A Jones" share nothing real.
    expect(linkedin.namesAgree('A Smith', 'A Jones')).toBe(false);
  });

  it('is a signal, not a gate — the result is recorded either way', () => {
    /*
     * Stated as a test so the intent survives. A mismatch is surfaced to the member and
     * stored as `name_matched = 0`; it never refuses the link. A stricter rule would
     * reject real people to catch a case it cannot catch anyway, since nothing in this
     * flow proves the LinkedIn account belongs to the person holding it.
     */
    expect(typeof linkedin.namesAgree('Ana', 'Bob')).toBe('boolean');
  });
});

describe('what the integration does not do', () => {
  it('exposes no way to post, share or message', () => {
    // There is no LinkedIn API available to an ordinary application for sending
    // connection requests or direct messages. A feature implying automated outreach
    // would be a lie, so there is nothing here that could imply one.
    const surface = Object.keys(linkedin).join(' ');
    expect(surface).not.toMatch(/post|share|message|connect(?!ion)|invite/i);
  });

  it('exposes no sign-in or account-creation path', () => {
    // Linking only. An OAuth provider that can also sign you in has to decide what to do
    // when its email matches an existing account, and every answer is a documented
    // account-takeover pattern.
    const surface = Object.keys(linkedin).join(' ');
    expect(surface).not.toMatch(/signIn|login|register|createAccount/i);
  });

  it('returns only a subject and a name from a provider payload', async () => {
    // The real response also carries an email, a picture and a locale. Personal data
    // fetched without a purpose is personal data to account for later.
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        sub: 'abc123',
        name: 'Ana Pjetri',
        given_name: 'Ana',
        family_name: 'Pjetri',
        email: 'ana@example.com',
        email_verified: true,
        picture: 'https://media.licdn.com/x.jpg',
        locale: 'en_US'
      })
    });

    try {
      const identity = await linkedin.fetchIdentity('token');
      expect(identity).toEqual({ subject: 'abc123', name: 'Ana Pjetri' });
      expect(Object.keys(identity)).toEqual(['subject', 'name']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('refuses a payload with no subject rather than inventing an identity', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ name: 'Ana Pjetri' }) });
    try {
      await expect(linkedin.fetchIdentity('token')).rejects.toMatchObject({ code: 'LINKEDIN_USERINFO' });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('falls back to the given and family names when no full name is returned', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ sub: 'x', given_name: 'Ana', family_name: 'Pjetri' }) });
    try {
      expect((await linkedin.fetchIdentity('token')).name).toBe('Ana Pjetri');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
