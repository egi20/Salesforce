'use strict';

/**
 * The QA accounts the admin test panel signs in as — who they are, and how everything else
 * recognises them. Pure: no database here, so the rules are testable and every module that
 * has to leave these accounts out asks the same question.
 *
 * OPT-IN, as in the reference. They exist only while `QA_TEST_PASSWORD` is set, and that
 * variable is also their password, so a deployment that never sets it never has them. Unlike
 * the reference, a password shorter than QA_MIN_PASSWORD counts as unset: it signs a plain
 * admin in on a live site, and "qa" is not a password anyone should be able to guess.
 *
 * The addresses are on `.test`, which RFC 6761 reserves and no mail server will ever
 * answer for, so nothing sent to one can reach a person — and `utils/email.js` refuses to
 * send to `.test` at all rather than rely on that.
 *
 * What these accounts must never do is be counted. A QA consultant in the public
 * directory, a QA sign-up in "new this week" or in a sales agent's unattributed row, a QA
 * page view in the visitor geography: each is the site measuring its own test harness,
 * which is the SAP Hub finding `middleware/visitGeo.js` exists for. `QA_EMAIL_LIKE` is the
 * one pattern those queries use, always as a bound parameter.
 */
const QA_DOMAIN = 'salesforcehub.test';
const QA_ROLES = Object.freeze(['consultant', 'company', 'recruiter', 'admin']);
const QA_MIN_PASSWORD = 12;
const QA_EMAIL_LIKE = `%@${QA_DOMAIN}`;

/*
 * Sent on every request the runner makes. `monitor` is in NOT_A_PERSON, so a sales agent's
 * link opened by the runner is not an open; `isOwnTraffic` recognises the whole string, so
 * a page the runner loads is not a visit. Spoofing it only ever removes the spoofer from a
 * count, which is harmless.
 */
const SELF_TEST_USER_AGENT = 'SalesforceHub-SelfTest/1.0 (admin test panel; monitor)';

function qaEmail(role) {
  if (!QA_ROLES.includes(role)) throw new Error(`No QA account for role "${role}".`);
  return `qa-${role}@${QA_DOMAIN}`;
}

function isQaEmail(email) {
  return String(email || '').trim().toLowerCase().endsWith(`@${QA_DOMAIN}`);
}

/** Any address on the reserved `.test` top-level domain, QA or otherwise. */
function isReservedTestAddress(email) {
  return /\.test$/i.test(String(email || '').trim());
}

/** The QA password, or null when signed-in cases must be skipped. */
function qaPassword(env = process.env) {
  const value = typeof env.QA_TEST_PASSWORD === 'string' ? env.QA_TEST_PASSWORD : '';
  return value.length >= QA_MIN_PASSWORD ? value : null;
}

/** Why signed-in cases are skipped, in words the test screen shows. */
function qaUnavailableReason(env = process.env) {
  const value = typeof env.QA_TEST_PASSWORD === 'string' ? env.QA_TEST_PASSWORD : '';
  if (!value) return 'QA_TEST_PASSWORD is not set, so there is no QA account to sign in as (any that exist are switched off).';
  if (value.length < QA_MIN_PASSWORD) {
    return `QA_TEST_PASSWORD is shorter than ${QA_MIN_PASSWORD} characters, so it is treated as unset.`;
  }
  return null;
}

function isSelfTestRequest(req) {
  return Boolean(req && typeof req.get === 'function' && req.get('user-agent') === SELF_TEST_USER_AGENT);
}

module.exports = {
  QA_DOMAIN,
  QA_ROLES,
  QA_MIN_PASSWORD,
  QA_EMAIL_LIKE,
  SELF_TEST_USER_AGENT,
  qaEmail,
  isQaEmail,
  isReservedTestAddress,
  qaPassword,
  qaUnavailableReason,
  isSelfTestRequest
};
