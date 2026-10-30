'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

const User = require('../../models/User');
const { nameColumns, flagEmoji, shortDate, fullTimestamp } = require('../../utils/adminUserDisplay');
const { attachViewHelpers } = require('../../utils/viewHelpers');
const { notFound, errorHandler } = require('../../middleware/errorHandler');

/**
 * /admin/users, at parity with SAP Hub's screen: how a row is printed, what the filters
 * mean in SQL, and which controls each viewer is offered.
 *
 * `validateActiveAccount` is not mounted, so the session user is what the test says. A
 * plain HTTP client sends no Sec-Fetch-Dest, so a refused guard is a navigation: 302.
 */

describe('nameColumns', () => {
  it('splits a person at the first space, for display only', () => {
    expect(nameColumns({ user_type: 'consultant', name: 'Maria de la Cruz' })).toEqual({ first: 'Maria', last: 'de la Cruz' });
  });
  it('puts a company name in First and a dash in Last', () => {
    expect(nameColumns({ user_type: 'company', name: 'Hr Person', company_name: 'Acme Ltd' })).toEqual({ first: 'Acme Ltd', last: '—' });
  });
  it('copes with one word and with nothing', () => {
    expect(nameColumns({ user_type: 'consultant', name: 'Cher' })).toEqual({ first: 'Cher', last: '—' });
    expect(nameColumns({ user_type: 'consultant', name: '' })).toEqual({ first: '—', last: '—' });
  });
});

describe('flagEmoji and the dates', () => {
  it('builds a flag from a two-letter code and nothing from anything else', () => {
    expect(flagEmoji('al')).toBe('🇦🇱');
    expect(flagEmoji('ALB')).toBe('');
    expect(flagEmoji('')).toBe('');
  });
  it('prints dd/mm/yyyy in UTC, so 23:30 UTC does not become tomorrow', () => {
    expect(shortDate(new Date('2026-03-05T23:30:00Z'))).toBe('05/03/2026');
    expect(shortDate(null)).toBe('');
    expect(shortDate('not a date')).toBe('');
    expect(fullTimestamp(new Date('2026-03-05T23:30:00Z'))).toBe('2026-03-05 23:30 UTC');
  });
});

