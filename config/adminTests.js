'use strict';

const { QA_ROLES } = require('../utils/qaAccounts');
const { WEBHOOK_PATH } = require('./payments');

/*
 * The admin test panel's rules, and its built-in suite.
 *
 * The cases live in `admin_test_cases` (migration 042) so the screen can switch one off and
 * a superadmin can add one, as the reference allows. The BUILT-IN cases are this file:
 * "Rebuild suite" writes them into the table, replacing only rows that carry a
 * `builtin_key`, so the cases guarding the site still have an author, a diff and a review.
 *
 * `caseSafetyProblems` is the one rule every case passes — built-in at boot and on rebuild,
 * custom when it is saved, and every case again just before it runs. A case:
 *
 *   - names a PATH on this site, never a URL. The runner joins it to APP_BASE_URL and
 *     checks the origin again, so no case can make this server request another host;
 *   - is a GET, or a POST that the CSRF layer refuses before any handler runs: sent with no
 *     session and no token, with an empty body, to a route that is not CSRF-exempt and is
 *     not named for deleting, paying or sending, and expecting the refusal (302 or 403).
 *     That is the only write a case can attempt, and it is one that cannot happen. If the
 *     CSRF layer ever failed open, the empty form fails validation rather than creating
 *     anything, and the case fails loudly with it;
 *   - carries only the request headers in ALLOWED_HEADERS — never a Cookie, never a token.
 */
const METHODS = Object.freeze(['GET', 'POST']);
const TEST_TYPES = Object.freeze(['api', 'page', 'form']);
const ALLOWED_HEADERS = Object.freeze(['accept', 'accept-language', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'x-requested-with']);
const REFUSAL_STATUSES = Object.freeze([302, 403]);
const DESTRUCTIVE_PATH = /delete|erase|purge|remove|pay|checkout|refund|webhook|send|email|invite|import|bulk|logout|close|approve|publish|void|forgot|reset|password|verif/i;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_TIMEOUT_MS = 10000;

/*
 * What a background fetch sends. Both headers, because `isNavigation()` reads Sec-Fetch-Dest
 * first and falls back to Accept: the 401 half of CLAUDE.md's "302 vs 401" is the one an
 * XHR depends on, and a case asserting it must request it the way a browser fetch() does.
 */
const API_HEADERS = Object.freeze({ Accept: 'application/json', 'Sec-Fetch-Dest': 'empty' });

/** One code, a comma list ("200,404"), a JSON list ("[200,404]") or an array → [200, 404]. */
function statusList(value) {
  let list;
  if (Array.isArray(value)) list = value;
  else if (typeof value === 'number') list = [value];
  else list = String(value === undefined || value === null ? '' : value).replace(/[[\]\s]/g, '').split(',');
  const codes = list.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 100 && n <= 599);
  return codes.length === list.length ? [...new Set(codes)] : [];
}

function stringList(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(/\r?\n|,/);
  return list.map((s) => String(s).trim()).filter(Boolean);
}

/** Either shape — this file's camelCase or the add form's fields — into one. */
function normaliseCase(raw) {
  const r = raw || {};
  const pick = (...names) => names.map((n) => r[n]).find((v) => v !== undefined && v !== null && v !== '');
  const headers = r.api ? { ...API_HEADERS, ...(r.headers || {}) } : r.headers || null;
  const timeout = Number(pick('timeoutMs', 'timeout_ms', 'timeout'));
  const role = pick('authRole', 'auth_role');
  return {
    key: r.key || (r.category && r.name ? `${r.category}::${r.name}` : null),
    name: String(pick('name') || '').trim().slice(0, 190),
    description: pick('description') ? String(pick('description')).trim().slice(0, 500) : null,
    category: String(pick('category') || '').trim().slice(0, 120),
    testType: pick('testType', 'test_type') || (r.api ? 'api' : 'page'),
    method: String(pick('method') || 'GET').toUpperCase(),
    endpoint: String(pick('endpoint') || '').trim(),
    headers: headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : null,
    expectedStatus: statusList(pick('expectedStatus', 'expected_status') === undefined ? 200 : pick('expectedStatus', 'expected_status')),
    expectedContains: stringList(pick('expectedContains', 'expected_contains')),
    expectedNotContains: stringList(pick('expectedNotContains', 'expected_not_contains')),
    expectedRedirect: pick('expectedRedirect', 'expected_redirect') ? String(pick('expectedRedirect', 'expected_redirect')).trim() : null,
    timeoutMs: Number.isInteger(timeout) ? timeout : DEFAULT_TIMEOUT_MS,
    authRole: role ? String(role) : null,
    hasBody: r.body !== undefined && r.body !== null && r.body !== '' && !(typeof r.body === 'object' && Object.keys(r.body).length === 0)
  };
}

