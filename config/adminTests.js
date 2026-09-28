'use strict';

/**
 * The automated-testing suite the admin panel runs. Deliberately code, not a database
 * table an administrator edits through a form — see the comment at the top of migration
 * 027 for why. Grouped by category, same shape the admin page renders.
 *
 * Every test hits a real Salesforce Hub route. `expectedStatus` is what the server
 * actually answers today, verified against the live app rather than guessed:
 *
 *  - A protected page requested the way a BROWSER requests it (no Accept override) is a
 *    302 to the login page — `isNavigation()` in middleware/auth.js treats a request with
 *    no Sec-Fetch-Dest header as a navigation when it accepts html, which is what this
 *    suite's runner sends by default.
 *  - The same page requested with `Accept: application/json` (`api: true` below) is
 *    treated as a background fetch and answers 401 JSON instead — the exact distinction
 *    CLAUDE.md's Auth and roles section documents, and the reason both styles are tested.
 */
const TEST_SUITE = [
  {
    category: 'Public Pages',
    tests: [
      { name: 'Homepage Loads', method: 'GET', endpoint: '/', expectedStatus: 200 },
      { name: 'Jobs Board Loads', method: 'GET', endpoint: '/jobs', expectedStatus: 200 },
      { name: 'Consultants Directory Loads', method: 'GET', endpoint: '/consultants', expectedStatus: 200 },
      { name: 'Companies Directory Loads', method: 'GET', endpoint: '/companies', expectedStatus: 200 },
      { name: 'Recruiters Directory Loads', method: 'GET', endpoint: '/recruiters', expectedStatus: 200 },
      { name: 'Rate Index Loads', method: 'GET', endpoint: '/rates', expectedStatus: 200 },
      { name: 'Success Stories Loads', method: 'GET', endpoint: '/success-stories', expectedStatus: 200 },
      { name: 'FAQ Loads', method: 'GET', endpoint: '/faq', expectedStatus: 200 },
      { name: 'Tax Advisory Loads', method: 'GET', endpoint: '/tax-advisory', expectedStatus: 200 }
    ]
  },
  {
    category: 'Services Pages',
    tests: [
      { name: 'Staff Augmentation Loads', method: 'GET', endpoint: '/services/staff-augmentation', expectedStatus: 200 },
      { name: 'Project-Based Loads', method: 'GET', endpoint: '/services/project-based', expectedStatus: 200 },
      { name: 'Managed Services Loads', method: 'GET', endpoint: '/services/managed-services', expectedStatus: 200 },
      { name: 'Document Generator Loads', method: 'GET', endpoint: '/services/document-generator', expectedStatus: 200 },
      { name: 'Dedupe Explainer Loads', method: 'GET', endpoint: '/services/dedupe', expectedStatus: 200 },
      { name: 'Unknown Service Slug 404s', method: 'GET', endpoint: '/services/not-a-real-service', expectedStatus: 404 }
    ]
  },
  {
    category: 'Auth Pages',
    tests: [
      { name: 'Login Page Loads', method: 'GET', endpoint: '/auth/login', expectedStatus: 200 },
      { name: 'Register Page Loads', method: 'GET', endpoint: '/auth/register', expectedStatus: 200 }
    ]
  },
  {
    category: 'Account Roles',
    tests: [
      { name: 'Dashboard Requires Auth (browser)', method: 'GET', endpoint: '/dashboard', expectedStatus: 302 },
      { name: 'Dashboard Requires Auth (API)', method: 'GET', endpoint: '/dashboard', expectedStatus: 401, api: true },
      { name: 'Notifications API Requires Auth', method: 'GET', endpoint: '/notifications/unread-count', expectedStatus: 401, api: true },
      { name: 'Messages API Requires Auth', method: 'GET', endpoint: '/messages/unread-count', expectedStatus: 401, api: true }
    ]
  },
  {
    category: 'Admin',
    tests: [
      { name: 'Admin Dashboard Protected (browser)', method: 'GET', endpoint: '/admin', expectedStatus: 302 },
      { name: 'Admin Users Protected (browser)', method: 'GET', endpoint: '/admin/users', expectedStatus: 302 },
      { name: 'Admin Settings Protected (browser)', method: 'GET', endpoint: '/admin/settings', expectedStatus: 302 },
      { name: 'CRM Protected (browser)', method: 'GET', endpoint: '/crm', expectedStatus: 302 }
    ]
  },
  {
    category: 'SEO and Feeds',
    tests: [
      { name: 'robots.txt Loads', method: 'GET', endpoint: '/robots.txt', expectedStatus: 200 },
      { name: 'Sitemap Loads', method: 'GET', endpoint: '/sitemap.xml', expectedStatus: 200 }
    ]
  }
];

/**
 * Fails the boot on a malformed suite for the same reason `assertEstimationIntegrity` and
 * the rest of the config assertions do — a broken test suite that only surfaces when
 * someone clicks Run in production is worse than one that fails to start.
 */
function assertTestSuiteIntegrity() {
  const seen = new Set();
  if (!Array.isArray(TEST_SUITE) || TEST_SUITE.length === 0) {
    throw new Error('Admin test suite is empty.');
  }
  TEST_SUITE.forEach((group) => {
    if (!group.category || !Array.isArray(group.tests) || group.tests.length === 0) {
      throw new Error(`Admin test suite: category "${group.category}" has no tests.`);
    }
    group.tests.forEach((t) => {
      const key = `${group.category}::${t.name}`;
      if (seen.has(key)) throw new Error(`Admin test suite: duplicate test "${key}".`);
      seen.add(key);
      if (!t.name || !t.method || !t.endpoint || !t.expectedStatus) {
        throw new Error(`Admin test suite: incomplete test "${key}".`);
      }
      if (!t.endpoint.startsWith('/')) {
        throw new Error(`Admin test suite: "${key}" endpoint must be a relative path.`);
      }
    });
  });
}

function testKeyFor(category, name) {
  return `${category}::${name}`;
}

function totalTestCount() {
  return TEST_SUITE.reduce((sum, g) => sum + g.tests.length, 0);
}

module.exports = { TEST_SUITE, assertTestSuiteIntegrity, testKeyFor, totalTestCount };
