'use strict';

/**
 * Placement fees.
 *
 * The rates live here, in version control with an author and a diff, for the same reason
 * every other catalogue value does — `config/settings.js` draws that line and this is on the
 * catalogue side of it. A placement fee is a commercial term, not an operational switch.
 *
 * THE ARITHMETIC IS THE POINT OF THIS FILE.
 *
 * The reference computes its fee as
 *
 *     const feeAmount = Math.round((contractValue * feePercentage) / 100);
 *     const amountInCents = feeAmount * 100;
 *
 * on a `parseFloat` of a DECIMAL column — a fee rounded to WHOLE currency units and only
 * then converted to cents. A €47,350 contract at 15% is €7,102.50; that code charges
 * €7,103.00. The customer pays fifty cents more than the rate they agreed to, and
 * `Math.round` pushes every half-unit the same way, which is upward.
 *
 * Here the contract value is already an integer number of minor units, the rate is basis
 * points, and the fee is `value * bps / 10000` rounded DOWN — the same direction
 * `Referral.commissionMinor` rounds, and for the same reason: rounding a charge up by
 * default bills somebody more than the agreement says.
 */

/**
 * What kind of placement, and what the standard rate is.
 *
 * `rateBps` is basis points: 1500 is 15.00%. `basis` is what the value is measured against,
 * and it is shown to the company beside the figure — a percentage with no stated basis is a
 * percentage of something the two parties can each assume differently.
 */
const PLACEMENT_KINDS = Object.freeze([
  {
    value: 'contract',
    label: 'Contract placement',
    rateBps: 1500,
    basis: 'The first six months of the contract value'
  },
  {
    value: 'permanent',
    label: 'Permanent placement',
    rateBps: 2000,
    basis: 'The first year of the annual salary'
  },
  {
    value: 'project',
    label: 'Project placement',
    rateBps: 1000,
    basis: 'The agreed project value'
  }
]);

const PLACEMENT_KIND_VALUES = Object.freeze(PLACEMENT_KINDS.map((k) => k.value));

/**
 * The lifecycle. `paid` and `cancelled` are terminal.
 *
 * There is no delete: a cancelled placement is a record that somebody agreed a fee and it
 * did not complete, which is exactly the row anybody asks about later. Same reasoning as the
 * invoice that is cancelled rather than removed.
 */
const PLACEMENT_TRANSITIONS = Object.freeze({
  agreed: ['paid', 'cancelled'],
  paid: [],
  cancelled: []
});

const PLACEMENT_STATUSES = Object.freeze(Object.keys(PLACEMENT_TRANSITIONS));

const LIMITS = Object.freeze({
  name: 200,
  note: 500,
  reason: 300,
  // Minor units. The floor exists for the same reason the deposit's does: below it the
  // payment costs more to process than it collects. The ceiling is a typo guard.
  minContractMinor: 100_000, // €1,000.00
  maxContractMinor: 100_000_000_000 // €1,000,000,000.00
});

function isPlacementKind(value) {
  return PLACEMENT_KIND_VALUES.includes(value);
}

function isPlacementStatus(value) {
  return PLACEMENT_STATUSES.includes(value);
}

function canTransition(from, to) {
  return Boolean(PLACEMENT_TRANSITIONS[from] && PLACEMENT_TRANSITIONS[from].includes(to));
}

/**
 * The standard rate for a kind, in basis points.
 *
 * Returns null for an unknown kind and the caller REFUSES. The reference writes
 * `packages.placementFees[type]?.percentage || 15`, which has two faults in one line: an
 * unrecognised placement type silently bills at 15%, and a rate deliberately set to 0 is
 * falsy and also bills at 15%. A price nobody chose is the one thing a pricing table must
 * not produce.
 */
function rateBpsFor(kind) {
  const found = PLACEMENT_KINDS.find((k) => k.value === kind);
  return found ? found.rateBps : null;
}

function kindLabel(kind) {
  const found = PLACEMENT_KINDS.find((k) => k.value === kind);
  return found ? found.label : kind;
}

/**
 * The fee, in minor units, on integers.
 *
 * STRICT ABOUT THE TYPE, not just the value: a numeric string means a caller handed this
 * unvalidated request data, and coercing it is how a form field becomes a liability. Same
 * rule as `Referral.commissionMinor`, which exists for the same reason.
 *
 * Rounds DOWN. A fee is a debt somebody owes; rounding it up by default charges more than
 * the stated rate.
 */
function feeMinor(contractValueMinor, rateBps) {
  if (!Number.isInteger(contractValueMinor) || !Number.isInteger(rateBps)) return null;
  if (contractValueMinor < 0 || rateBps < 0 || rateBps > 10_000) return null;
  return Math.floor((contractValueMinor * rateBps) / 10_000);
}

/** Asserted at boot beside the other catalogues. */
function assertPlacementIntegrity() {
  if (!PLACEMENT_KINDS.length) throw new Error('at least one placement kind is needed');

  const seen = new Set();
  for (const kind of PLACEMENT_KINDS) {
    if (seen.has(kind.value)) throw new Error(`duplicate placement kind ${kind.value}`);
    seen.add(kind.value);
    if (!Number.isInteger(kind.rateBps) || kind.rateBps < 0 || kind.rateBps > 10_000) {
      throw new Error(`placement kind ${kind.value} has a bad rateBps`);
    }
    // A rate with no stated basis is a percentage of something each party can assume
    // differently, which is the argument this feature exists to prevent.
    if (!kind.basis || kind.basis.length < 10) throw new Error(`placement kind ${kind.value} states no basis`);
  }

  for (const [from, targets] of Object.entries(PLACEMENT_TRANSITIONS)) {
    for (const to of targets) {
      if (!PLACEMENT_TRANSITIONS[to]) throw new Error(`transition ${from} -> ${to} names an undeclared status`);
    }
  }
  if (PLACEMENT_TRANSITIONS.paid.length) throw new Error('paid must be terminal');
  if (PLACEMENT_TRANSITIONS.cancelled.length) throw new Error('cancelled must be terminal');

  /*
   * The arithmetic, checked at boot with the case that exposes the reference's bug:
   * €47,350.00 at 15.00% is €7,102.50 exactly. Their code charges €7,103.00.
   */
  const sample = feeMinor(4_735_000, 1500);
  if (sample !== 710_250) throw new Error(`placement fee arithmetic changed: ${sample}`);

  // And that a string is refused rather than coerced.
  if (feeMinor('4735000', 1500) !== null) throw new Error('feeMinor must refuse a numeric string');

  return true;
}

module.exports = {
  PLACEMENT_KINDS,
  PLACEMENT_KIND_VALUES,
  PLACEMENT_TRANSITIONS,
  PLACEMENT_STATUSES,
  LIMITS,
  isPlacementKind,
  isPlacementStatus,
  canTransition,
  rateBpsFor,
  kindLabel,
  feeMinor,
  assertPlacementIntegrity
};
