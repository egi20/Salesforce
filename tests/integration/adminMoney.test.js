'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

const Payment = require('../../models/Payment');
const Referral = require('../../models/Referral');
const User = require('../../models/User');
const { attachViewHelpers } = require('../../utils/viewHelpers');
const { notFound, errorHandler } = require('../../middleware/errorHandler');

/**
 * Two money actions ported from SAP Hub: recording a refund made in Stripe, and adding an
 * existing account to the referral scheme at an agreed rate. Both superadmin-only.
 */
const SUPER = { id: 1, isAdmin: true, isSuperadmin: true };
const ADMIN = { id: 2, isAdmin: true, isSuperadmin: false };

function buildApp(user) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  const flashed = { success: [], error: [], info: [] };
  app.flashed = flashed;
  app.use((req, res, next) => {
    req.session = { user };
    req.flash = (type, message) => { if (message === undefined) return flashed[type] || []; flashed[type].push(message); return undefined; };
    Object.assign(res.locals, { appName: 'Salesforce Hub', currentUser: user, csrfToken: 't', query: req.query, flash: flashed,
      assistantEnabled: false, siteNotice: '', seo: { title: 't', description: 'd', canonical: 'c', ogImage: 'o', indexable: false } });
    attachViewHelpers(res);
    next();
  });
  app.use('/admin', require('../../routes/admin'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

afterEach(() => jest.restoreAllMocks());

describe('recording a refund', () => {
  it('moves the payment and names the commission, but reverses nothing itself', async () => {
    jest.spyOn(Payment, 'recordRefund').mockResolvedValue(true);
    jest.spyOn(Referral, 'earnedForPayment').mockResolvedValue({ referrer_id: 4, amount_minor: 1490, currency: 'EUR' });
    const adjust = jest.spyOn(Referral, 'adjust');
    const app = buildApp(SUPER);
    await request(app).post('/admin/payments/8/refunded').type('form').send({ note: 're_123' });
    expect(Payment.recordRefund).toHaveBeenCalledWith(8, { actorUserId: 1, note: 're_123' });
    expect(adjust).not.toHaveBeenCalled();
    expect(app.flashed.info[0]).toMatch(/referrer #4 .*14[.,]90.*Nothing was reversed automatically/);
  });

  it('says so when the payment cannot be refunded, and is superadmin-only', async () => {
    jest.spyOn(Payment, 'recordRefund').mockResolvedValue(false);
    const app = buildApp(SUPER);
    await request(app).post('/admin/payments/8/refunded');
    expect(app.flashed.error[0]).toMatch(/not in a state/);
    Payment.recordRefund.mockClear();
    await request(buildApp(ADMIN)).post('/admin/payments/8/refunded');
    expect(Payment.recordRefund).not.toHaveBeenCalled();
  });

  it('only a PAID payment moves, in one statement with the flag', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', '..', 'models', 'Payment.js'), 'utf8');
    expect(src).toMatch(/UPDATE payments SET status = 'refunded', needs_refund = 0 WHERE id = \? AND status = 'paid'/);
  });
});

describe('adding a referrer', () => {
  beforeEach(() => {
    jest.spyOn(User, 'findByEmail').mockResolvedValue({ id: 9, email: 'p@x.test', name: 'P', is_active: 1 });
    jest.spyOn(Referral, 'findByUserId').mockResolvedValue(null);
    jest.spyOn(Referral, 'enrol').mockResolvedValue({ code: 'ABCDEFGH', rate_bps: 1250 });
  });

  it('enrols an existing account at the agreed rate, in basis points', async () => {
    await request(buildApp(SUPER)).post('/admin/referrals/add').type('form').send({ email: 'p@x.test', rate_percent: '12.5' });
    expect(Referral.enrol).toHaveBeenCalledWith(9, { rateBps: 1250 });
  });

  it('refuses a rate outside the scheme, a missing account, and an ordinary admin', async () => {
    const app = buildApp(SUPER);
    await request(app).post('/admin/referrals/add').type('form').send({ email: 'p@x.test', rate_percent: '45' });
    await request(app).post('/admin/referrals/add').type('form').send({ email: 'p@x.test', rate_percent: 'ten' });
    User.findByEmail.mockResolvedValueOnce(null);
    await request(app).post('/admin/referrals/add').type('form').send({ email: 'nobody@x.test' });
    await request(buildApp(ADMIN)).post('/admin/referrals/add').type('form').send({ email: 'p@x.test' });
    expect(Referral.enrol).not.toHaveBeenCalled();
    expect(app.flashed.error).toHaveLength(3);
  });
});
