'use strict';

const fs = require('fs');
const path = require('path');

const placements = require('../../config/placements');
const { PRODUCTS } = require('../../config/payments');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sqlOf = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * A migration with its `--` comments stripped.
 *
 * These migrations explain at length what the reference does wrong, quoting its DECIMAL
 * columns and its TIMESTAMP defaults. Matching the file raw makes a test fail on the very
 * sentence that promises the thing it is checking — which happened twice while this suite
 * was being written.
 */
const schemaOf = (p) => read(p).replace(/^\s*--.*$/gm, '');

describe('the placement fee, and the four things the reference gets wrong', () => {
  it('passes its boot assertion', () => {
    expect(placements.assertPlacementIntegrity()).toBe(true);
  });

  it('does not overcharge on a half unit', () => {
    /*
     * THE BUG. The reference computes
     *
     *     const feeAmount = Math.round((contractValue * feePercentage) / 100);
     *     const amountInCents = feeAmount * 100;
     *
     * — a fee rounded to WHOLE currency units before it is converted to cents. €47,350 at
     * 15% is €7,102.50; that code charges €7,103.00. The customer pays fifty cents more than
     * the rate they agreed to, and Math.round sends every half unit the same way: upward.
     */
    expect(placements.feeMinor(4_735_000, 1500)).toBe(710_250);

    // And the general property: never more than the exact figure, never less by a whole unit.
    for (const [value, bps] of [[4_735_000, 1500], [3_333_300, 1500], [1_000_000, 1250], [999_999, 777]]) {
      const exact = (value * bps) / 10_000;
      const charged = placements.feeMinor(value, bps);
      expect(charged).toBeLessThanOrEqual(exact);
      expect(exact - charged).toBeLessThan(1);
    }
  });

  it('refuses a numeric string rather than coercing it', () => {
    // Same rule as Referral.commissionMinor: a numeric string means a caller handed this
    // unvalidated request data, and coercing it is how a form field becomes a liability.
    expect(placements.feeMinor('4735000', 1500)).toBeNull();
    expect(placements.feeMinor(4_735_000, '1500')).toBeNull();
    expect(placements.feeMinor(4_735_000.5, 1500)).toBeNull();
  });

  it('an unknown placement kind has no rate, rather than a default nobody chose', () => {
    /*
     * The reference writes `packages.placementFees[type]?.percentage || 15`, which has two
     * faults in one line: an unrecognised type silently bills at 15%, and a rate deliberately
     * set to 0 is falsy and ALSO bills at 15%. A price nobody chose is the one thing a
     * pricing table must not produce.
     */
    expect(placements.rateBpsFor('nonsense')).toBeNull();
    expect(placements.rateBpsFor(undefined)).toBeNull();
    for (const kind of placements.PLACEMENT_KIND_VALUES) {
      expect(Number.isInteger(placements.rateBpsFor(kind))).toBe(true);
    }
    // And no source file falls back to a hardcoded rate.
    for (const file of ['config/placements.js', 'models/PlacementQuote.js', 'config/payments.js']) {
      expect(sqlOf(file)).not.toMatch(/\|\|\s*1500\b|\|\|\s*15\b|\|\|\s*2000\b/);
    }
  });

  it('every rate states what it is a percentage of', () => {
    // A percentage with no stated basis is a percentage of something each party can assume
    // differently, which is the argument this feature exists to avoid having.
    for (const kind of placements.PLACEMENT_KINDS) {
      expect(kind.basis.length).toBeGreaterThan(10);
    }
  });

  it('the rate is snapshot on the row, not read from config at checkout', () => {
    /*
     * The reference resolves the percentage from the LIVE pricing config when the company
     * pays, so renegotiating the standard rate reprices every placement already agreed with
     * a client. Same fault `referral_attributions` avoids by snapshotting, and the same one a
     * stored quote avoids by keeping its catalogue version.
     */
    expect(read('scripts/migrations/026_placements.sql')).toMatch(/rate_bps\s+SMALLINT/);
    // The resolver reads the STORED fee and never recomputes it.
    const resolver = PRODUCTS.placement_fee.resolve.toString();
    expect(resolver).toMatch(/p\.fee_minor/);
    expect(resolver).not.toMatch(/feeMinor\(|rateBpsFor\(/);
  });

  it('is an exclusive product with a unique key on its subject', () => {
    /*
     * The guard the per-payment key cannot give: two checkout tabs against one placement are
     * two DIFFERENT payments and only one may settle it. The reference has no such key — its
     * webhook asks markPaid whether the row moved and, on "no", logs a line and returns. The
     * losing tab's money is captured, no fee is recorded, no invoice is raised, nobody is
     * told.
     */
    expect(PRODUCTS.placement_fee.exclusive).toBe(true);
    expect(read('scripts/migrations/026_placements.sql')).toMatch(/UNIQUE KEY uq_placement_fee_subject/);
    expect(read('scripts/migrations/026_placements.sql')).toMatch(/UNIQUE KEY uq_placement_fee_payment/);

    // And the handler reports the collision rather than swallowing it, so fulfil() can flag
    // the payment for refund.
    const handler = sqlOf('services/paymentFulfilment.js');
    const placementHandler = handler.slice(handler.indexOf('async placement_fee'), handler.indexOf('async quote_deposit'));
    expect(placementHandler).toMatch(/collided: true/);
    expect(placementHandler).toMatch(/holderPaymentId/);
  });

  it('stores money as minor-unit integers and dates as DATETIME', () => {
    const migration = schemaOf('scripts/migrations/026_placements.sql');
    // No DECIMAL money column: the reference's `contract_value DECIMAL(12,2)` read back with
    // parseFloat is the same shape as the referrals bug it also had.
    expect(migration).not.toMatch(/DECIMAL\(\s*\d+\s*,\s*2\s*\)/);
    expect(migration).toMatch(/contract_value_minor BIGINT/);
    expect(migration).toMatch(/fee_minor\s+BIGINT/);
    /*
     * TIMESTAMP would make created_at the table's first such column, which with
     * explicit_defaults_for_timestamp off carries an implicit ON UPDATE CURRENT_TIMESTAMP —
     * so marking a placement paid would re-date when it was agreed.
     */
    expect(migration).not.toMatch(/\bTIMESTAMP\b/);
    expect(migration).toMatch(/created_at\s+DATETIME/);
  });

  it('keeps the schema in the migration, not in the model', () => {
    // The reference runs `CREATE TABLE IF NOT EXISTS` from `PlacementQuote.initializeTables()`
    // on boot, which is the first ground rule in CLAUDE.md.
    const model = read('models/PlacementQuote.js');
    expect(model).not.toMatch(/CREATE TABLE/i);
    expect(model).not.toMatch(/ALTER TABLE/i);
  });

  it('claimPaid is a claim, and fulfilment is never gated on reading a status first', () => {
    const model = sqlOf('models/PlacementQuote.js');
    // A conditional UPDATE that reports whether THIS call moved the row.
    expect(model).toMatch(/status = 'paid' WHERE id = \? AND status = 'agreed'/);
    expect(model).toMatch(/affectedRows === 1/);

    // The insert decides; the status follows. A handler that SELECTed the status to decide
    // whether to fulfil is the reference's worst payment bug wearing a new hat.
    const handler = sqlOf('services/paymentFulfilment.js');
    const placementHandler = handler.slice(handler.indexOf('async placement_fee'), handler.indexOf('async quote_deposit'));
    expect(placementHandler.indexOf('INSERT IGNORE')).toBeLessThan(placementHandler.indexOf('claimPaid'));
    expect(placementHandler).not.toMatch(/SELECT status/);
  });

  it('has no delete, and the fee never comes from the request', () => {
    expect(sqlOf('models/PlacementQuote.js')).not.toMatch(/DELETE FROM placement/);
    // The checkout route names a product and a subject. An amount in that handler would be
    // the price-tampering gap this whole design closes.
    const checkout = sqlOf('routes/payments.js');
    const handler = checkout.slice(checkout.indexOf("'/checkout/:product'"), checkout.indexOf("'/checkout/:product'") + 2500);
    expect(handler).not.toMatch(/req\.body\.amount|amountMinor\s*=\s*req\./);
  });
});
