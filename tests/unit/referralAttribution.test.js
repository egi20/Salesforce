'use strict';

const { promisePool } = require('../../config/database');
const Referral = require('../../models/Referral');
const { ATTRIBUTION_WINDOW_DAYS } = require('../../config/referrals');

/**
 * Attribution and crediting, against a stubbed driver.
 *
 * These are the rules that decide whether money is owed at all, and every one of them
 * fails SILENTLY when it is wrong: a self-referral just looks like a generous member, a
 * credit outside the window just looks like a larger balance, and an exception swallowed
 * in the wrong place takes a paid-for service down with it.
 */
function stubQueries(handler) {
  return jest.spyOn(promisePool, 'query').mockImplementation(async (sql, params) => handler(sql, params));
}

const ACTIVE_REFERRER = { id: 7, user_id: 42, code: 'ABCD2345', rate_bps: 1000, is_active: 1 };

afterEach(() => jest.restoreAllMocks());

describe('attribution', () => {
  it('records an introduction for an active referrer', async () => {
    const inserts = [];
    stubQueries(async (sql, params) => {
      if (/FROM referrers WHERE code/.test(sql)) return [[ACTIVE_REFERRER]];
      if (/INSERT IGNORE INTO referral_attributions/.test(sql)) {
        inserts.push(params);
        return [{ affectedRows: 1 }];
      }
      return [[]];
    });

    expect(await Referral.attribute('ABCD2345', 99)).toBe(true);
    expect(inserts).toHaveLength(1);
    const [referrerId, referredUserId, code, rateBps, earnsUntil] = inserts[0];
    expect({ referrerId, referredUserId, code, rateBps }).toEqual({
      referrerId: 7,
      referredUserId: 99,
      code: 'ABCD2345',
      rateBps: 1000
    });
    // The window is stamped at attribution, not recomputed on read: extending it in config
    // later must not retroactively create a liability on an old introduction.
    const days = Math.round((earnsUntil - Date.now()) / (24 * 60 * 60 * 1000));
    expect(days).toBe(ATTRIBUTION_WINDOW_DAYS);
  });

  it('REFUSES a self-referral, and writes nothing at all', async () => {
    const inserts = [];
    stubQueries(async (sql, params) => {
      if (/FROM referrers WHERE code/.test(sql)) return [[ACTIVE_REFERRER]];
      if (/INSERT/.test(sql)) {
        inserts.push(params);
        return [{ affectedRows: 1 }];
      }
      return [[]];
    });

    // Not "insert then clean up later" — there is no path that creates one.
    expect(await Referral.attribute('ABCD2345', ACTIVE_REFERRER.user_id)).toBe(false);
    expect(inserts).toHaveLength(0);
  });

  it('refuses a paused referrer', async () => {
    stubQueries(async (sql) => {
      if (/FROM referrers WHERE code/.test(sql)) return [[{ ...ACTIVE_REFERRER, is_active: 0 }]];
      throw new Error('should not have reached an insert');
    });
    expect(await Referral.attribute('ABCD2345', 99)).toBe(false);
  });

  it('refuses an unknown code without issuing a query for it', async () => {
    const spy = stubQueries(async () => [[]]);
    // Malformed codes are rejected by the normaliser before SQL is involved at all.
    expect(await Referral.attribute("' OR 1=1 --", 99)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports false rather than throwing when the insert loses a race', async () => {
    // The unique key on referred_user_id makes a second attribution a no-op. First touch
    // wins, permanently — last touch would let anyone claim someone else's introduction.
    stubQueries(async (sql) => {
      if (/FROM referrers WHERE code/.test(sql)) return [[ACTIVE_REFERRER]];
      return [{ affectedRows: 0 }];
    });
    expect(await Referral.attribute('ABCD2345', 99)).toBe(false);
  });

  it('never throws, because a registration has already succeeded by the time it runs', async () => {
    stubQueries(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(Referral.attribute('ABCD2345', 99)).resolves.toBe(false);
  });
});

describe('crediting a settled payment', () => {
  const PAYMENT = {
    id: 501,
    user_id: 99,
    product: 'quote_deposit',
    amount_minor: 120000,
    currency: 'EUR'
  };

  const attribution = (overrides = {}) => ({
    referrer_id: 7,
    referred_user_id: 99,
    rate_bps: 1000,
    is_active: 1,
    earns_until: new Date(Date.now() + 86400000),
    ...overrides
  });

  function stubFor(attr, onInsert = () => [{ affectedRows: 1 }]) {
    const inserts = [];
    stubQueries(async (sql, params) => {
      if (/FROM referral_attributions/.test(sql)) return [attr ? [attr] : []];
      if (/INSERT IGNORE INTO commission_ledger/.test(sql)) {
        inserts.push(params);
        return onInsert();
      }
      return [[]];
    });
    return inserts;
  }

  it('credits the attributed referrer', async () => {
    const inserts = stubFor(attribution());
    const result = await Referral.credit(PAYMENT);
    expect(result.credited).toBe(12000); // 10% of €1,200.00
    expect(inserts[0][1]).toBe(12000);
    // Idempotent on the payment, so the webhook and the success page produce one entry.
    expect(inserts[0][6]).toBe('earn:501');
  });

  it('earns nothing for a payer nobody introduced', async () => {
    const inserts = stubFor(null);
    expect((await Referral.credit(PAYMENT)).credited).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('earns nothing once the window has closed, and writes no entry', async () => {
    const inserts = stubFor(attribution({ earns_until: new Date(Date.now() - 86400000) }));
    const result = await Referral.credit(PAYMENT);
    expect(result).toEqual({ credited: 0, reason: 'outside the earning window' });
    expect(inserts).toHaveLength(0);
  });

  it('earns nothing for a paused referrer', async () => {
    const inserts = stubFor(attribution({ is_active: 0 }));
    expect((await Referral.credit(PAYMENT)).credited).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('RECORDS a zero entry for a product that pays no commission', async () => {
    /*
     * A gap is worse than a zero here. "Your introduction bought something and it earned
     * nothing, because that product does not pay commission" is information the referrer
     * is owed; leaving it out is what produces the email asking where their money went.
     */
    const inserts = stubFor(attribution());
    const result = await Referral.credit({ ...PAYMENT, product: 'something_free' });
    expect(result.credited).toBe(0);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toBe(0);
    expect(String(inserts[0][5])).toMatch(/not a commissionable product/);
  });

  it('reports "already credited" when the dedupe key collides', async () => {
    stubFor(attribution(), () => [{ affectedRows: 0 }]);
    expect(await Referral.credit(PAYMENT)).toEqual({ credited: 0, reason: 'already credited' });
  });

  it('NEVER throws — the customer has already paid for the thing being fulfilled', async () => {
    stubQueries(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(Referral.credit(PAYMENT)).resolves.toEqual({ credited: 0, reason: 'error' });
  });
});
