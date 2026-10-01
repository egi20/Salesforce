#!/usr/bin/env node
'use strict';

/**
 * WHAT IS NOT CONFIGURED, AND WHAT THAT MEANS TODAY.
 *
 * This codebase degrades on purpose rather than refusing to start: with no Stripe key
 * checkout offers a "not switched on" path, with no Resend key email is logged instead of
 * sent, with no Anthropic key the assistant is not emitted into the markup at all. Each of
 * those is the right behaviour, and together they are a problem — a site can run perfectly
 * with half of itself quietly inert, and nobody finds out until a customer does.
 *
 * So the degradation is listed in ONE place a person runs before deploying, saying what is
 * missing, what the site does instead, and whether that is survivable. It reads
 * configuration only. It connects to nothing, sends nothing, and writes nothing.
 *
 * Exit code 1 means something is BROKEN in production, not merely absent.
 */

require('dotenv').config();

const config = require('./../config/config');
const legal = require('../config/legal');
const assistant = require('../config/assistant');
const stripe = require('../utils/stripe');

const BLOCKING = 'blocking';
const DEGRADED = 'degraded';
const OK = 'ok';

/** Every check: what it needs, and what the site does without it. */
function checks() {
  const production = config.isProduction;
  const out = [];

  const add = (name, level, detail) => out.push({ name, level, detail });

  // --- things that are wrong in production, whatever else is true ------------------
  if (production && !config.app.baseUrl.startsWith('https://')) {
    add('APP_BASE_URL', BLOCKING,
      `is "${config.app.baseUrl}". The session cookie is Secure in production, so over plain ` +
      'HTTP nobody can stay signed in — sign-in appears to succeed and then does nothing.');
  } else {
    add('APP_BASE_URL', OK, config.app.baseUrl);
  }

  // `config/config.js` throws on a default SESSION_SECRET in production, so reaching here
  // means it is set. Saying so is worth more than silence: it is the check people assume.
  add('SESSION_SECRET', OK, production ? 'set (the app refuses to boot otherwise)' : 'development default');

  // --- the legal identity -----------------------------------------------------------
  if (!legal.isConfigured()) {
    add('LEGAL_CONTROLLER_NAME / _ADDRESS', production ? BLOCKING : DEGRADED,
      'unset. The privacy policy and /about say so plainly rather than inventing a name — ' +
      'which is honest and still a legal problem: a policy has to name a real controller.');
  } else {
    add('LEGAL_CONTROLLER_NAME / _ADDRESS', OK, legal.controller.name);
  }

  if (!config.finance.sellerName) {
    add('FINANCE_SELLER_*', DEGRADED,
      'unset. An invoice would carry no legal entity, no tax id and no bank details. ' +
      'Nothing stops one being issued — check this before the first real invoice.');
  } else {
    add('FINANCE_SELLER_*', OK, config.finance.sellerName);
  }

  // --- the paid and external integrations -------------------------------------------
  if (!stripe.isConfigured()) {
    add('STRIPE_SECRET_KEY', DEGRADED,
      'unset. Checkout offers a "payments are not switched on" path. Nothing can be sold.');
  } else if (!process.env.STRIPE_WEBHOOK_SECRET) {
    // Deliberately harsher than a missing secret key: half-configured is the dangerous state.
    add('STRIPE_WEBHOOK_SECRET', BLOCKING,
      'unset while STRIPE_SECRET_KEY is set. The webhook refuses every delivery rather than ' +
      'trusting an unsigned body, so a customer can pay and never be given what they bought.');
  } else {
    add('STRIPE_SECRET_KEY / _WEBHOOK_SECRET', OK, 'both set');
  }

  if (!process.env.RESEND_API_KEY) {
    add('RESEND_API_KEY', DEGRADED,
      'unset. Every email is written to the log instead of sent — including the ones people ' +
      'wait for: verification, a password reset, an application update.');
  } else {
    add('RESEND_API_KEY', OK, 'set');
  }

  if (!assistant.isConfigured()) {
    add('ANTHROPIC_API_KEY', DEGRADED,
      'unset. The assistant widget is not emitted into the markup at all, /assistant/chat ' +
      'answers 503, and quote narrative drafting is unavailable. This is by design.');
  } else {
    add('ANTHROPIC_API_KEY', OK, 'set');
  }

  if (config.app.supportEmail === 'support@example.com') {
    add('SUPPORT_EMAIL', DEGRADED,
      'is still the placeholder. /contact prints no address rather than inviting people to ' +
      'write somewhere nobody reads.');
  } else {
    add('SUPPORT_EMAIL', OK, config.app.supportEmail);
  }

  return out;
}

function main() {
  const results = checks();
  const blocking = results.filter((r) => r.level === BLOCKING);
  const degraded = results.filter((r) => r.level === DEGRADED);

  console.log(`\nPreflight — NODE_ENV=${config.env}\n`);
  for (const r of results) {
    const mark = r.level === OK ? '  ok  ' : r.level === DEGRADED ? ' warn ' : ' STOP ';
    console.log(`[${mark}] ${r.name}`);
    if (r.level !== OK) console.log(`         ${r.detail}`);
    else console.log(`         ${r.detail}`);
  }

  console.log('');
  if (blocking.length) {
    console.log(`${blocking.length} setting(s) would be broken in production.`);
  }
  if (degraded.length) {
    console.log(`${degraded.length} feature(s) are running in their degraded mode.`);
  }
  if (!blocking.length && !degraded.length) {
    console.log('Everything this check knows about is configured.');
  }
  console.log('');

  process.exit(blocking.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { checks, BLOCKING, DEGRADED, OK };
