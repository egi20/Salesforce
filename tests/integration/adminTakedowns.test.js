'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

const User = require('../../models/User');
const AccountErasure = require('../../models/AccountErasure');
const Moderation = require('../../models/Moderation');
const ErrorLog = require('../../models/ErrorLog');
const { attachViewHelpers } = require('../../utils/viewHelpers');
const { notFound, errorHandler } = require('../../middleware/errorHandler');

/**
 * The admin actions ported from SAP Hub that change or remove somebody else's data:
 * erasing an account, taking a profile or an advert down, exporting the error log.
 *
 * `validateActiveAccount` is not mounted, so the session user is what the test says. A
 * plain HTTP client sends no Sec-Fetch-Dest, so a refused guard is a navigation: 302.
 */
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

afterEach(() => jest.restoreAllMocks());

describe('erasing an account from /admin/users', () => {
  beforeEach(() => {
    jest.spyOn(User, 'findById').mockImplementation(async (id) => ({ id, email: `user${id}@x.test` }));
    jest.spyOn(AccountErasure, 'erase').mockResolvedValue({});
  });

  it('erases through AccountErasure only when the address is typed exactly', async () => {
    const app = buildApp(SUPER);
    await request(app).post('/admin/users/9/delete').type('form').send({ confirm: 'wrong@x.test' });
    expect(AccountErasure.erase).not.toHaveBeenCalled();
    expect(app.flashed.error[0]).toMatch(/Type the account's email/);

    const res = await request(app).post('/admin/users/9/delete').type('form').send({ confirm: ' USER9@x.test ', redirectTo: '/admin/users?q=user9' });
    expect(AccountErasure.erase).toHaveBeenCalledWith(9, { reason: 'admin:1' });
    expect(res.headers.location).toBe('/admin/users?q=user9');
  });

  it('refuses your own account and reports a superadmin refusal from the eraser', async () => {
    const app = buildApp(SUPER);
    await request(app).post('/admin/users/1/delete').type('form').send({ confirm: 'user1@x.test' });
    expect(AccountErasure.erase).not.toHaveBeenCalled();
    expect(app.flashed.error[0]).toMatch(/your own account/);

    AccountErasure.erase.mockRejectedValueOnce(Object.assign(new Error('Remove the superadmin role first.'), { code: 'SUPERADMIN' }));
    await request(app).post('/admin/users/5/delete').type('form').send({ confirm: 'user5@x.test' });
    expect(app.flashed.error[1]).toMatch(/superadmin/);
  });

  it('is superadmin-only, for one account and in bulk', async () => {
    const app = buildApp(ADMIN);
    expect((await request(app).post('/admin/users/9/delete').type('form').send({ confirm: 'user9@x.test' })).status).toBe(302);
    expect((await request(app).post('/admin/users/bulk-delete').type('form').send({ ids: ['9'], confirm: 'ERASE 1' })).status).toBe(302);
    expect(AccountErasure.erase).not.toHaveBeenCalled();
  });

  it('bulk: the typed count is the interlock, and a malformed id refuses the whole batch', async () => {
    const app = buildApp(SUPER);
    await request(app).post('/admin/users/bulk-delete').type('form').send({ ids: ['9', '10'], confirm: 'ERASE 1' });
    expect(AccountErasure.erase).not.toHaveBeenCalled();
    await request(app).post('/admin/users/bulk-delete').type('form').send({ ids: ['9', '44.map'], confirm: 'ERASE 2' });
    expect(AccountErasure.erase).not.toHaveBeenCalled();
    await request(app).post('/admin/users/bulk-delete').type('form').send({ ids: ['9', '10', '1'], confirm: 'erase 3' });
    // Your own account in the batch is refused; the rest go ahead, one transaction each.
    expect(AccountErasure.erase.mock.calls.map((c) => c[0])).toEqual([9, 10]);
    expect(app.flashed.success[0]).toMatch(/Erased 2 accounts/);
    expect(app.flashed.error.pop()).toMatch(/#1: That is your own account/);
  });
});

describe('takedowns', () => {
  it('any administrator can take a profile out of the directory, through Moderation', async () => {
    jest.spyOn(Moderation, 'setProfileHidden').mockResolvedValue({ changed: true });
    const app = buildApp(ADMIN);
    await request(app).post('/admin/users/9/talent').type('form').send({ hidden: 'on', reason: ' spam ' });
    expect(Moderation.setProfileHidden).toHaveBeenCalledWith(9, true, { actorUserId: 2, reason: 'spam' });
    await request(app).post('/admin/users/2/talent').type('form').send({ hidden: 'on' });
    expect(Moderation.setProfileHidden).toHaveBeenCalledTimes(1);
  });

  it('an advert is hidden or restored, never deleted or re-statused', async () => {
    jest.spyOn(Moderation, 'setJobHidden').mockResolvedValue({ changed: true, job: { title: 'Architect' } });
    const app = buildApp(ADMIN);
    await request(app).post('/admin/jobs/4/hidden').type('form').send({ hidden: 'on' });
    await request(app).post('/admin/jobs/4/hidden').type('form').send({});
    expect(Moderation.setJobHidden.mock.calls.map((c) => c[1])).toEqual([true, false]);
    expect((await request(app).post('/admin/jobs/4.map/hidden')).status).toBe(404);
  });
});

describe('/admin/errors/export.csv', () => {
  it('neutralises a cell that would run as a formula, and carries no stack trace', async () => {
    jest.spyOn(ErrorLog, 'exportRows').mockResolvedValue([
      { created_at: new Date('2026-10-29T10:00:00Z'), status_code: 500, method: 'GET', path: '=HYPERLINK("http://evil")', message: 'a, "b"', user_id: null, stack: 'secret' }
    ]);
    const res = await request(buildApp(ADMIN)).get('/admin/errors/export.csv');
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\r\n')[0]).toBe('created_at,status_code,method,path,message,user_id');
    expect(res.text).toContain('"\'=HYPERLINK(""http://evil"")"');
    expect(res.text).toContain('"2026-10-29T10:00:00.000Z"');
    expect(res.text).not.toContain('secret');
  });
});
