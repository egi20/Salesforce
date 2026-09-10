'use strict';

const {
  depositForTotal,
  formatMinor,
  isValidProduct,
  productFor,
  assertPaymentIntegrity,
  PRODUCTS,
  DEPOSIT_PERCENT,
  DEPOSIT_MIN_MINOR,
  DEPOSIT_MAX_MINOR,
  JOB_FEATURE_PRICE_MINOR
} = require('../../config/payments');
const Payment = require('../../models/Payment');
const Invoice = require('../../models/Invoice');

describe('the payment catalogue', () => {
  it('starts only if every product can price itself', () => {
    expect(assertPaymentIntegrity()).toBe(true);
  });

  it('names a subject type for every product, because a price needs something to be a price OF', () => {
    for (const product of Object.values(PRODUCTS)) {
      expect(typeof product.subjectType).toBe('string');
      expect(product.subjectType.length).toBeGreaterThan(0);
      expect(typeof product.resolve).toBe('function');
    }
  });

  it('refuses a product key it does not know', () => {
    expect(isValidProduct('free_money')).toBe(false);
    expect(productFor('free_money')).toBeNull();
    expect(productFor('job_feature')).toBe(PRODUCTS.job_feature);
  });

  it('prices the featured placement as whole integer minor units', () => {
    expect(Number.isInteger(JOB_FEATURE_PRICE_MINOR)).toBe(true);
    expect(JOB_FEATURE_PRICE_MINOR % 100).toBe(0);
  });
});

describe('the deposit calculation', () => {
  it('takes the stated percentage of a mid-sized quote', () => {
    // €120,000 -> 10% -> €12,000
    expect(depositForTotal(120000)).toBe(1200000);
    expect(DEPOSIT_PERCENT).toBe(10);
  });

  it('rounds to a whole currency unit, so an invoice never shows stray cents', () => {
    // 10% of €7,777.77 is €777.777; the deposit is a round €778.
    expect(depositForTotal(7777.77) % 100).toBe(0);
    expect(depositForTotal(7777.77)).toBe(77800);
  });

  it('applies the floor rather than charging a fee-eating amount', () => {
    // 10% of €900 is €90, which costs more to process and reconcile than it secures.
    expect(depositForTotal(900)).toBe(DEPOSIT_MIN_MINOR);
  });

  it('applies the cap rather than sending a card an amount it will refuse', () => {
    expect(depositForTotal(4000000)).toBe(DEPOSIT_MAX_MINOR);
  });

  it('answers null rather than zero for a quote with no payable total', () => {
    // Null is a refusal the caller must handle. Zero is a free checkout nobody intended.
    expect(depositForTotal(0)).toBeNull();
    expect(depositForTotal(null)).toBeNull();
    expect(depositForTotal('nonsense')).toBeNull();
    expect(depositForTotal(-5000)).toBeNull();
  });

  it('always returns an integer number of minor units', () => {
    for (const total of [1234.56, 99999.99, 501.01, 250000.5]) {
      expect(Number.isInteger(depositForTotal(total))).toBe(true);
    }
  });
});

describe('money formatting', () => {
  it('renders minor units as a currency amount, never as raw cents', () => {
    expect(formatMinor(14900)).toContain('149.00');
    expect(formatMinor(0)).toContain('0.00');
  });
});

describe('payment references', () => {
  it('leaves out the characters people mistype off a document', () => {
    for (let i = 0; i < 200; i += 1) {
      const reference = Payment.generateReference();
      expect(reference.startsWith('PAY-')).toBe(true);
      expect(reference.slice(4)).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
      expect(reference.slice(4)).not.toMatch(/[ILOU]/);
    }
  });

  it('does not repeat itself across a realistic number of payments', () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i += 1) seen.add(Payment.generateReference());
    expect(seen.size).toBe(5000);
  });
});

describe('invoice numbering', () => {
  it('is derived from the payment id, so there is no counter to race for', () => {
    expect(Invoice.numberFor(42, new Date('2026-03-01T00:00:00Z'))).toBe('INV-2026-000042');
    expect(Invoice.numberFor(7, new Date('2027-12-31T23:00:00Z'))).toBe('INV-2027-000007');
  });

  it('is unique whenever the payment id is', () => {
    const issued = new Date('2026-01-01T00:00:00Z');
    const numbers = new Set([1, 2, 3, 999999].map((id) => Invoice.numberFor(id, issued)));
    expect(numbers.size).toBe(4);
  });
});

describe('Payment.create', () => {
  it('refuses an amount that is not a positive integer of minor units', async () => {
    // A float amount is how a total ends up a cent away from the sum of its parts, and a
    // zero or negative one is a checkout nobody meant to create.
    for (const amountMinor of [0, -100, 149.5, NaN, '14900']) {
      // eslint-disable-next-line no-await-in-loop
      await expect(
        Payment.create({
          userId: 1,
          product: 'job_feature',
          subjectType: 'job',
          subjectId: 1,
          amountMinor,
          currency: 'EUR',
          description: 'test'
        })
      ).rejects.toThrow(/positive integer/);
    }
  });
});

describe('Payment.markUnpaid', () => {
  it('refuses to write a status that is not a terminal failure', async () => {
    // Nothing may walk a payment into 'paid' or 'refunded' through this door.
    await expect(Payment.markUnpaid(1, 'paid')).rejects.toThrow(/refusing status/);
    await expect(Payment.markUnpaid(1, 'refunded')).rejects.toThrow(/refusing status/);
  });
});