describe('User.buildAdminFilter', () => {
  it('binds every value and escapes LIKE wildcards', () => {
    const { clause, params } = User.buildAdminFilter({ search: '50%' });
    expect(clause).toBe('(u.email LIKE ? OR u.name LIKE ?)');
    expect(params).toEqual(['%50\\%%', '%50\\%%']);
  });
  it('matches an all-digit search against the id exactly as well', () => {
    const { clause, params } = User.buildAdminFilter({ search: '47' });
    expect(clause).toMatch(/u\.id = \?/);
    expect(params[0]).toBe(47);
  });
  it('Deleted is an erased account, and Active / Inactive leave erased accounts out', () => {
    expect(User.buildAdminFilter({ status: 'deleted' }).clause).toBe('u.anonymised_at IS NOT NULL');
    expect(User.buildAdminFilter({ status: 'active' }).clause).toBe('u.anonymised_at IS NULL AND u.is_active = 1');
    expect(User.buildAdminFilter({ status: 'inactive' }).clause).toBe('u.anonymised_at IS NULL AND u.is_active = 0');
    expect(User.buildAdminFilter({ status: 'closed' }).clause).toBe('1 = 1');
  });
  it("Listed is the directory's own rule, including the moderator's takedown", () => {
    const { clause } = User.buildAdminFilter({ talent: 'listed' });
    expect(clause).toMatch(/cp\.is_public = 1/);
    expect(clause).toMatch(/cp\.admin_hidden_at IS NULL/);
    expect(clause).toMatch(/u\.is_active = 1/);
    expect(User.buildAdminFilter({ talent: 'hidden' }).clause).toMatch(/AND NOT \(cp\.user_id IS NOT NULL/);
  });
  it('knows no partner role — migration 027 removed it', () => {
    expect(User.buildAdminFilter({ role: 'partner' }).clause).toBe('1 = 1');
  });
});

/* -------------------------------------------------------------- the screen */

const SUPER = { id: 1, name: 'Root', email: 'root@x.test', isAdmin: true, isSuperadmin: true, emailVerified: true };
const ADMIN = { id: 2, name: 'Mod', email: 'mod@x.test', isAdmin: true, isSuperadmin: false, emailVerified: true };

function buildApp(user) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  const flashed = { success: [], error: [], info: [] };
  app.flashed = flashed;
  app.use((req, res, next) => {
    req.session = { user };
    req.flash = (type, message) => {
      if (message === undefined) return flashed[type] || [];
      flashed[type].push(message);
      return undefined;
    };
    Object.assign(res.locals, {
      appName: 'Salesforce Hub', supportEmail: 's@x.test', assistantEnabled: false, assistantMaxChars: 2000,
      linkedInEnabled: false, siteNotice: '', currentUser: user, currentPath: req.path, csrfToken: 't', query: req.query,
      flash: flashed, seo: { title: 't', description: 'd', canonical: 'c', ogImage: 'o', indexable: false }
    });
    attachViewHelpers(res);
    next();
  });
  app.use('/admin', require('../../routes/admin'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

const row = (over) => ({
  id: 9, email: 'ana@x.test', name: 'Ana Kola', user_type: 'consultant', is_consultant: 1, is_company: 0,
  is_recruiter: 0, is_superadmin: 0, is_active: 1, email_verified: 0, created_at: new Date('2026-01-02T10:00:00Z'),
  last_login_at: null, anonymised_at: null, company_name: null, stated_country: 'al', has_consultant_profile: 1,
  talent_listed: 1, talent_hidden_at: null, ...over
});

afterEach(() => jest.restoreAllMocks());

describe('GET /admin/users', () => {
  it('passes only validated filters to the builder and carries them in every form', async () => {
    jest.spyOn(User, 'list').mockResolvedValue({ rows: [row()], total: 1 });
    const res = await request(buildApp(SUPER)).get('/admin/users?q=ana&role=partner&status=deleted&talent=nope&evil=1');
    expect(res.status).toBe(200);
    expect(User.list).toHaveBeenCalledWith({ search: 'ana', role: '', status: 'deleted', talent: '', limit: 20, offset: 0 });
    const carried = [...res.text.matchAll(/name="redirectTo" value="([^"]+)"/g)].map((m) => m[1]);
    expect(carried.length).toBeGreaterThan(3);
    expect(new Set(carried)).toEqual(new Set(['/admin/users?q=ana&amp;status=deleted']));
    expect(res.text).toContain('02/01/2026');
    expect(res.text).toContain('🇦🇱 AL');
    expect(res.text).toContain('Showing 1 of 1 user(s)');
    expect(res.text).not.toMatch(/Partners|Dedupe/);
  });

  it('offers nothing on your own row, a superadmin row, or an erased one', async () => {
    jest.spyOn(User, 'list').mockResolvedValue({
      rows: [
        row({ id: 1, email: 'root@x.test', user_type: 'admin', is_superadmin: 1, has_consultant_profile: 0 }),
        row({ id: 5, email: 'boss@x.test', user_type: 'admin', is_superadmin: 1, has_consultant_profile: 0 }),
        row({ id: 6, email: 'erased-6@erased.invalid', anonymised_at: new Date(), is_active: 0 })
      ],
      total: 3
    });
    const html = (await request(buildApp(SUPER)).get('/admin/users')).text;
    expect(html).not.toMatch(/\/admin\/users\/(1|6)\//);
    // Another superadmin can be deactivated as before, but never re-roled or erased here.
    expect(html).toContain('/admin/users/5/active');
    expect(html).not.toMatch(/\/admin\/users\/5\/(roles|delete)/);
    expect(html).not.toMatch(/data-row-select/);
    expect(html).not.toMatch(/revoke-superadmin/);
  });

  it('an ordinary admin gets moderation and verify, and nothing superadmin-only', async () => {
    jest.spyOn(User, 'list').mockResolvedValue({ rows: [row()], total: 1 });
    const html = (await request(buildApp(ADMIN)).get('/admin/users')).text;
    expect(html).toContain('/admin/users/9/verify');
    expect(html).toContain('/admin/users/9/talent');
    expect(html).not.toMatch(/\/admin\/users\/9\/(active|roles|delete)|bulk-delete|data-select-all|\(superadmin only\)/);
  });
});

describe('the redirect after an action', () => {
  it('returns to the filtered list, and only to the user list', async () => {
    jest.spyOn(User, 'setEmailVerified').mockResolvedValue();
    const app = buildApp(ADMIN);
    const back = (redirectTo) => request(app).post('/admin/users/9/verify').type('form').send({ redirectTo }).then((r) => r.headers.location);
    expect(await back('/admin/users?status=active&page=2')).toBe('/admin/users?status=active&page=2');
    expect(await back('//evil.example')).toBe('/admin/users');
    expect(await back('/admin/settings')).toBe('/admin/users');
    expect(await back('/admin/usersX')).toBe('/admin/users');
  });
});
