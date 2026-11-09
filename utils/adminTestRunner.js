'use strict';

const crypto = require('crypto');

const config = require('../config/config');
const { caseSafetyProblems, headersFor, statusList } = require('../config/adminTests');
const AdminTestCase = require('../models/AdminTestCase');
const ErrorLog = require('../models/ErrorLog');
const QaAccount = require('../models/QaAccount');
const { SELF_TEST_USER_AGENT, qaEmail, qaPassword, qaUnavailableReason } = require('./qaAccounts');

/*
 * The admin test runner: real HTTP requests to this app on its own base URL, one at a time,
 * with redirects NOT followed, so a guard's 302 is read as a 302 rather than as the 200 of
 * the login page it points at.
 *
 * Ported from the reference's utils/testRunner.js with its behaviours — expected status
 * lists, expected / unexpected strings, an expected redirect, a timeout, signed-in cases per
 * role, failures copied to the error log — and these corrections:
 *
 *  - Signing in goes through the real form: GET /auth/login for the cookie and its CSRF
 *    token, then POST it. The reference posts credentials with no token, which works only
 *    because it has no CSRF layer on that route.
 *  - Redirects are never followed, signed in or not. The reference follows up to five for a
 *    signed-in case, so "this page bounced me to my dashboard" and "this page loaded" were
 *    the same pass.
 *  - No `X-Forwarded-Proto`. The reference sends `https` so its secure cookie is issued over
 *    a loopback request. Here the runner talks to APP_BASE_URL — in production the public
 *    https address, through the platform's proxy, which sets that header itself — and in
 *    development the cookie is not `secure` at all (config.session.cookie). Forging the
 *    header would make a misconfigured http base URL look healthy, and an http base URL in
 *    production is exactly what should fail loudly: the sign-in step says so.
 *  - A skipped case is recorded as SKIPPED. The reference drops it from the run, so the
 *    screen showed "40/40 passed" with sixty cases unrun.
 *  - A body is read up to MAX_BODY_BYTES and no further.
 */
const MAX_BODY_BYTES = 256 * 1024;
const EXCERPT_CHARS = 500;

// QA session cookies, kept between runs in this process and re-checked before use. The
// login route allows ten attempts per address per ten minutes, and four roles signing in
// on every click of "Run" would lock the panel out of its own accounts by the third click.
const sessionCache = new Map();

function baseOrigin(baseUrl) {
  return new URL(baseUrl).origin;
}

/**
 * The URL for a case — the base plus the case's path, and nothing else. Checked again
 * here, after `caseSafetyProblems`, because this is the line that would send a request
 * somewhere else.
 */
function urlFor(baseUrl, endpoint) {
  const url = new URL(`${baseUrl}${endpoint}`);
  if (url.origin !== baseOrigin(baseUrl)) throw new Error('Endpoint resolves to another host.');
  return url;
}

function cookieFrom(response) {
  const all = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const sid = all.find((c) => c.startsWith('sfhub.sid='));
  return sid ? sid.split(';')[0] : null;
}

/** Read at most `limit` bytes of a response body, then stop the download. */
async function readBounded(response, limit = MAX_BODY_BYTES) {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.length;
    if (total >= limit) {
      truncated = true;
      reader.cancel().catch(() => {});
      break;
    }
  }
  return { text: Buffer.concat(chunks).subarray(0, limit).toString('utf8'), truncated };
}

/**
 * The visible text of a response, short — what a failure keeps. Scripts, styles and the
 * <head> are dropped first, because the first five hundred characters of any page here are
 * otherwise the same stylesheet links.
 */
function excerptOf(text) {
  const main = /<main[\s\S]*?<\/main>/i.exec(text);
  const visible = (main ? main[0] : text)
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return visible.slice(0, EXCERPT_CHARS) || null;
}

/** A Location header as a path on this site, or the header unchanged if it is not one. */
function locationPath(location, baseUrl) {
  if (!location) return '';
  try {
    const url = new URL(location, baseUrl);
    return url.origin === baseOrigin(baseUrl) ? `${url.pathname}${url.search}${url.hash}` : location;
  } catch (err) {
    return location;
  }
}

