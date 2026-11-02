'use strict';

const fs = require('fs');
const path = require('path');
const { isOwnTraffic } = require('../../middleware/visitGeo');

const req = (p, user = null) => ({ path: p, session: user ? { user } : {} });

describe('the Hub measures visitors, not itself', () => {
  it('never measures the admin surface, the CRM or the sign-in pages', () => {
    ['/admin', '/admin/analytics', '/crm', '/crm/leads', '/auth/login', '/auth/register'].forEach((p) => {
      expect(isOwnTraffic(req(p))).toBe(true);
    });
  });

  it('measures public pages for visitors and members, and nothing for an administrator', () => {
    ['/', '/jobs', '/rates', '/administration-guide', '/authors'].forEach((p) => expect(isOwnTraffic(req(p))).toBe(false));
    expect(isOwnTraffic(req('/jobs', { isConsultant: true }))).toBe(false);
    expect(isOwnTraffic(req('/jobs', { isAdmin: true }))).toBe(true);
    expect(isOwnTraffic(req('/jobs', { isSuperadmin: true }))).toBe(true);
  });

  it('gates all three counters on the same rule', () => {
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
    expect(read('views/partials/footer.ejs')).toMatch(/cloudflareToken && typeof measureVisit !== 'undefined' && measureVisit/);
    expect(read('views/partials/head.ejs')).toContain('analytics-measure');
    expect(read('public/js/analytics.js')).toMatch(/if \(loaded \|\| measureOff\) return;/);
    expect(read('middleware/visitGeo.js')).toContain('if (isOwnTraffic(req)) return;');
  });
});

describe('resetting the visitor tally', () => {
  const admin = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'routes', 'admin.js'), 'utf8');
  it('is superadmin, typed, and touches only visit_geo_daily', () => {
    const at = admin.indexOf("'/analytics/reset-geo',");
    expect(admin.slice(at, at + 60)).toMatch(/isSuperadmin,/);
    expect(admin.slice(at, at + 600)).toMatch(/!== 'RESET'/);
    const model = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'models', 'SiteStats.js'), 'utf8');
    expect(model.match(/DELETE FROM \w+/g)).toEqual(['DELETE FROM visit_geo_daily']);
  });
});
