'use strict';

const { HANDLERS } = require('../../services/paymentFulfilment');
const { JOB_FEATURE_DAYS } = require('../../config/payments');

/**
 * The fulfilment handlers, against a stub connection.
 *
 * The webhook and the /success page race by definition — Stripe fires the redirect and
 * the delivery independently — so every handler has to be safe run twice, in either
 * order. These tests hold the two cases apart that a single "already done?" check would
 * merge and get wrong:
 *
 *   * SAME payment, twice  -> a duplicate delivery. Nothing to do, nothing is wrong.
 *   * TWO payments, one subject -> two checkout tabs. One settles; the other is money
 *     that must be refunded, and it must not be mistaken for the harmless case.
 */
function stubConn({ insertAffected = 1, existingHolder = null }) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/^\s*INSERT/i.test(sql)) return [{ affectedRows: insertAffected }];
      // The follow-up read that tells the two zero-row cases apart.
      return [existingHolder === null ? [] : [{ payment_id: existingHolder }]];
    }
  };
}

const jobPayment = {
  id: 10,
  user_id: 1,
  product: 'job_feature',
  subject_type: 'job',
  subject_id: 55,
  amount_minor: 14900,
  currency: 'EUR',
  description: 'Featured placement',
  price_basis: { flatMinor: 14900, days: JOB_FEATURE_DAYS }
};

const depositPayment = {
  id: 20,
  user_id: 2,
  product: 'quote_deposit',
  subject_type: 'quote',
  subject_id: 77,
  amount_minor: 1200000,
  currency: 'EUR',
  description: 'Project deposit',
  price_basis: { percent: 10, quoteTotal: 120000 }
};

describe('featured-placement fulfilment', () => {
  it('opens a window when the insert wins', async () => {
    const conn = stubConn({ insertAffected: 1 });
    const result = await HANDLERS.job_feature(conn, jobPayment);
    expect(result).toEqual({ fulfilled: true, collided: false });
  });

  it('computes the start date inside the INSERT, so two renewals cannot both start now', async () => {
    const conn = stubConn({ insertAffected: 1 });
    await HANDLERS.job_feature(conn, jobPayment);
    const { sql } = conn.queries[0];
    // Read-then-insert would be a race between concurrent renewals; the subselect is not
    // a stylistic choice.
    expect(sql).toMatch(/INSERT IGNORE INTO job_features/);
    expect(sql).toMatch(/GREATEST\(COALESCE\(MAX\(ends_at\), NOW\(\)\), NOW\(\)\)/);
    expect(sql).not.toMatch(/^\s*SELECT/);
  });

  it('is a clean no-op on a duplicate delivery of the same payment', async () => {
    const conn = stubConn({ insertAffected: 0 });
    const result = await HANDLERS.job_feature(conn, jobPayment);
    expect(result).toEqual({ fulfilled: false, collided: false });
  });

  it('never reports a collision, because two windows on one job are legitimate', async () => {
    // Buying again while a window is open EXTENDS it. That is the product, not a clash.
    const conn = stubConn({ insertAffected: 1 });
    const result = await HANDLERS.job_feature(conn, jobPayment);
    expect(result.collided).toBe(false);
  });
});

describe('quote-deposit fulfilment', () => {
  it('records the deposit when the insert wins', async () => {
    const conn = stubConn({ insertAffected: 1 });
    const result = await HANDLERS.quote_deposit(conn, depositPayment);
    expect(result).toEqual({ fulfilled: true, collided: false });
  });

  it('snapshots what the deposit was a percentage OF', async () => {
    const conn = stubConn({ insertAffected: 1 });
    await HANDLERS.quote_deposit(conn, depositPayment);
    // The percentage and the quote total travel with the row: an invoice must be
    // explicable later without re-deriving anything from a catalogue that has moved.
    expect(conn.queries[0].params).toEqual([77, 20, 1200000, 10, 120000, 'EUR']);
  });

  it('treats a zero-row insert HELD BY THIS PAYMENT as a duplicate delivery', async () => {
    const conn = stubConn({ insertAffected: 0, existingHolder: depositPayment.id });
    const result = await HANDLERS.quote_deposit(conn, depositPayment);
    expect(result).toEqual({ fulfilled: false, collided: false });
  });

  it('treats a zero-row insert HELD BY ANOTHER PAYMENT as a collision needing a refund', async () => {
    // Two checkout tabs against one quote produce two different payments, so the
    // per-payment key cannot see this. Only the unique key on quote_id can.
    const conn = stubConn({ insertAffected: 0, existingHolder: 999 });
    const result = await HANDLERS.quote_deposit(conn, depositPayment);
    expect(result.fulfilled).toBe(false);
    expect(result.collided).toBe(true);
    expect(result.holderPaymentId).toBe(999);
  });

  it('still calls a collision a collision when the holder cannot be read back', async () => {
    // Failing open here would silently keep money for a deposit nobody was credited.
    const conn = stubConn({ insertAffected: 0, existingHolder: null });
    const result = await HANDLERS.quote_deposit(conn, depositPayment);
    expect(result.collided).toBe(true);
    expect(result.holderPaymentId).toBeNull();
  });

  it('never issues an automatic refund from a handler', async () => {
    const conn = stubConn({ insertAffected: 0, existingHolder: 999 });
    await HANDLERS.quote_deposit(conn, depositPayment);
    // Reversing a charge is a decision with a person on the other end of it. The handler
    // reports the collision; a human works the queue.
    for (const { sql } of conn.queries) {
      expect(sql).not.toMatch(/refund/i);
    }
  });
});

describe('every product in the catalogue', () => {
  it('has a fulfilment handler, so no checkout can take money nothing can deliver', () => {
    const { PRODUCTS } = require('../../config/payments');
    for (const key of Object.keys(PRODUCTS)) {
      expect(typeof HANDLERS[key]).toBe('function');
    }
  });
});
