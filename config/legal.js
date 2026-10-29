'use strict';

/**
 * Who is legally responsible for the personal data this site holds.
 *
 * NOTHING HERE IS INVENTED, and that is the whole point of the file. A privacy policy has to
 * name a controller — a real person or company, with an address somebody can write to. That
 * is not a detail an application can fill in for itself, so these are environment variables
 * and the pages say plainly when they are unset rather than printing a plausible blank.
 *
 * Environment variables rather than editable settings rows, for the same reason
 * `FINANCE_SELLER_*` are: the legal identity behind a service is a deployment decision with
 * an author and a diff, not a form field. `config/settings.js` draws the same line.
 *
 * `isConfigured()` is false until a name and an address are both present. Publishing without
 * them is a choice the operator makes knowingly, with a warning on the page and in the log —
 * not one they make by never having been told.
 */

const controller = Object.freeze({
  name: process.env.LEGAL_CONTROLLER_NAME || '',
  address: process.env.LEGAL_CONTROLLER_ADDRESS || '',
  country: process.env.LEGAL_CONTROLLER_COUNTRY || '',
  registration: process.env.LEGAL_CONTROLLER_REGISTRATION || '',
  // Where a privacy request goes. Falls back to the general support address, because one
  // address somebody actually reads beats a second one nobody has set up.
  privacyEmail: process.env.LEGAL_PRIVACY_EMAIL || '',
  // The data protection authority a complaint goes to. Depends on where the controller is,
  // so it cannot be hardcoded either.
  supervisoryAuthority: process.env.LEGAL_SUPERVISORY_AUTHORITY || ''
});

/**
 * The third parties that receive personal data, and what they get.
 *
 * Listed in code rather than typed into the policy page, because each one exists only when
 * its key is set — a site running without Stripe does not send anything to Stripe, and a
 * policy that says it does is inaccurate in the direction that matters.
 *
 * `when` is evaluated against the live config so the published list describes THIS
 * deployment, not the feature set of the codebase.
 */
const PROCESSORS = Object.freeze([
  {
    name: 'Stripe',
    purpose: 'Taking card payments. Stripe receives your email address and the amount; this site never sees or stores your card details.',
    envKey: 'STRIPE_SECRET_KEY'
  },
  {
    name: 'Resend',
    purpose: 'Sending the emails this site sends you — confirmation, password reset, notifications. Receives your email address and the message.',
    envKey: 'RESEND_API_KEY'
  },
  {
    name: 'Anthropic',
    purpose:
      'The assistant, and drafting help inside quotes and outreach. Receives the text you type into it. It is never sent your name, your email address or your account id — only whether you are signed in and which roles you hold.',
    envKey: 'ANTHROPIC_API_KEY'
  },
  {
    name: 'Google Analytics',
    purpose:
      'Counting visits, only for visitors who press "Allow analytics". Receives the pages you open, your approximate location, device and referrer, and sets the _ga cookies. Nothing is sent before you allow it.',
    envKey: 'GA4_MEASUREMENT_ID'
  },
  {
    name: 'Cloudflare Web Analytics',
    purpose:
      'Counting page views without a cookie or an identifier. Receives the page address, referrer, browser and device type and your country, and reports them to us only as totals.',
    envKey: 'CF_WEB_ANALYTICS_TOKEN'
  },
  {
    name: 'Cloudflare Turnstile',
    purpose: 'Checking that a sign-up is not automated. Receives the challenge result, not your form.',
    envKey: 'TURNSTILE_SECRET_KEY'
  }
]);

/** The processors this deployment actually uses. */
function activeProcessors(env = process.env) {
  return PROCESSORS.filter((p) => Boolean(env[p.envKey]));
}

function isConfigured() {
  return Boolean(controller.name && controller.address);
}

/**
 * Warned about at boot rather than thrown, and the distinction is deliberate: a missing
 * controller is a legal problem, not a broken application, and refusing to start would take
 * a running site down over a text field. It is loud, repeated on the page itself, and
 * impossible to miss on a first deploy.
 */
function warnIfUnconfigured(log = console) {
  if (isConfigured()) return true;
  log.warn(
    '[legal] LEGAL_CONTROLLER_NAME and LEGAL_CONTROLLER_ADDRESS are not set. ' +
      'The privacy policy cannot name who is responsible for personal data, which it is required to do. ' +
      'Set them before this site takes real users.'
  );
  return false;
}

module.exports = { controller, PROCESSORS, activeProcessors, isConfigured, warnIfUnconfigured };