function isSitePath(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    // A backslash is a slash to a URL parser, and whitespace or a control character has no
    // business in a path; both are refused rather than normalised.
    !/[\\\s]/.test(value) &&
    ![...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) &&
    value.length <= 300
  );
}

/** Everything wrong with a case, in words. Empty means it may be stored and run. */
function caseSafetyProblems(c) {
  const problems = [];
  if (!c.name) problems.push('a name is required');
  if (!c.category) problems.push('a category is required');
  if (!TEST_TYPES.includes(c.testType)) problems.push(`type must be one of ${TEST_TYPES.join(', ')}`);
  if (!METHODS.includes(c.method)) problems.push(`method must be ${METHODS.join(' or ')}`);
  if (!isSitePath(c.endpoint)) problems.push('the endpoint must be a path on this site, starting with a single "/"');
  if (!c.expectedStatus || !c.expectedStatus.length) problems.push('expected status must be one or more codes between 100 and 599');
  if (c.expectedRedirect && !isSitePath(c.expectedRedirect)) problems.push('an expected redirect must be a path on this site');
  if (c.authRole && !QA_ROLES.includes(c.authRole)) problems.push(`the role must be one of ${QA_ROLES.join(', ')}, or none`);
  if (!Number.isInteger(c.timeoutMs) || c.timeoutMs < MIN_TIMEOUT_MS || c.timeoutMs > MAX_TIMEOUT_MS) {
    problems.push(`the timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms`);
  }
  Object.entries(c.headers || {}).forEach(([name, value]) => {
    if (!ALLOWED_HEADERS.includes(String(name).toLowerCase())) problems.push(`header "${name}" is not one a case may send`);
    if (typeof value !== 'string' || value.length > 200 || /[\r\n]/.test(value)) problems.push(`header "${name}" has an unusable value`);
  });
  [...(c.expectedContains || []), ...(c.expectedNotContains || [])].forEach((s) => {
    if (s.length > 200) problems.push('an expected string is longer than 200 characters');
  });
  if (c.hasBody) problems.push('a case carries no body');

  if (c.method === 'POST') {
    const path = String(c.endpoint).split(/[?#]/)[0];
    if (c.authRole) problems.push('a POST runs as a visitor only: signed in, it would be a write with a QA account’s standing');
    if (path === WEBHOOK_PATH) problems.push('a POST may not target the CSRF-exempt webhook');
    if (DESTRUCTIVE_PATH.test(path)) problems.push('a POST may not target a route named for deleting, paying, sending or importing');
    if (!c.expectedStatus.length || !c.expectedStatus.every((s) => REFUSAL_STATUSES.includes(s))) {
      problems.push(`a POST must expect the CSRF refusal (${REFUSAL_STATUSES.join(' or ')}), never a success`);
    }
  }
  return problems;
}

/** The headers the runner sends for a case: its allowed ones over a navigation default. */
function headersFor(c) {
  const out = { Accept: 'text/html' };
  Object.entries(c.headers || {}).forEach(([name, value]) => {
    if (ALLOWED_HEADERS.includes(String(name).toLowerCase()) && typeof value === 'string') out[name] = value;
  });
  return out;
}

/* ===================================================================== the suite */

/*
 * Builders, so each line of the suite reads as what it asserts. Every expected string was
 * read off the running page, and is something only that page says — a heading, a form
 * field, an empty state — not the site name every page carries.
 */
const LOGIN = '/auth/login';

function page(category, name, endpoint, contains, extra = {}) {
  return { category, name, endpoint, method: 'GET', expectedStatus: 200, expectedContains: [].concat(contains || []), ...extra };
}
function asRole(authRole, category, name, endpoint, contains, extra = {}) {
  return page(category, name, endpoint, contains, { authRole, ...extra });
}
function redirects(category, name, endpoint, to, extra = {}) {
  return { category, name, endpoint, method: 'GET', expectedStatus: 302, expectedRedirect: to, ...extra };
}
/** A visitor navigating to a member page is sent to sign in. */
function guard(category, name, endpoint) {
  return redirects(category, `${name} sends a visitor to sign in`, endpoint, LOGIN, { description: 'Navigation without a session: 302 to the login page.' });
}
/** The same page fetched in the background answers 401 JSON instead. */
function apiGuard(category, name, endpoint) {
  return {
    category,
    name: `${name} answers a visitor's fetch with 401`,
    endpoint,
    method: 'GET',
    api: true,
    expectedStatus: 401,
    expectedContains: ['"success":false'],
    description: 'Sec-Fetch-Dest: empty, as a browser fetch() sends — 401 JSON, not a redirect.'
  };
}
/** A signed-in account without the role is refused, at the route, to `to`. */
function refused(authRole, category, name, endpoint, to = '/') {
  return redirects(category, `${name} refuses the ${authRole}`, endpoint, to, { authRole });
}

/*
 * What a QA account must never look like from outside: a directory listing one of them is
 * the site publishing its own test harness. Checked on the pages that list people.
 */
const NOT_A_QA_ACCOUNT = ['@salesforcehub.test', 'QA Consultant', 'QA Company', 'QA Recruiter', 'QA Admin'];

const PUBLIC = 'Public pages';
const SERVICES = 'Services pages';
const FEEDS = 'Feeds and health';
const AUTH = 'Sign-in pages';
const GUARDS = 'Visitor guards';
const API = 'Background fetch guards';
const CONSULTANT = 'Consultant (signed in)';
const COMPANY = 'Company (signed in)';
const RECRUITER = 'Recruiter (signed in)';
const ADMIN = 'Admin (plain admin)';
const ROLES = 'Role guards';
const SUPER = 'Superadmin-only pages';
const FORMS = 'Forms without a token';
const EDGES = 'Not found and redirects';

/*
 * Every member page a visitor must be sent away from, with a label. One list so the guard
 * case and the coverage test read the same thing.
 */
const MEMBER_PAGES = [
  ['/my-issues', 'Your reports'],
  ['/dashboard', 'Dashboard'],
  ['/dashboard/nav-summary', 'Navigation summary'],
  ['/dashboard/jobs', 'Your jobs'],
  ['/dashboard/applicants', 'Applicant board'],
  ['/dashboard/applications', 'Your applications'],
  ['/dashboard/saved', 'Saved jobs'],
  ['/profile', 'Profile'],
  ['/profile/settings', 'Profile settings'],
  ['/profile/consultant', 'Consultant profile'],
  ['/profile/company', 'Company profile'],
  ['/profile/company/template', 'Document branding'],
  ['/profile/hidden-companies', 'Hidden companies'],
  ['/profile/data', 'Data export'],
  ['/profile/documents', 'My documents'],
  ['/profile/close', 'Close account'],
  ['/community/new', 'New post'],
  ['/jobs/new', 'Post a role'],
  ['/cv-generator/preview', 'CV preview'],
  ['/cv-generator/download', 'CV download'],
  ['/quotes', 'Quotes'],
  ['/quotes/new', 'New quote'],
  ['/payments/success', 'Payment success'],
  ['/payments/cancelled', 'Payment cancelled'],
  ['/payments/history', 'Payment history'],
  ['/payments/placements', 'Placement fees'],
  ['/referrals', 'Referrals'],
  ['/referrals/agent', 'Agent dashboard'],
  ['/linkedin/start', 'LinkedIn start'],
  ['/linkedin/callback', 'LinkedIn callback'],
  ['/challenges', 'Daily challenge'],
  ['/challenges/leaderboard', 'Challenge leaderboard'],
  ['/recruiters/dashboard', 'Recruiter dashboard'],
  ['/recruiters/profile', 'Agency profile'],
  ['/messages', 'Messages'],
  ['/messages/unread-count', 'Unread messages count'],
  ['/notifications', 'Notifications'],
  ['/notifications/unread-count', 'Unread notifications count'],
  ['/admin', 'Admin overview'],
  ['/admin/tests', 'Admin tests'],
  ['/crm', 'Sales leads']
];

/* Signed-in pages that answer JSON, each fetched the way the page's own script fetches it. */
const MEMBER_APIS = [
  ['/dashboard/nav-summary', 'Navigation summary'],
  ['/messages/unread-count', 'Unread messages count'],
  ['/notifications/unread-count', 'Unread notifications count'],
  ['/dashboard', 'Dashboard'],
  ['/admin', 'Admin overview']
];

/* What a plain admin opens, and the words only that page says. */
const ADMIN_PAGES = [
  ['/admin', 'Admin overview', 'Admin'],
  ['/admin/users', 'Users', 'Manage platform users'],
  ['/admin/jobs', 'Jobs', 'Jobs'],
  ['/admin/moderation', 'Moderation', 'Content is hidden, never deleted'],
  ['/admin/issues', 'Reported problems', 'Reported problems'],
  ['/admin/stories', 'Success stories', 'Success stories'],
  ['/admin/reviews', 'Member reviews', 'Member reviews'],
  ['/admin/payments', 'Payments', 'What was charged, and what needs a human'],
  ['/admin/analytics', 'Analytics', 'What this site counts itself'],
  ['/admin/analytics/ga4', 'Google Analytics 4', 'Google Analytics 4'],
  ['/admin/analytics/cloudflare', 'Cloudflare Web Analytics', 'Cloudflare Web Analytics'],
  ['/admin/ai', 'Assistant usage', 'Assistant usage'],
  ['/admin/errors', 'Error log', 'Error log'],
  ['/admin/tests', 'Automated testing', 'Automated testing']
];

/* Downloads a plain admin may take: checked by what the file starts with, not by a page. */
const ADMIN_DOWNLOADS = [
  ['/admin/errors/export.csv', 'Error log export', 'created_at,status_code,method,path,message']
];

/*
 * Pages behind `isSuperadmin`. The QA admin is a plain admin on purpose, so each of these
 * must refuse it — and a superadmin-only page that opened for it is the regression.
 */
const SUPERADMIN_PAGES = [
  ['/admin/applications', 'Applications'],
  ['/admin/referrals', 'Referrals'],
  ['/admin/rates', 'Rate submissions'],
  ['/admin/tax-advisory', 'Tax enquiries'],
  ['/admin/placements', 'Placements'],
  ['/admin/settings', 'Settings'],
  ['/admin/finance', 'Finance'],
  ['/admin/finance/clients', 'Finance clients'],
  ['/admin/finance/invoices', 'Invoices'],
  ['/admin/finance/invoices/new', 'New invoice'],
  ['/admin/finance/costs', 'Costs'],
  ['/admin/finance/pl', 'Profit and loss'],
  ['/admin/finance/sequence', 'Invoice sequence'],
  ['/crm', 'Sales leads'],
  ['/crm/new', 'New lead'],
  ['/crm/import', 'Lead import'],
  ['/crm/export.csv', 'Lead export'],
  ['/crm/suppressions', 'Suppressions']
];

const TEST_SUITE = [
  /* ---------------------------------------------------------------- public */
  page(PUBLIC, 'Home feed loads', '/', 'the Salesforce community, live'),
  page(PUBLIC, 'Consultant hub loads', '/consultant-hub', 'Everything for Salesforce consultants'),
  page(PUBLIC, 'Companies hub loads', '/companies-hub', 'Hire Salesforce talent, or scope the work first'),
  page(PUBLIC, 'About loads', '/about', 'sister platform of Dynamics Hub'),
  page(PUBLIC, 'Blog loads', '/blog', 'Articles from people who deliver on the Salesforce platform'),
  page(PUBLIC, 'FAQ loads', '/faq', 'Frequently asked questions'),
  page(PUBLIC, 'Privacy policy loads', '/legal/privacy', 'Privacy policy'),
  page(PUBLIC, 'Terms load', '/legal/terms', 'Terms of service'),
  page(PUBLIC, 'Report a problem loads', '/report-issue', ['Report a problem', 'name="_csrf"']),
  page(PUBLIC, 'Ideas load', '/ideas', 'Suggestions people sent and agreed to share'),
  page(PUBLIC, 'Contact loads', '/contact', 'One address, read by a person'),
  page(PUBLIC, 'Consultant directory loads, without QA accounts', '/consultants', 'Salesforce consultants', { expectedNotContains: NOT_A_QA_ACCOUNT }),
  page(PUBLIC, 'Company directory loads, without QA accounts', '/companies', 'Partners, ISVs and end customers hiring on the Hub', { expectedNotContains: NOT_A_QA_ACCOUNT }),
  page(PUBLIC, 'Agency directory loads, without QA accounts', '/recruiters', 'Recruitment agencies', { expectedNotContains: NOT_A_QA_ACCOUNT }),
  page(PUBLIC, 'Community loads', '/community', 'Questions, discussions, articles and wins'),
  page(PUBLIC, 'Jobs board loads', '/jobs', 'Salesforce jobs and contracts'),
  page(PUBLIC, 'Rate index loads', '/rates', ['Salary Index', 'id="share"']),
  page(PUBLIC, 'Rate calculator loads', '/rates/calculator', 'Contract rate calculator'),
  page(PUBLIC, 'Pricing loads', '/payments', 'Two paid things'),
  page(PUBLIC, 'Search loads', '/search', 'One box, four places'),
  page(PUBLIC, 'Search answers a query', '/search?q=salesforce', 'Search'),
  page(PUBLIC, 'Tax optimization loads', '/tax-optimization', 'Tax optimization'),
  page(PUBLIC, 'Tax enquiry form loads', '/tax-optimization/enquire', ['name="_csrf"']),
  /* The page's old address must keep working for links already out there: 301 to its name. */
  { category: EDGES, name: 'The old tax advisory address moves permanently', endpoint: '/tax-advisory', method: 'GET', expectedStatus: 301, expectedRedirect: '/tax-optimization' },
  page(PUBLIC, 'CV generator page loads', '/cv-generator', 'Your CV and rate card, generated from your profile'),
  page(PUBLIC, 'Success stories load', '/success-stories', 'What people actually delivered'),
  page(PUBLIC, 'Member reviews load', '/success-stories/reviews', 'What members say'),

  /* -------------------------------------------------------------- services */
  page(SERVICES, 'Staff augmentation loads', '/services/staff-augmentation', 'Staff augmentation'),
  page(SERVICES, 'Project-based delivery loads', '/services/project-based', 'Project-based delivery'),
  page(SERVICES, 'Managed services loads', '/services/managed-services', 'Managed services'),
  page(SERVICES, 'SOW pack page loads', '/services/document-generator', 'the SOW pack'),
  { category: SERVICES, name: 'Unknown service is a 404', endpoint: '/services/not-a-real-service', method: 'GET', expectedStatus: 404 },
  /*
   * `SERVICE_PAGES['constructor']` is `Object` — truthy — so the plain lookup this came with
   * handed `Object` to the view and died inside it. A 500 here is that bug back.
   */
  { category: SERVICES, name: 'A prototype key is not a page', endpoint: '/services/constructor', method: 'GET', expectedStatus: 404 },

  /* --------------------------------------------------------- feeds, health */
  page(FEEDS, 'robots.txt keeps crawlers out of member areas', '/robots.txt', 'Disallow: /admin'),
  page(FEEDS, 'Sitemap lists public pages', '/sitemap.xml', '<urlset', { expectedNotContains: ['/admin', '/dashboard'] }),
  { category: FEEDS, name: 'Health check answers', endpoint: '/healthz', method: 'GET', api: true, expectedStatus: 200, expectedContains: ['"ok":true'] },

  /* ---------------------------------------------------------------- sign in */
  page(AUTH, 'Login form loads with its token', '/auth/login', ['Sign in', 'name="_csrf"', 'name="password"']),
  page(AUTH, 'Registration form loads', '/auth/register', ['Create your account', 'name="_csrf"']),
  page(AUTH, 'Password reset form loads', '/auth/forgot-password', 'Reset your password'),
  redirects(AUTH, 'Verify without a token goes to sign in', '/auth/verify', LOGIN),
  redirects(AUTH, 'A signed-in consultant is sent past the login form', '/auth/login', '/dashboard', { authRole: 'consultant' }),
  redirects(AUTH, 'A signed-in company is sent past registration', '/auth/register', '/dashboard', { authRole: 'company' }),

  /* ---------------------------------------------------------- visitor guards */
  ...MEMBER_PAGES.map(([path, label]) => guard(GUARDS, label, path)),
  ...SUPERADMIN_PAGES.filter(([path]) => !MEMBER_PAGES.some(([p]) => p === path)).map(([path, label]) => guard(GUARDS, `Superadmin: ${label}`, path)),
  ...ADMIN_PAGES.filter(([path]) => !MEMBER_PAGES.some(([p]) => p === path)).map(([path, , label]) => guard(GUARDS, `Admin: ${label}`, path)),
  ...ADMIN_DOWNLOADS.map(([path, label]) => guard(GUARDS, `Admin: ${label}`, path)),

  /* ------------------------------------------------- background fetch guards */
  ...MEMBER_APIS.map(([path, label]) => apiGuard(API, label, path)),

  /* ------------------------------------------------------------- consultant */
  asRole('consultant', CONSULTANT, 'Home greets the consultant by name', '/', ', QA</h1>'),
  asRole('consultant', CONSULTANT, 'Dashboard loads', '/dashboard', 'Dashboard'),
  asRole('consultant', CONSULTANT, 'Navigation summary answers JSON', '/dashboard/nav-summary', '"success":true', { api: true }),
  asRole('consultant', CONSULTANT, 'Unread messages count answers JSON', '/messages/unread-count', '"success":true', { api: true }),
  asRole('consultant', CONSULTANT, 'Unread notifications count answers JSON', '/notifications/unread-count', '"success":true', { api: true }),
  asRole('consultant', CONSULTANT, 'Applications list loads', '/dashboard/applications', 'Your applications'),
  asRole('consultant', CONSULTANT, 'Saved jobs load', '/dashboard/saved', 'Saved jobs'),
  asRole('consultant', CONSULTANT, 'My documents load', '/profile/documents', 'My documents'),
  /* The agent dashboard is a 404 to anybody who is not an ACTIVE sales agent — the QA consultant is not one. */
  { category: ROLES, name: 'Agent dashboard is a 404 to a member who is not an agent', endpoint: '/referrals/agent', method: 'GET', authRole: 'consultant', expectedStatus: 404 },
  redirects(CONSULTANT, 'Profile goes to the one settings page', '/profile', '/profile/settings', { authRole: 'consultant' }),
  redirects(CONSULTANT, 'Old consultant profile URL goes to settings', '/profile/consultant', '/profile/settings', { authRole: 'consultant' }),
  asRole('consultant', CONSULTANT, 'Build your profile loads', '/profile/settings', 'Build your profile'),
  asRole('consultant', CONSULTANT, 'Hide from companies loads', '/profile/hidden-companies', 'Hide from companies'),
  asRole('consultant', CONSULTANT, 'Close account page loads', '/profile/close', 'Close your account'),
  asRole('consultant', CONSULTANT, 'CV preview renders for a thin profile', '/cv-generator/preview', 'Fill your profile to see your CV here'),
  asRole('consultant', CONSULTANT, 'Quotes list loads', '/quotes', 'Your quotes'),
  asRole('consultant', CONSULTANT, 'Quote form loads', '/quotes/new', 'Generate a Statement of Work for Salesforce implementations'),
  asRole('consultant', CONSULTANT, 'Write a post loads', '/community/new', 'Write a post'),
  asRole('consultant', CONSULTANT, 'Messages load', '/messages', 'Messages'),
  asRole('consultant', CONSULTANT, 'Notifications load', '/notifications', 'Notifications'),
  asRole('consultant', CONSULTANT, 'Referrals load', '/referrals', 'Refer someone'),
  asRole('consultant', CONSULTANT, 'Daily challenge loads', '/challenges', 'Daily challenge'),
  asRole('consultant', CONSULTANT, 'Challenge leaderboard loads', '/challenges/leaderboard', 'Challenge leaderboard'),
  asRole('consultant', CONSULTANT, 'Your reports load', '/my-issues', 'Your reports'),
  asRole('consultant', CONSULTANT, 'Payment history loads', '/payments/history', 'Payments and invoices'),
  asRole('consultant', CONSULTANT, 'Placement fees load', '/payments/placements', 'Placement fees'),
  asRole('consultant', CONSULTANT, 'Cancelled payment page loads', '/payments/cancelled', 'Payment cancelled'),
  redirects(CONSULTANT, 'Payment success without a session goes to history', '/payments/success', '/payments/history', { authRole: 'consultant' }),
  // Signed in, the account menu shows the QA account's own name, so a signed-in directory
  // case checks only for the OTHER QA accounts.
  asRole('consultant', CONSULTANT, 'The directory lists no other QA account to a member', '/consultants', 'Salesforce consultants', { expectedNotContains: ['QA Company', 'QA Recruiter', 'QA Admin'] }),

  /* ---------------------------------------------------------------- company */
  asRole('company', COMPANY, 'Dashboard loads', '/dashboard', 'Dashboard'),
  asRole('company', COMPANY, 'Your jobs load', '/dashboard/jobs', 'Your jobs'),
  asRole('company', COMPANY, 'Applicant board loads', '/dashboard/applicants', 'Applicants'),
  asRole('company', COMPANY, 'Post a role loads', '/jobs/new', ['Post a role', 'name="_csrf"']),
  asRole('company', COMPANY, 'Company profile loads', '/profile/company', 'Your company profile'),
  asRole('company', COMPANY, 'Document branding loads', '/profile/company/template', 'Document branding'),
  asRole('company', COMPANY, 'Account settings load', '/profile/settings', 'Build Your Professional Profile'),
  asRole('company', COMPANY, 'Quote form loads', '/quotes/new', 'Generate a Statement of Work for Salesforce implementations'),
  asRole('company', COMPANY, 'Directory loads for a company, without the QA consultant', '/consultants', 'Salesforce consultants', { expectedNotContains: ['QA Consultant', 'qa-consultant@'] }),
  asRole('company', COMPANY, 'Company directory hides the QA company after its pages were opened', '/companies', 'Partners, ISVs and end customers', { expectedNotContains: ['/companies/qa-company'] }),

  /* -------------------------------------------------------------- recruiter */
  asRole('recruiter', RECRUITER, 'Recruiter dashboard loads', '/recruiters/dashboard', 'Recruiter dashboard'),
  asRole('recruiter', RECRUITER, 'Agency profile form loads', '/recruiters/profile', 'Agency profile'),
  asRole('recruiter', RECRUITER, 'Dashboard loads', '/dashboard', 'Dashboard'),
  asRole('recruiter', RECRUITER, 'Agency directory lists no QA account', '/recruiters', 'Recruitment agencies', { expectedNotContains: ['QA Consultant', 'QA Company', 'QA Admin'] }),

  /* ------------------------------------------------------------ plain admin */
  ...ADMIN_PAGES.map(([path, label, words]) => asRole('admin', ADMIN, `${label} loads`, path, [words, 'aria-label="Admin sections"'])),
  ...ADMIN_DOWNLOADS.map(([path, label, words]) => asRole('admin', ADMIN, `${label} downloads`, path, words)),

  /* ----------------------------------------------------------- role guards */
  refused('consultant', ROLES, 'Admin overview', '/admin'),
  refused('company', ROLES, 'Admin overview', '/admin'),
  refused('recruiter', ROLES, 'Admin overview', '/admin'),
  refused('consultant', ROLES, 'Admin tests', '/admin/tests'),
  refused('consultant', ROLES, 'Post a role', '/jobs/new'),
  refused('consultant', ROLES, 'Your jobs', '/dashboard/jobs'),
  refused('consultant', ROLES, 'Applicant board', '/dashboard/applicants'),
  refused('consultant', ROLES, 'Company profile', '/profile/company'),
  refused('consultant', ROLES, 'Document branding', '/profile/company/template'),
  refused('consultant', ROLES, 'Recruiter dashboard', '/recruiters/dashboard'),
  refused('company', ROLES, 'Agency profile', '/recruiters/profile'),
  refused('company', ROLES, 'Your applications', '/dashboard/applications', '/profile/settings'),
  refused('company', ROLES, 'Hide from companies', '/profile/hidden-companies', '/profile/settings'),
  refused('company', ROLES, 'CV preview', '/cv-generator/preview', '/profile/settings'),
  refused('company', ROLES, 'CV download', '/cv-generator/download', '/profile/settings'),

  /* ------------------------------------------------------ superadmin only */
  ...SUPERADMIN_PAGES.map(([path, label]) => refused('admin', SUPER, label, path)),

  /* ------------------------------------------------- forms without a token */
  /*
   * The only POSTs this panel sends. No session, no token, no body: the CSRF layer refuses
   * them before any handler runs, and a 302 here means it still does. A 200 or a handler's
   * own redirect would mean a form on the live site accepts a cross-site post.
   */
  { category: FORMS, name: 'Login refuses a post without a token', endpoint: '/auth/login', method: 'POST', testType: 'form', expectedStatus: 302, expectedRedirect: '/' },
  { category: FORMS, name: 'Registration refuses a post without a token', endpoint: '/auth/register', method: 'POST', testType: 'form', expectedStatus: 302, expectedRedirect: '/' },
  { category: FORMS, name: 'Report a problem refuses a post without a token', endpoint: '/report-issue', method: 'POST', testType: 'form', expectedStatus: 302, expectedRedirect: '/' },
  { category: FORMS, name: 'Tax enquiry refuses a post without a token', endpoint: '/tax-optimization/enquire', method: 'POST', testType: 'form', expectedStatus: 302, expectedRedirect: '/' },
  { category: FORMS, name: 'A fetch without a token gets 403 JSON', endpoint: '/report-issue', method: 'POST', testType: 'form', api: true, expectedStatus: 403, expectedContains: ['"success":false'] },

  /* ------------------------------------------------- not found, redirects */
  { category: EDGES, name: 'An unknown page is a 404', endpoint: '/this-page-does-not-exist', method: 'GET', expectedStatus: 404, expectedContains: ['Page not found'] },
  { category: EDGES, name: 'An unknown API path is a 404 JSON', endpoint: '/this-page-does-not-exist', method: 'GET', api: true, expectedStatus: 404 },
  /*
   * A sales agent's link with a code nobody holds still lands on sign-up — a stranger with a
   * stale link must not meet an error page — and the runner's user agent says "monitor", so
   * even a real code would not be counted as an open.
   */
  /* Sharing a rate is inline on /rates now; the old form address sends anybody there. */
  { category: EDGES, name: 'The old rate submission address moves to the inline form', endpoint: '/rates/submit', method: 'GET', expectedStatus: 301, expectedRedirect: '/rates' },
  redirects(EDGES, 'An unknown sales-agent link lands on sign-up', '/s/not-a-real-code', '/auth/register')
];

const SUITE_FLAT = Object.freeze(TEST_SUITE.map((raw) => Object.freeze(raw)));

/**
 * GET routes with no path parameter that have no built-in case, and why. Each one is a
 * route the coverage test would otherwise fail on; the reason is the review.
 *
 * Empty, and that is a finding rather than an omission: a download (/cv-generator/download,
 * /crm/export.csv) and an OAuth callback (/linkedin/callback) can still be checked by their
 * guard — a visitor is sent to sign in, a role without access is refused — without the
 * runner ever taking the file or starting the flow.
 */
const COVERAGE_EXEMPT = Object.freeze({});

/**
 * Fails the boot on a malformed or unsafe suite, for the same reason the other config
 * assertions do: a broken suite that surfaces when somebody presses Rebuild in production is
 * worse than one that fails to start.
 */
function assertTestSuiteIntegrity() {
  if (!SUITE_FLAT.length) throw new Error('Admin test suite is empty.');
  const seen = new Set();
  SUITE_FLAT.forEach((raw) => {
    const c = normaliseCase(raw);
    if (!c.key) throw new Error(`Admin test suite: a case has no key (${raw.name}).`);
    if (seen.has(c.key)) throw new Error(`Admin test suite: duplicate case "${c.key}".`);
    seen.add(c.key);
    if (c.key.length > 190) throw new Error(`Admin test suite: key too long "${c.key}".`);
    const problems = caseSafetyProblems(c);
    if (problems.length) throw new Error(`Admin test suite: "${c.key}" — ${problems.join('; ')}.`);
  });
}

/** The paths the built-in suite requests, without query strings. */
function coveredPaths() {
  return new Set(SUITE_FLAT.map((c) => String(c.endpoint).split(/[?#]/)[0]));
}

module.exports = {
  TEST_SUITE: SUITE_FLAT,
  COVERAGE_EXEMPT,
  METHODS,
  TEST_TYPES,
  ALLOWED_HEADERS,
  REFUSAL_STATUSES,
  API_HEADERS,
  statusList,
  normaliseCase,
  caseSafetyProblems,
  headersFor,
  assertTestSuiteIntegrity,
  coveredPaths
};
