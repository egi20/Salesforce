'use strict';

const {
  DEFAULT_RATE_BPS,
  MAX_RATE_BPS,
  MAX_COMMISSION_MINOR,
  MIN_PAYOUT_MINOR,
  COMMISSIONABLE_PRODUCTS,
  CODE_ALPHABET,
  CODE_LENGTH,
  commissionMinor,
  isCommissionableProduct,
  isValidPayoutMethod,
  assertReferralIntegrity
} = require('../../config/referrals');
const Referral = require('../../models/Referral');

/**
 * The referral scheme.
 *
 * This is the first module in the application that computes what somebody is OWED, so the
 * arithmetic is held to the payments standard: integers, minor units, and no path where a
 * rounding decision quietly favours the house or the referrer.
 */
describe('the scheme catalogue', () => {
  it('starts only if every policy number is coherent', () => {
    expect(assertReferralIntegrity()).toBe(true);
  });

  it('states the rate in basis points as an integer', () => {
    // Not a DECIMAL percentage. `amount_minor * rate_bps / 10000` on integers is exact;
    // the reference's DECIMAL rate through floats is what forced a `+ 0.001` tolerance
    // into every payout comparison.
    expect(Number.isInteger(DEFAULT_RATE_BPS)).toBe(true);
    expect(DEFAULT_RATE_BPS).toBeLessThanOrEqual(MAX_RATE_BPS);
  });

  it('names which products pay, rather than paying on everything', () => {
    // So that adding a product to config/payments.js cannot silently create a liability.
    expect(COMMISSIONABLE_PRODUCTS.length).toBeGreaterThan(0);
    expect(isCommissionableProduct('quote_deposit')).toBe(true);
    expect(isCommissionableProduct('some_future_product')).toBe(false);
  });

  it('constrains payout methods, because free text is unreconcilable', () => {
    expect(isValidPayoutMethod('bank_transfer')).toBe(true);
    expect(isValidPayoutMethod('cash in an envelope')).toBe(false);
  });
});

describe('the commission calculation', () => {
  it('takes the stated percentage of what was actually paid', () => {
    expect(commissionMinor(14900, 1000)).toBe(1490); // 10% of €149.00
    expect(commissionMinor(100000, 500)).toBe(5000); // 5% of €1,000.00
  });

  it('always returns a whole number of cents', () => {
    for (const amount of [1, 7, 333, 14900, 999999]) {
      for (const rate of [1, 250, 1000, 2999]) {
        expect(Number.isInteger(commissionMinor(amount, rate))).toBe(true);
      }
    }
  });

  it('rounds DOWN, so a fraction of a cent never inflates a liability', () => {
    // 10% of 7 cents is 0.7 — the referrer gets 0, not 1. Rounding a debt up by default
    // is how a balance ends up a cent above what the ledger can cover.
    expect(commissionMinor(7, 1000)).toBe(0);
    expect(commissionMinor(19, 1000)).toBe(1);
    expect(commissionMinor(199, 1000)).toBe(19);
  });

  it('caps a single commission', () => {
    // A €25,000 deposit at 10% would otherwise be a €2,500 liability created by one click.
    expect(commissionMinor(2500000, 1000)).toBe(MAX_COMMISSION_MINOR);
    expect(commissionMinor(100000000, 1000)).toBe(MAX_COMMISSION_MINOR);
  });

  it('clamps a rate above the ceiling rather than honouring it', () => {
    expect(commissionMinor(10000, 99999)).toBe(commissionMinor(10000, MAX_RATE_BPS));
  });

  it('earns nothing from a non-positive or nonsense amount', () => {
    for (const amount of [0, -100, 14900.5, NaN, '14900', null, undefined]) {
      expect(commissionMinor(amount, 1000)).toBe(0);
    }
  });

  it('earns nothing at a non-positive or nonsense rate', () => {
    for (const rate of [0, -500, 10.5, NaN, '1000', null, undefined]) {
      expect(commissionMinor(14900, rate)).toBe(0);
    }
  });

  it('never exceeds the amount that was actually paid', () => {
    // An obvious-sounding property, and exactly the one a mis-scaled basis-point divisor
    // would break: dividing by 100 instead of 10000 pays out a hundred times the fee.
    for (const amount of [100, 14900, 250000]) {
      expect(commissionMinor(amount, MAX_RATE_BPS)).toBeLessThan(amount);
    }
  });
});

