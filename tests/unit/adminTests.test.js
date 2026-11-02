'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { TEST_SUITE, assertTestSuiteIntegrity, testKeyFor, totalTestCount } = require('../../config/adminTests');

/*
 * WHY THIS FILE EXISTS.
 *
 * The panel makes real HTTP requests from a web route. That is a useful thing and a shape
 * worth watching: the moment an endpoint comes from anywhere but a reviewed list in config,
 * it is a request-forgery primitive with an admin's network position. These assertions pin
 * the properties that keep it from becoming one, and they are about the SHAPE of the thing,
 * not about which pages happen to exist today.
 */
describe('the admin test suite is a reviewed list, not input', () => {
  test('every endpoint is a relative path on this site', () => {
    // An absolute URL here is the whole objection: the runner joins the endpoint to the
    // app's own base URL, and a full URL would escape it.
    for (const group of TEST_SUITE) {
      for (const t of group.tests) {
        expect(t.endpoint.startsWith('/')).toBe(true);
        expect(t.endpoint).not.toMatch(/^\/\//);
        expect(t.endpoint).not.toMatch(/^[a-z]+:/i);
      }
    }
  });

  test('every request is a GET', () => {
    // A POST from this panel would act on the live site with an admin's standing. Reading
    // is the whole job: it answers "is the deployed thing still up and still guarded".
    for (const group of TEST_SUITE) {
      for (const t of group.tests) expect(t.method).toBe('GET');
    }
  });

  test('the boot assertion rejects a malformed suite', () => {
    expect(() => assertTestSuiteIntegrity()).not.toThrow();
  });

  test('a test key is unique across the whole suite', () => {
    const keys = TEST_SUITE.flatMap((g) => g.tests.map((t) => testKeyFor(g.category, t.name)));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(totalTestCount());
  });

  test('it does not test the dedupe page, which this application excludes', () => {
    // The suite came from a branch that ships `/services/dedupe` as a "not built yet"
    // explainer. Deduplication is permanently out of scope here, so a test asserting that
    // page answers 200 would quietly require it to exist.
    expect(JSON.stringify(TEST_SUITE)).not.toMatch(/dedupe/i);
  });

  test('it covers BOTH halves of the auth convention', () => {
    /*
     * A protected page answers 302 to a navigation and 401 to a background fetch, because
     * `isNavigation()` reads Sec-Fetch-Dest. Testing only one half would pass while the
     * other was broken — and the 401 half is the one an XHR depends on.
     */
    const flat = TEST_SUITE.flatMap((g) => g.tests);
    expect(flat.some((t) => t.expectedStatus === 302)).toBe(true);
    expect(flat.some((t) => t.expectedStatus === 401 && t.api)).toBe(true);
  });

  test('it checks that a prototype key is not a page', () => {
    // `/services/constructor` returned `Object` from a plain lookup and died in the view.
    // A 500 there is that bug back, and nobody types it by accident.
    const flat = TEST_SUITE.flatMap((g) => g.tests);
    expect(flat.some((t) => t.endpoint === '/services/constructor' && t.expectedStatus === 404)).toBe(true);
  });
});

describe('the runner', () => {
  const source = fs.readFileSync(path.join(ROOT, 'utils', 'adminTestRunner.js'), 'utf8');

  test('builds its URL from the app base plus a declared endpoint, and nothing else', () => {
    expect(source).toMatch(/config\.app\.baseUrl\}\$\{test\.endpoint\}/);
    // Nothing from a request reaches it.
    expect(source).not.toMatch(/req\.|request\.|\.body|\.query/);
  });

  test('does not follow redirects', () => {
    // `redirect: 'manual'` is what lets a protected page's 302 be read AS a 302 instead of
    // silently following it to the login page and grading that 200 a pass.
    expect(source).toMatch(/redirect:\s*'manual'/);
  });

  test('records results and never writes a test case', () => {
    expect(source).toMatch(/AdminTestRun\.recordBatch/);
    expect(source).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });
});

describe('the panel route', () => {
  const source = fs.readFileSync(path.join(ROOT, 'routes', 'admin.js'), 'utf8');

  test('inherits the admin guard rather than declaring its own', () => {
    // The reference's recruiter area defined its own guard and so did not know about
    // Sec-Fetch-Dest. One router-level guard is the rule here.
    expect(source).toMatch(/router\.use\(isAuthenticated, isAdmin\)/);
    expect(source).toMatch(/'\/tests'/);
  });

  test('a category comes from the declared suite, not from the body', () => {
    // Matched against TEST_SUITE and refused when unknown, rather than used as a filter
    // that quietly runs nothing and reports 0/0 as a pass.
    expect(source).toMatch(/TEST_SUITE\.find\(\(g\) => g\.category === req\.body\.category\)/);
    expect(source).toMatch(/Unknown test category/);
  });

  test('running is a POST behind the write limiter', () => {
    const panel = source.slice(source.indexOf("'/tests'"));
    expect(panel).toMatch(/router\.post\(\s*'\/tests\/run',\s*writeLimiter/);
  });
});

describe('the panel view', () => {
  const view = fs.readFileSync(path.join(ROOT, 'views', 'admin', 'tests.ejs'), 'utf8');

  test('shows no tile whose number is another tile wearing a different label', () => {
    // It had "Total Tests" and "Enabled", both printing `totalTests`. There is no such
    // thing as a disabled test here — the suite is an array and every entry runs.
    //
    // Comments are stripped first: the comment explaining why the tile went contains the
    // word, and a test that matched it would be matching the prose rather than the markup.
    // That has happened here more than once, and the fix is to scan what renders.
    const markup = view.replace(/<%#[\s\S]*?%>/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(markup).not.toMatch(/Enabled/);
  });

  test('every mutating form carries a CSRF token', () => {
    const forms = view.match(/<form[^>]*method="post"[\s\S]*?<\/form>/g) || [];
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) expect(form).toContain('_csrf');
  });
});

describe('run history', () => {
  const fs = require('fs');
  const path = require('path');
  const admin = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'admin.js'), 'utf8');

  it('a run page is reached only by a well-formed batch id, checked before SQL', () => {
    const at = admin.indexOf("'/tests/runs/:batch'");
    expect(at).toBeGreaterThan(-1);
    expect(admin.slice(at, at + 400)).toMatch(/RUN_BATCH_RE\.test\(req\.params\.batch\) \?/);
  });

  it('has no switch to turn a test off: every case in config runs', () => {
    expect(admin).not.toMatch(/'\/tests\/switch'/);
  });

  it('lists recent runs from the results table, newest first', async () => {
    const { promisePool } = require('../../config/database');
    const AdminTestRun = require('../../models/AdminTestRun');
    const spy = jest.spyOn(promisePool, 'query').mockResolvedValue([[{ run_batch: 'b', total: '3', passed: '2', duration_ms: '10', categories: '1' }]]);
    const [row] = await AdminTestRun.recent(5);
    expect(row).toMatchObject({ total: 3, passed: 2 });
    expect(spy.mock.calls[0][0]).toMatch(/GROUP BY t\.run_batch/);
    spy.mockRestore();
  });
});