/** Pure: what is wrong with this response for this case. Empty means it passed. */
function evaluate(testCase, { status, location, text, truncated }, baseUrl = config.app.baseUrl) {
  const errors = [];
  const expected = statusList(testCase.expectedStatus);
  if (!expected.includes(status)) {
    errors.push(`Expected status ${expected.join(' or ')}, got ${status}`);
  }
  if (testCase.expectedRedirect) {
    const at = locationPath(location, baseUrl);
    const want = testCase.expectedRedirect;
    if (!(at === want || at.startsWith(`${want}?`) || at.startsWith(`${want}#`))) {
      errors.push(`Expected a redirect to "${want}", got ${at ? `"${at}"` : 'no Location header'}`);
    }
  }
  const scope = truncated ? ` (in the first ${MAX_BODY_BYTES / 1024} KB)` : '';
  (testCase.expectedContains || []).forEach((s) => {
    if (!text.includes(s)) errors.push(`Response should contain "${s}"${scope}`);
  });
  (testCase.expectedNotContains || []).forEach((s) => {
    if (text.includes(s)) errors.push(`Response should NOT contain "${s}"`);
  });
  return errors;
}

async function request(baseUrl, path, { method = 'GET', headers = {}, cookie = null, body = null, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(urlFor(baseUrl, path), {
      method,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': SELF_TEST_USER_AGENT,
        ...headers,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== null ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
      },
      body
    });
    const { text, truncated } = await readBounded(response);
    return { status: response.status, location: response.headers.get('location') || '', text, truncated, cookie: cookieFrom(response) };
  } finally {
    clearTimeout(timer);
  }
}

/** Does this cookie still hold a signed-in session? */
async function sessionWorks(baseUrl, cookie) {
  const res = await request(baseUrl, '/dashboard', { cookie, headers: { Accept: 'text/html' } });
  return res.status === 200;
}

/**
 * Sign the QA account for `role` in through the real form. Returns `{ cookie }` or
 * `{ error }` — a role that cannot sign in fails its cases with this reason rather than
 * quietly running them as a visitor.
 */
async function signIn(baseUrl, role, password) {
  const cached = sessionCache.get(role);
  if (cached && (await sessionWorks(baseUrl, cached))) return { cookie: cached };
  sessionCache.delete(role);

  const form = await request(baseUrl, '/auth/login', { headers: { Accept: 'text/html' } });
  const token = /name="_csrf" value="([^"]+)"/.exec(form.text);
  if (form.status !== 200 || !token || !form.cookie) {
    return {
      error: form.cookie
        ? `The login form answered ${form.status} without a CSRF token.`
        : 'The login form set no session cookie. In production APP_BASE_URL must be the https address: the cookie is Secure and is not issued over http.'
    };
  }

  const body = new URLSearchParams({ email: qaEmail(role), password, _csrf: token[1] }).toString();
  const login = await request(baseUrl, '/auth/login', { method: 'POST', cookie: form.cookie, headers: { Accept: 'text/html' }, body });
  const landed = locationPath(login.location, baseUrl);
  if (login.status !== 302 || /^\/auth\/login/.test(landed)) {
    return { error: `Signing in as the QA ${role} answered ${login.status}${landed ? ` → ${landed}` : ''}${login.status === 429 ? ' (the login rate limit; wait ten minutes)' : ''}.` };
  }
  const cookie = login.cookie || form.cookie;
  if (!(await sessionWorks(baseUrl, cookie))) {
    return { error: `The QA ${role} signed in but the session cookie was not accepted on the next request.` };
  }
  sessionCache.set(role, cookie);
  return { cookie };
}

