'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TABS = read('views/admin/_tabs.ejs');
const ADMIN_ROUTES = read('routes/admin.js');

const tabs = [...TABS.matchAll(/\{ href: '([^']+)', key: '([^']*)', label: '[^']+', icon: '[^']+', super: (true|false) \}/g)]
  .map((m) => ({ href: m[1], key: m[2], super: m[3] === 'true' }));

/*
 * WHY THIS FILE EXISTS.
 *
 * The tab strip decides what an ordinary admin is SHOWN; the route guards decide what they
 * may OPEN. The two are written in different files, so they drift: a tab marked open that
 * points at a superadmin route is a 403 in the navigation, and a tab marked superadmin-only
 * that points at an open route hides a page an admin is meant to use.
 */
describe('admin tabs', () => {
  test('the strip is read correctly', () => {
    // An empty list would pass every assertion below silently.
    expect(tabs.length).toBeGreaterThan(10);
  });

  test("each tab's superadmin marker matches the guard on its route", () => {
    for (const tab of tabs) {
      if (tab.href === '/admin/finance') {
        expect(read('routes/finance.js')).toMatch(/router\.use\(isAuthenticated, isSuperadmin\)/);
        expect(tab.super).toBe(true);
        continue;
      }
      if (tab.href === '/crm') {
        expect(read('routes/crm.js')).toMatch(/router\.use\(isAuthenticated, isSuperadmin\)/);
        expect(tab.super).toBe(true);
        continue;
      }
      const sub = tab.href.replace(/^\/admin/, '') || '/';
      const at = ADMIN_ROUTES.indexOf(`router.get(\n  '${sub}',`);
      expect(at).toBeGreaterThan(-1);
      const guarded = /^\s*isSuperadmin,/.test(ADMIN_ROUTES.slice(at + `router.get(\n  '${sub}',`.length));
      expect({ href: tab.href, super: tab.super }).toEqual({ href: tab.href, super: guarded });
    }
  });

  test('every admin page carries the strip, marked with its own tab', () => {
    const keys = new Set(tabs.map((t) => t.key));
    const dir = path.join(ROOT, 'views', 'admin');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ejs') && !f.startsWith('_'))) {
      const m = fs.readFileSync(path.join(dir, file), 'utf8').match(/include\('\.\/_tabs', \{ current: '([^']*)' \}\)/);
      expect({ file, included: Boolean(m) }).toEqual({ file, included: true });
      expect(keys.has(m[1])).toBe(true);
    }
  });
});