describe('referral codes', () => {
  it('leaves out the characters people mistype', () => {
    for (let i = 0; i < 300; i += 1) {
      const code = Referral.generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).not.toMatch(/[ILOU]/);
      for (const character of code) expect(CODE_ALPHABET).toContain(character);
    }
  });

  it('does not repeat itself across a realistic number of members', () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i += 1) seen.add(Referral.generateCode());
    expect(seen.size).toBe(5000);
  });

  it('accepts a code as it would be typed or pasted', () => {
    const code = Referral.generateCode();
    expect(Referral.normaliseCode(` ${code.toLowerCase()} `)).toBe(code);
  });

  it('refuses anything that is not a code, rather than passing it to a query', () => {
    for (const bad of ['', '   ', 'SHORT', 'WAYTOOLONGFORACODE', "' OR 1=1 --", null, 42, {}]) {
      expect(Referral.normaliseCode(bad)).toBe('');
    }
  });

  it('refuses a code containing an excluded character', () => {
    // ILOU are not in the alphabet, so a code carrying one was mistyped or invented.
    expect(Referral.normaliseCode('ABCDIEFG')).toBe('');
    expect(Referral.normaliseCode('ABCD0EFG')).toBe('ABCD0EFG');
  });
});

describe('input guards on the money paths', () => {
  it('refuses an adjustment with no amount', async () => {
    for (const amountMinor of [0, 'lots', null, undefined, 1.5]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(Referral.adjust(1, { amountMinor, note: 'refund', actorUserId: 1 })).rejects.toMatchObject({
        code: 'BAD_ADJUSTMENT'
      });
    }
  });

  it('refuses an adjustment with no reason', async () => {
    // The reason is shown to the referrer. An unexplained debit on somebody's balance is
    // the thing that turns a scheme into a dispute.
    for (const note of ['', '   ', null, undefined]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(Referral.adjust(1, { amountMinor: -1000, note, actorUserId: 1 })).rejects.toMatchObject({
        code: 'REASON_REQUIRED'
      });
    }
  });

  it('refuses a payout through a method we cannot reconcile', async () => {
    await expect(Referral.payOut(1, { method: 'crypto' })).rejects.toMatchObject({
      code: 'BAD_PAYOUT_METHOD'
    });
  });

  it('sets a payout floor that a single capped commission can clear', () => {
    // Otherwise nobody is ever paid and the balance grows forever.
    expect(MIN_PAYOUT_MINOR).toBeLessThanOrEqual(MAX_COMMISSION_MINOR);
  });
});

describe('what the model does NOT expose', () => {
  it('has no way to set a balance', () => {
    // The balance is a SUM over commission_ledger and there is nothing to set. The
    // reference kept pending_earnings, total_earnings and paid_earnings on the referrer
    // row; the first time a crash lands between two statements, nobody can say which
    // number somebody is actually owed.
    const surface = Object.getOwnPropertyNames(Referral).join(' ');
    expect(surface).not.toMatch(/setBalance|updateEarnings|addEarnings|setPending/i);
  });

  it('has no automatic clawback path', () => {
    // A refund does not silently reverse a commission. `adjust` takes a human and a
    // reason, and that is the only door.
    const surface = Object.getOwnPropertyNames(Referral).join(' ');
    expect(surface).not.toMatch(/clawback|reverseCommission|autoRefund/i);
  });
});