async function runOne(baseUrl, testCase, cookie) {
  const started = Date.now();
  const isPost = testCase.method === 'POST';
  try {
    const res = await request(baseUrl, testCase.endpoint, {
      method: testCase.method,
      headers: headersFor(testCase),
      // A POST is sent with no session at all, and so with no CSRF token: the layer refuses
      // it before any handler runs, which is the whole of what such a case may assert.
      cookie: isPost ? null : cookie,
      body: isPost ? '' : null,
      timeoutMs: testCase.timeoutMs
    });
    const errors = evaluate(testCase, res, baseUrl);
    return {
      outcome: errors.length ? 'failed' : 'passed',
      statusCode: res.status,
      error: errors.join('; ') || null,
      excerpt: errors.length ? excerptOf(res.text) : null,
      durationMs: Date.now() - started
    };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    return {
      outcome: 'failed',
      statusCode: null,
      error: timedOut ? `Timed out after ${testCase.timeoutMs} ms` : `Request failed: ${err.cause ? err.cause.code || err.cause.message : err.message}`,
      excerpt: null,
      durationMs: Date.now() - started
    };
  }
}

/**
 * Run every enabled case, or one category's, and record each outcome under one run id.
 * Sequential on purpose: this is an administrator pressing a button, not a load test, and
 * thirty requests at once would make "the app fell over under its own test" look like a
 * finding.
 */
async function runSuite({ category = null, runBy = null, baseUrl = config.app.baseUrl, env = process.env } = {}) {
  const runId = crypto.randomUUID();
  const cases = await AdminTestCase.list({ enabledOnly: true, category });
  const password = qaPassword(env);
  const skipReason = qaUnavailableReason(env);

  const roles = [...new Set(cases.filter((c) => c.authRole).map((c) => c.authRole))];
  const sessions = {};
  if (!password) {
    await QaAccount.deactivateAll();
    sessionCache.clear();
  } else {
    for (const role of roles) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await QaAccount.ensure(role, password);
        // eslint-disable-next-line no-await-in-loop
        sessions[role] = await signIn(baseUrl, role, password);
      } catch (err) {
        sessions[role] = { error: `Could not prepare the QA ${role}: ${err.message}` };
      }
    }
  }

  const rows = [];
  for (const testCase of cases) {
    const base = {
      testCaseId: testCase.id,
      category: testCase.category,
      name: testCase.name,
      method: testCase.method,
      endpoint: testCase.endpoint,
      authRole: testCase.authRole,
      expectedStatus: statusList(testCase.expectedStatus)
    };
    const problems = caseSafetyProblems(testCase);
    let result;
    if (problems.length) {
      result = { outcome: 'failed', statusCode: null, durationMs: 0, error: `Refused to run: ${problems.join('; ')}` };
    } else if (testCase.authRole && !password) {
      result = { outcome: 'skipped', statusCode: null, durationMs: 0, error: skipReason };
    } else if (testCase.authRole && sessions[testCase.authRole].error) {
      result = { outcome: 'failed', statusCode: null, durationMs: 0, error: sessions[testCase.authRole].error };
    } else {
      // eslint-disable-next-line no-await-in-loop
      result = await runOne(baseUrl, testCase, testCase.authRole ? sessions[testCase.authRole].cookie : null);
    }
    rows.push({ ...base, ...result });
  }

  await AdminTestCase.recordResults(runId, runBy, rows);
  // Copied to the error log the way the reference does, so a regression is visible where
  // the rest of the site's failures are read — under its own source, never through the
  // error handler, so the CSRF-scanner filter cannot swallow it.
  for (const row of rows.filter((r) => r.outcome === 'failed')) {
    // eslint-disable-next-line no-await-in-loop
    await ErrorLog.recordTestFailure({ runId, runBy, ...row });
  }

  return {
    runId,
    total: rows.length,
    passed: rows.filter((r) => r.outcome === 'passed').length,
    failed: rows.filter((r) => r.outcome === 'failed').length,
    skipped: rows.filter((r) => r.outcome === 'skipped').length,
    skipReason: password ? null : skipReason
  };
}

module.exports = { runSuite, evaluate, excerptOf, readBounded, urlFor, locationPath, MAX_BODY_BYTES };
