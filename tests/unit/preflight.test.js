'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/*
 * WHY THIS FILE EXISTS.
 *
 * `scripts/preflight.js` is the only place that says, in one list, what this deployment is
 * NOT doing. Everything it reports is a deliberate degradation — checkout offers a "not
 * switched on" path, email is logged instead of sent, the assistant is not emitted at all —
 * and each of those is right on its own. The danger is the sum: a site can run perfectly
 * with half of itself inert, and the first person to find out is a customer.
 *
 * So the levels are asserted rather than trusted. A check that quietly stopped blocking is
 * worse than no check, because somebody deployed on the strength of it.
 */
function runChecks(env) {
  jest.resetModules();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    // eslint-disable-next-line global-require
    const { checks, BLOCKING, DEGRADED, OK } = require(path.join(ROOT, 'scripts', 'preflight.js'));
    const results = checks();
    const byName = (needle) => results.find((r) => r.name.includes(needle));
    return { results, byName, BLOCKING, DEGRADED, OK };
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const PROD = {
  NODE_ENV: 'production',
  SESSION_SECRET: 'a-real-secret-for-the-test',
  APP_BASE_URL: 'https://example.com'
};

describe('preflight', () => {
  test('plain HTTP in production is blocking, not a warning', () => {
    // The session cookie is Secure in production. Over http, sign-in appears to succeed and
    // then does nothing — the single most confusing way for a deployment to be broken.
    const { byName, BLOCKING } = runChecks({ ...PROD, APP_BASE_URL: 'http://example.com' });
    expect(byName('APP_BASE_URL').level).toBe(BLOCKING);
  });

  test('HTTPS in production passes', () => {
    const { byName, OK } = runChecks(PROD);
    expect(byName('APP_BASE_URL').level).toBe(OK);
  });

  test('a Stripe key with no webhook secret is blocking', () => {
    // Half-configured is the dangerous state, and it is HARSHER than no Stripe at all:
    // checkout works, the webhook refuses every delivery, and somebody pays for nothing.
    const { byName, BLOCKING } = runChecks({ ...PROD, STRIPE_SECRET_KEY: 'sk_test_x' });
    expect(byName('STRIPE_WEBHOOK_SECRET').level).toBe(BLOCKING);
  });

  test('no Stripe at all is only degraded', () => {
    const { byName, DEGRADED } = runChecks(PROD);
    expect(byName('STRIPE').level).toBe(DEGRADED);
  });

  test('an unset controller blocks in production and only warns in development', () => {
    // A policy that names no controller is a legal problem, not a broken application —
    // which is exactly why config/legal.js warns rather than throwing, and why this is the
    // place that refuses to let it reach production unnoticed.
    expect(runChecks(PROD).byName('LEGAL_CONTROLLER').level).toBe(runChecks(PROD).BLOCKING);
    const dev = runChecks({ NODE_ENV: 'development' });
    expect(dev.byName('LEGAL_CONTROLLER').level).toBe(dev.DEGRADED);
  });

  test('a support address set TO THE PLACEHOLDER counts as unset', () => {
    // It is set in this repo's .env, to `support@example.com`. A "is the variable present"
    // check answers yes; the site still prints no address anywhere.
    const { byName, DEGRADED } = runChecks({ ...PROD, SUPPORT_EMAIL: 'support@example.com' });
    expect(byName('SUPPORT_EMAIL').level).toBe(DEGRADED);
    const real = runChecks({ ...PROD, SUPPORT_EMAIL: 'hello@salesforcehub.net' });
    expect(real.byName('SUPPORT_EMAIL').level).toBe(real.OK);
  });

  test('it reads configuration only — it connects to nothing', () => {
    const fs = require('fs');
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'preflight.js'), 'utf8');
    for (const forbidden of ['promisePool', 'fetch(', 'require(\'../models', 'send(']) {
      expect(source).not.toContain(forbidden);
    }
  });
});
