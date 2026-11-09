'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const {
  TEST_SUITE,
  COVERAGE_EXEMPT,
  assertTestSuiteIntegrity,
  normaliseCase,
  caseSafetyProblems,
  statusList,
  headersFor,
  coveredPaths
} = require('../../config/adminTests');
const { evaluate, urlFor, readBounded, excerptOf, MAX_BODY_BYTES } = require('../../utils/adminTestRunner');
const qa = require('../../utils/qaAccounts');

/*
 * WHY THIS FILE EXISTS.
 *
 * The panel makes real HTTP requests from a web route, signed in as accounts whose password
 * is an environment variable, and its cases now live in a table a superadmin can add to.
 * Each of those is a shape worth watching: a case naming another host is a request-forgery
 * primitive with the server's network position, a case that POSTs as a signed-in account is
 * a write with that account's standing, and a QA account that shows up in public is the site
 * publishing its own test harness. These assertions pin the properties that keep all three
 * from happening, and the coverage test at the bottom keeps the suite honest as pages are
 * added.
 */
const safe = (raw) => caseSafetyProblems(normaliseCase({ name: 'n', category: 'c', ...raw }));

describe('the safety rule every case passes', () => {
  test('a GET of a path on this site is fine', () => {
    expect(safe({ endpoint: '/jobs', expectedStatus: 200 })).toEqual([]);
    expect(safe({ endpoint: '/dashboard', expectedStatus: '200', authRole: 'consultant' })).toEqual([]);
  });

  test('anything that is not a path on this site is refused', () => {
    ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'jobs', '', '/a b', '/x\nHost: y']
      .forEach((endpoint) => expect(safe({ endpoint, expectedStatus: 200 }).join(' ')).toMatch(/path on this site/));
  });

  test('the runner refuses to build a URL for another host, whatever reached it', () => {
    expect(urlFor('http://localhost:3000', '/jobs').href).toBe('http://localhost:3000/jobs');
    expect(() => urlFor('http://localhost:3000', '@evil.example/')).toThrow(/another host/);
  });

  test('a POST is only the tokenless refusal, as a visitor, with no body', () => {
    // The one POST shape allowed: the CSRF layer refuses it before any handler runs.
    expect(safe({ endpoint: '/auth/login', method: 'POST', expectedStatus: 302 })).toEqual([]);
    expect(safe({ endpoint: '/report-issue', method: 'POST', expectedStatus: 403, api: true })).toEqual([]);

    expect(safe({ endpoint: '/auth/login', method: 'POST', expectedStatus: 200 }).join(' ')).toMatch(/CSRF refusal/);
    expect(safe({ endpoint: '/profile/settings', method: 'POST', expectedStatus: 302, authRole: 'consultant' }).join(' ')).toMatch(/visitor only/);
    expect(safe({ endpoint: '/auth/login', method: 'POST', expectedStatus: 302, body: { email: 'a@b.c' } }).join(' ')).toMatch(/no body/);
    expect(safe({ endpoint: '/payments/webhook', method: 'POST', expectedStatus: 302 }).join(' ')).toMatch(/webhook/);
  });

  test('a POST may not name a route that deletes, erases, pays or sends', () => {
    ['/admin/users/5/erase', '/admin/errors/delete-matching', '/payments/checkout/feature', '/auth/forgot-password', '/crm/import', '/auth/logout']
      .forEach((endpoint) => expect(safe({ endpoint, method: 'POST', expectedStatus: 302 }).join(' ')).toMatch(/deleting, paying/));
  });

  test('PUT, PATCH and DELETE do not exist here', () => {
    ['PUT', 'PATCH', 'DELETE'].forEach((method) => expect(safe({ endpoint: '/x', method, expectedStatus: 302 }).join(' ')).toMatch(/method/));
  });

  test('a case cannot carry a session, a token or a forged proxy header', () => {
    ['Cookie', 'X-CSRF-Token', 'X-Forwarded-Proto', 'Authorization', 'Host'].forEach((name) => {
      expect(safe({ endpoint: '/x', expectedStatus: 200, headers: { [name]: 'v' } }).join(' ')).toMatch(/not one a case may send/);
    });
    // And the runner drops one that got into the table some other way.
    expect(headersFor({ headers: { Cookie: 'sfhub.sid=stolen', Accept: 'application/json' } })).toEqual({ Accept: 'application/json' });
  });

  test('there is no superadmin role to sign in as', () => {
    expect(safe({ endpoint: '/x', expectedStatus: 200, authRole: 'superadmin' }).join(' ')).toMatch(/role must be one of/);
  });

  test('expected status takes one code or a list, and nothing else', () => {
    expect(statusList(200)).toEqual([200]);
    expect(statusList('200,404')).toEqual([200, 404]);
    expect(statusList('[200, 404]')).toEqual([200, 404]);
    expect(statusList([302, 403])).toEqual([302, 403]);
    expect(statusList('200,abc')).toEqual([]);
    expect(statusList('99')).toEqual([]);
  });
});

describe('the built-in suite', () => {
  const cases = TEST_SUITE.map(normaliseCase);

  test('passes the boot assertion, which runs the safety rule on every case', () => {
    expect(() => assertTestSuiteIntegrity()).not.toThrow();
    expect(cases.length).toBeGreaterThan(150);
  });

  test('every POST is a visitor expecting the refusal', () => {
    const posts = cases.filter((c) => c.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    posts.forEach((c) => {
      expect(c.authRole).toBeNull();
      expect(c.expectedStatus.every((s) => [302, 403].includes(s))).toBe(true);
    });
  });

  test('covers both halves of the auth convention, and every role', () => {
    // 302 to a navigation, 401 to a background fetch — CLAUDE.md "Auth and roles".
    expect(cases.some((c) => c.expectedStatus.includes(302) && c.expectedRedirect === '/auth/login' && !c.authRole)).toBe(true);
    expect(cases.some((c) => c.expectedStatus.includes(401) && c.headers && c.headers['Sec-Fetch-Dest'] === 'empty')).toBe(true);
    qa.QA_ROLES.forEach((role) => expect(cases.some((c) => c.authRole === role && c.expectedStatus.includes(200))).toBe(true));
  });

  test('checks the 404 page, the prototype-key page and the sales-agent redirect', () => {
    expect(cases.some((c) => c.endpoint === '/this-page-does-not-exist' && c.expectedStatus.includes(404))).toBe(true);
    expect(cases.some((c) => c.endpoint === '/services/constructor' && c.expectedStatus.includes(404))).toBe(true);
    expect(cases.some((c) => c.endpoint.startsWith('/s/') && c.expectedRedirect === '/auth/register')).toBe(true);
  });

  test('checks that the public directories list no QA account', () => {
    ['/consultants', '/companies', '/recruiters'].forEach((p) => {
      expect(cases.some((c) => c.endpoint === p && !c.authRole && c.expectedNotContains.includes('@salesforcehub.test'))).toBe(true);
    });
  });

  test('does not test the dedupe page, which this application excludes', () => {
    expect(JSON.stringify(TEST_SUITE)).not.toMatch(/dedupe/i);
  });
});

describe('evaluating a response', () => {
  const base = { expectedStatus: [302], expectedRedirect: '/auth/login', expectedContains: [], expectedNotContains: [] };

  test('a redirect matches exactly or with a query string, absolute or relative', () => {
    expect(evaluate(base, { status: 302, location: '/auth/login?redirect=%2Fdashboard', text: '' }, 'http://h')).toEqual([]);
    expect(evaluate(base, { status: 302, location: 'http://h/auth/login', text: '' }, 'http://h')).toEqual([]);
    expect(evaluate(base, { status: 302, location: '/auth/login-elsewhere', text: '' }, 'http://h').join(' ')).toMatch(/redirect/);
    expect(evaluate(base, { status: 302, location: 'http://other/auth/login', text: '' }, 'http://h').join(' ')).toMatch(/redirect/);
  });

  test('status lists, contained and absent strings', () => {
    const c = { expectedStatus: [200, 404], expectedContains: ['Jobs'], expectedNotContains: ['QA Consultant'] };
    expect(evaluate(c, { status: 404, location: '', text: 'Jobs' })).toEqual([]);
    expect(evaluate(c, { status: 500, location: '', text: 'Jobs' }).join(' ')).toMatch(/Expected status 200 or 404, got 500/);
    expect(evaluate(c, { status: 200, location: '', text: 'QA Consultant' }).join(' ')).toMatch(/contain "Jobs".*NOT contain/);
  });

  test('a body is read only up to the cap', async () => {
    const big = new Response('x'.repeat(MAX_BODY_BYTES * 3));
    const { text, truncated } = await readBounded(big);
    expect(text.length).toBe(MAX_BODY_BYTES);
    expect(truncated).toBe(true);
  });

  test('an excerpt is the visible text, not the head', () => {
    const html = '<html><head><title>T</title><style>.a{}</style></head><body><main><h1>Oops</h1><script>x()</script><p>Broken &amp; sorry</p></main></body></html>';
    expect(excerptOf(html)).toBe('Oops Broken & sorry');
  });
});

describe('the runner', () => {
  const source = read('utils/adminTestRunner.js');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  test('requests its own base URL, sequentially, without following redirects', () => {
    expect(code).toMatch(/baseUrl = config\.app\.baseUrl/);
    expect(code).toMatch(/redirect: 'manual'/);
    expect(code).not.toMatch(/Promise\.all/);
    // Nothing from a request reaches it.
    expect(code).not.toMatch(/req\.|\.query\b/);
  });

  test('never forges X-Forwarded-Proto', () => {
    // The reference sends it so its secure cookie is issued over loopback. Here an http base
    // URL in production must fail at sign-in, loudly, rather than look healthy.
    expect(code).not.toMatch(/X-Forwarded-Proto/i);
  });

  test('signs in through the real form, with the token the form carried', () => {
    expect(code).toMatch(/request\(baseUrl, '\/auth\/login'/);
    expect(code).toMatch(/name="_csrf" value=/);
    expect(code).toMatch(/_csrf: token\[1\]/);
  });

  test('a POST case is sent with no session, so with no token', () => {
    expect(code).toMatch(/cookie: isPost \? null : cookie/);
  });

  test('skips, never passes, a signed-in case without the QA password, and switches the accounts off', () => {
    expect(code).toMatch(/outcome: 'skipped'/);
    expect(code).toMatch(/QaAccount\.deactivateAll\(\)/);
  });

  test('re-checks every case against the safety rule just before it runs', () => {
    expect(code).toMatch(/caseSafetyProblems\(testCase\)/);
    expect(code).toMatch(/Refused to run/);
  });

  test('copies failures to the error log under their own source', () => {
    expect(code).toMatch(/ErrorLog\.recordTestFailure/);
  });
});

describe('QA accounts', () => {
  test('live on the reserved .test domain', () => {
    expect(qa.qaEmail('admin')).toBe('qa-admin@salesforcehub.test');
    expect(() => qa.qaEmail('superadmin')).toThrow();
    expect(qa.isQaEmail('QA-Company@SalesforceHub.test')).toBe(true);
    expect(qa.isQaEmail('qa-company@salesforcehub.test.example.com')).toBe(false);
    expect(qa.isReservedTestAddress('someone@anything.test')).toBe(true);
    expect(qa.isReservedTestAddress('someone@example.com')).toBe(false);
  });

  test('are opt-in, and a short password counts as none', () => {
    expect(qa.qaPassword({})).toBeNull();
    expect(qa.qaPassword({ QA_TEST_PASSWORD: 'short' })).toBeNull();
    expect(qa.qaUnavailableReason({ QA_TEST_PASSWORD: 'short' })).toMatch(/shorter than/);
    expect(qa.qaPassword({ QA_TEST_PASSWORD: 'long-enough-password' })).toBe('long-enough-password');
    expect(qa.qaUnavailableReason({ QA_TEST_PASSWORD: 'long-enough-password' })).toBeNull();
  });

  test('the QA admin is a plain admin, and every repair says so', async () => {
    const { promisePool } = require('../../config/database');
    const User = require('../../models/User');
    const ConsultantProfile = require('../../models/ConsultantProfile');
    const QaAccount = require('../../models/QaAccount');
    expect(QaAccount.FLAGS.admin.user_type).toBe('admin');

    const row = { id: 7, email: 'qa-admin@salesforcehub.test', is_superadmin: 1 };
    jest.spyOn(User, 'findByEmail').mockResolvedValue(row);
    jest.spyOn(User, 'verifyPassword').mockResolvedValue(true);
    jest.spyOn(User, 'findById').mockResolvedValue(row);
    jest.spyOn(ConsultantProfile, 'ensureExists').mockResolvedValue({});
    const spy = jest.spyOn(promisePool, 'query').mockResolvedValue([{ affectedRows: 1 }]);
    await QaAccount.ensure('admin', 'long-enough-password');
    const repair = spy.mock.calls.find(([sql]) => /UPDATE users/.test(sql));
    expect(repair[0]).toMatch(/is_superadmin = 0/);
    expect(repair[0]).toMatch(/email_verified = 1/);
    expect(repair[0]).toMatch(/is_active = 1/);
    jest.restoreAllMocks();
  });

  test('the company profile is created hidden, and never by upsert on its slug', () => {
    const source = read('models/QaAccount.js');
    expect(source).toMatch(/INSERT INTO company_profiles \(user_id, company_name, slug, is_public\) VALUES \(\?, \?, \?, 0\)/);
    expect(source).toMatch(/UPDATE consultant_profiles SET is_public = 0/);
    expect(source.replace(/\/\/.*$/gm, '')).not.toMatch(/ON DUPLICATE KEY/);
  });

  test('no email is sent to a .test address', async () => {
    const email = require('../../utils/email');
    const result = await email.send({ to: 'qa-consultant@salesforcehub.test', subject: 's', template: 'does-not-exist' });
    expect(result).toEqual({ delivered: false, reason: 'reserved-test-address' });
  });

  test('are never measured as visitors, signed in or not', () => {
    const { isOwnTraffic } = require('../../middleware/visitGeo');
    const req = (user, ua = 'Mozilla/5.0') => ({ path: '/jobs', session: { user }, get: (h) => (h === 'user-agent' ? ua : undefined) });
    expect(isOwnTraffic(req({ email: 'qa-company@salesforcehub.test', isAdmin: false }))).toBe(true);
    expect(isOwnTraffic(req(null, qa.SELF_TEST_USER_AGENT))).toBe(true);
    expect(isOwnTraffic(req({ email: 'someone@example.com', isAdmin: false }))).toBe(false);
    const { looksLikeAPerson } = require('../../middleware/visitGeo');
    expect(looksLikeAPerson(qa.SELF_TEST_USER_AGENT)).toBe(false);
  });

  test('are left out of the counts that describe real people', () => {
    expect(read('routes/index.js')).toMatch(/created_at > DATE_SUB\(NOW\(\), INTERVAL 7 DAY\) AND email NOT LIKE \?/);
    expect(read('models/SalesAgent.js')).toMatch(/u\.sales_agent_id IS NULL AND u\.email NOT LIKE \?/);
    expect(read('models/SiteStats.js')).toMatch(/email NOT LIKE \?/);
    const overview = read('routes/admin.js');
    expect(overview).toMatch(/FROM users WHERE email NOT LIKE \?\)\s+AS users/);
  });
});

describe('the panel route', () => {
  const source = read('routes/admin.js');
  const panel = source.slice(source.indexOf('THE AUTOMATED-TESTING PANEL'));

  test('inherits the admin guard rather than declaring its own', () => {
    expect(source).toMatch(/router\.use\(isAuthenticated, isAdmin\)/);
  });

  test('adding, switching off and deleting are superadmin; running and rebuilding are admin', () => {
    ['add', ':id/toggle', ':id/delete'].forEach((p) => {
      expect(panel).toMatch(new RegExp(`router\\.post\\(\\s*'/tests/${p.replace(/[/:]/g, (m) => `\\${m}`)}',\\s*isSuperadmin,`));
    });
    ['run', 'run-category', 'rebuild'].forEach((p) => {
      expect(panel).toMatch(new RegExp(`router\\.post\\(\\s*'/tests/${p}',\\s*writeLimiter,`));
    });
    expect(panel).toMatch(/'\/tests\/:id\/toggle',\s*isSuperadmin,\s*requireIdParam\('id'\)/);
    expect(panel).toMatch(/'\/tests\/:id\/delete',\s*isSuperadmin,\s*requireIdParam\('id'\)/);
  });

  test('a built-in case is not deleted from the screen', () => {
    expect(panel).toMatch(/testCase\.isBuiltin\) \{\s*req\.flash\('error'/);
  });

  test('the add form is read by named field, never by spreading the body', () => {
    const add = panel.slice(panel.indexOf("'/tests/add'"), panel.indexOf("'/tests/:id/toggle'"));
    expect(add).not.toMatch(/\.\.\.req\.body|\.\.\.b\b/);
  });

  test('a category comes from the stored cases, and an unknown one is refused', () => {
    expect(panel).toMatch(/categories\.find\(\(c\) => c === req\.body\.category\)/);
    expect(panel).toMatch(/Unknown test category/);
  });

  test('a run page is reached only by a well-formed run id, checked before SQL', () => {
    const at = panel.indexOf("'/tests/runs/:runId'");
    expect(at).toBeGreaterThan(-1);
    expect(panel.slice(at, at + 300)).toMatch(/RUN_ID_RE\.test\(req\.params\.runId\) \?/);
  });
});

describe('rebuilding the suite', () => {
  test('replaces only built-in rows and keeps custom ones', () => {
    // The reference drops both tables. Here the delete is bounded to rows with a key the
    // code no longer has, so a custom case and every past result survive a rebuild.
    const source = read('models/AdminTestCase.js');
    expect(source).toMatch(/DELETE FROM admin_test_cases WHERE builtin_key IS NOT NULL AND builtin_key NOT IN \(\?\)/);
    expect(source).not.toMatch(/DROP TABLE|TRUNCATE/);
    expect(read('scripts/migrations/042_admin_test_cases.sql')).toMatch(/REFERENCES admin_test_cases \(id\) ON DELETE SET NULL/);
  });

  test('refuses a suite with an unsafe case before writing anything', async () => {
    const AdminTestCase = require('../../models/AdminTestCase');
    await expect(AdminTestCase.rebuildBuiltins([{ name: 'n', category: 'c', endpoint: 'https://evil.example/', expectedStatus: 200 }]))
      .rejects.toMatchObject({ code: 'TEST_CASE_UNSAFE' });
  });
});

describe('the error log', () => {
  test('a test failure is written with its own source, past the scanner filter', async () => {
    const { promisePool } = require('../../config/database');
    const ErrorLog = require('../../models/ErrorLog');
    const spy = jest.spyOn(promisePool, 'query').mockResolvedValue([{}]);
    await ErrorLog.recordTestFailure({ runId: 'r', name: 'Jobs', category: 'Public', method: 'GET', endpoint: '/jobs', statusCode: 500, error: 'Expected 200' });
    expect(spy.mock.calls[0][0]).toMatch(/VALUES \('self_test'/);
    spy.mockRestore();
    expect(ErrorLog.buildFilter({ source: 'self_test' })).toEqual({ clause: 'source = ?', params: ['self_test'] });
    expect(ErrorLog.buildFilter({ source: 'anything' }).clause).toBe('1 = 1');
  });
});

describe('the panel views', () => {
  test('every mutating form carries a CSRF token', () => {
    ['views/admin/tests.ejs', 'views/admin/errors.ejs'].forEach((file) => {
      const forms = read(file).match(/<form[^>]*method="post"[\s\S]*?<\/form>/g) || [];
      expect(forms.length).toBeGreaterThan(0);
      forms.forEach((form) => expect(form).toContain('_csrf'));
    });
  });

  test('a skipped case is shown as skipped, never folded into passed', () => {
    const run = read('views/admin/test-run.ejs');
    expect(run).toMatch(/skipped, not passed/);
    expect(read('views/admin/tests.ejs')).toMatch(/will be skipped/);
  });

  test('the add form is shown only to a superadmin', () => {
    expect(read('views/admin/tests.ejs')).toMatch(/<% if \(!isSuper\) \{ %>[\s\S]*?is for a superadmin[\s\S]*?action="\/admin\/tests\/add"/);
  });
});

/*
 * COVERAGE: a page cannot ship without a case.
 *
 * Walks the routers exactly as server.js mounts them — read from server.js itself, so a
 * newly mounted router is walked without anyone editing this test — and fails for every GET
 * route with no path parameter that no built-in case requests. The same walk finds every
 * route behind `isSuperadmin` and requires a case proving the plain QA admin is refused it.
 */
function mountedRouters() {
  const server = read('server.js');
  const mounts = [...server.matchAll(/app\.use\('([^']+)',\s*require\('\.\/routes\/([^']+)'\)\)/g)];
  return mounts.map(([, prefix, file]) => ({ prefix: prefix === '/' ? '' : prefix, router: require(path.join(ROOT, 'routes', file)) }));
}

function getRoutes() {
  const out = [];
  mountedRouters().forEach(({ prefix, router }) => {
    let routerSuper = false;
    router.stack.forEach((layer) => {
      if (!layer.route) {
        if (layer.handle && layer.handle.name === 'isSuperadmin') routerSuper = true;
        return;
      }
      if (!layer.route.methods.get) return;
      const routeSuper = routerSuper || layer.route.stack.some((l) => l.handle && l.handle.name === 'isSuperadmin');
      [].concat(layer.route.path).forEach((p) => {
        if (typeof p !== 'string') return;
        const full = prefix + (p === '/' && prefix ? '' : p) || '/';
        out.push({ path: full, superOnly: routeSuper });
      });
    });
  });
  return out;
}

describe('coverage: every page has a built-in case', () => {
  const routes = getRoutes().filter((r) => !r.path.includes(':') && !r.path.includes('*'));
  const covered = coveredPaths();

  test('the walk found the application', () => {
    // An empty walk would pass every assertion below silently.
    expect(routes.length).toBeGreaterThan(80);
    expect(routes.some((r) => r.path === '/admin/tests')).toBe(true);
  });

  test('every GET route with no path parameter is requested by the suite', () => {
    const missing = routes.map((r) => r.path).filter((p) => !covered.has(p) && !Object.prototype.hasOwnProperty.call(COVERAGE_EXEMPT, p));
    expect(missing).toEqual([]);
  });

  test('every exemption names a route that exists and says why', () => {
    Object.entries(COVERAGE_EXEMPT).forEach(([p, reason]) => {
      expect(routes.some((r) => r.path === p)).toBe(true);
      expect(String(reason).length).toBeGreaterThan(20);
    });
  });

  test('every superadmin-only page refuses the plain QA admin', () => {
    const refusals = new Set(
      TEST_SUITE.map(normaliseCase).filter((c) => c.authRole === 'admin' && c.expectedStatus.includes(302) && c.expectedRedirect === '/').map((c) => c.endpoint)
    );
    const missing = routes.filter((r) => r.superOnly).map((r) => r.path).filter((p) => !refusals.has(p));
    expect(missing).toEqual([]);
  });

  test('no built-in case requests a path the application does not have, except on purpose', () => {
    const { routeExists } = require('../../utils/routeExists');
    const express = require('express');
    const app = express();
    mountedRouters().forEach(({ prefix, router }) => app.use(prefix || '/', router));
    // /tax-advisory is the tax page's old address: a 301 mounted directly in server.js with
    // app.use, not a router, so this test's app never sees it. Its case asserts the redirect.
    const deliberate = new Set(['/this-page-does-not-exist', '/services/not-a-real-service', '/services/constructor', '/tax-advisory']);
    const strays = TEST_SUITE.map(normaliseCase)
      .filter((c) => c.method === 'GET' && !deliberate.has(c.endpoint.split('?')[0]))
      .filter((c) => !routeExists(app, 'GET', c.endpoint.split('?')[0]))
      .map((c) => c.endpoint);
    expect(strays).toEqual([]);
  });
});
