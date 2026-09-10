'use strict';

const { promisePool, withTransaction } = require('../config/database');
const Payment = require('../models/Payment');
const Invoice = require('../models/Invoice');
const Notification = require('../models/Notification');
const { JOB_FEATURE_DAYS, formatMinor } = require('../config/payments');

/**
 * Turning money into the thing that was bought.
 *
 * Two callers reach this: the Stripe webhook, and the /payments/success page the buyer
 * lands on. They RACE, always — Stripe's redirect and Stripe's webhook are independent
 * — and both must be safe to run, in either order, any number of times. The reference
 * implementation's hardest-won payment bug was gating fulfilment on the payment's own
 * status: the success page flipped the row to 'completed' without creating anything, and
 * the webhook then skipped fulfilment entirely because the row already looked done.
 *
 * So fulfilment is NOT gated on status. It is gated on the database:
 *
 *   * `Payment.markPaid` is a conditional UPDATE that reports who moved the row. It
 *     decides who SENDS THE RECEIPT, and nothing else.
 *   * every write below is an INSERT IGNORE against a UNIQUE key. Running twice inserts
 *     nothing the second time, whatever order the callers arrive in.
 *
 * The one case the per-payment keys cannot catch is TWO PAYMENTS FOR ONE SUBJECT — two
 * checkout tabs open against the same quote. There the unique key on the subject decides,
 * the loser fulfils nothing, and its payment is flagged for a human to refund. It is
 * never refunded automatically: reversing a charge from inside a webhook handler is an
 * irreversible act taken on a partial view of the world.
 */

const HANDLERS = {
  /**
   * A featured window on a job. Additive: a renewal bought while a window is open starts
   * where that one ends, so buying twice buys twice the time rather than colliding.
   *
   * The start date is computed INSIDE the insert. Reading the current end and then
   * inserting would be a race between two concurrent renewals, and both would start now.
   */
  async job_feature(conn, payment) {
    const [result] = await conn.query(
      `INSERT IGNORE INTO job_features (job_id, payment_id, starts_at, ends_at)
       SELECT ?, ?, w.starts, DATE_ADD(w.starts, INTERVAL ? DAY)
         FROM (
           SELECT GREATEST(COALESCE(MAX(ends_at), NOW()), NOW()) AS starts
             FROM job_features WHERE job_id = ?
         ) w`,
      [payment.subject_id, payment.id, JOB_FEATURE_DAYS, payment.subject_id]
    );
    // affectedRows 0 means this payment already has its window: a duplicate delivery.
    return { fulfilled: result.affectedRows === 1, collided: false };
  },

  /**
   * The deposit against a quote. EXCLUSIVE: `quote_deposits.quote_id` is unique.
   *
   * A zero-row insert is ambiguous — it is either our own second attempt or a different
   * payment having settled this quote first — so the existing row is read to tell them
   * apart. Only the second is a collision, and only a collision needs a refund.
   */
  async quote_deposit(conn, payment) {
    const basis = payment.price_basis || {};
    const [result] = await conn.query(
      `INSERT IGNORE INTO quote_deposits
         (quote_id, payment_id, amount_minor, percent, quote_total, currency)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        payment.subject_id,
        payment.id,
        payment.amount_minor,
        basis.percent || 0,
        basis.quoteTotal || 0,
        payment.currency
      ]
    );
    if (result.affectedRows === 1) return { fulfilled: true, collided: false };

    const [rows] = await conn.query(
      'SELECT payment_id FROM quote_deposits WHERE quote_id = ? LIMIT 1',
      [payment.subject_id]
    );
    const holder = rows[0] && rows[0].payment_id;
    if (holder === payment.id) return { fulfilled: false, collided: false };
    return { fulfilled: false, collided: true, holderPaymentId: holder || null };
  }
};

/** Who the invoice is made out to, snapshot at the moment it is raised. */
async function billingDetailsFor(userId) {
  const [rows] = await promisePool.query(
    `SELECT u.email, u.first_name, u.last_name, cp.company_name
       FROM users u
       LEFT JOIN company_profiles cp ON cp.user_id = u.id
      WHERE u.id = ? LIMIT 1`,
    [userId]
  );
  const row = rows[0] || {};
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return {
    name: name || row.company_name || 'Customer',
    email: row.email || '',
    company: row.company_name || null
  };
}

/**
 * Settle and fulfil one payment.
 *
 * Safe to call from the webhook and from the success page, in any order, any number of
 * times. `source` only ever reaches the audit trail — it must never change the outcome,
 * because "which caller got here first" is not something either caller can know.
 *
 * @returns {Promise<{claimed:boolean, fulfilled:boolean, collided:boolean}>}
 */
async function fulfil(payment, { source = 'unknown', stripeSessionId = null, stripePaymentIntentId = null } = {}) {
  if (!payment) return { claimed: false, fulfilled: false, collided: false };

  const handler = HANDLERS[payment.product];
  if (!handler) {
    // A product removed from the catalogue while a checkout was open. The money is real,
    // so this is a refund queue item, not a silent drop.
    await Payment.flagRefundRequired(payment.id, `No fulfilment handler for product "${payment.product}"`);
    return { claimed: false, fulfilled: false, collided: false };
  }

  const claimed = await Payment.markPaid(payment.id, { stripeSessionId, stripePaymentIntentId });
  await Payment.recordEvent({
    paymentId: payment.id,
    eventType: claimed ? 'paid' : 'paid_duplicate',
    detail: `source=${source}`
  });

  // Re-read: markPaid may have filled in the session or intent id, and the handlers and
  // the invoice must see the settled row rather than the pending one they were handed.
  const settled = (await Payment.findById(payment.id)) || payment;

  let outcome;
  try {
    outcome = await withTransaction(async (conn) => {
      const result = await handler(conn, settled);
      if (result.collided) {
        // Roll the whole thing back — no fulfilment row, and above all no invoice for a
        // payment that is about to be refunded.
        const err = new Error('subject already settled');
        err.code = 'SUBJECT_ALREADY_SETTLED';
        err.holderPaymentId = result.holderPaymentId;
        throw err;
      }
      // INSERT IGNORE on a unique payment_id: raised once, by whichever call gets here
      // first, and a no-op for every other.
      const billTo = await billingDetailsFor(settled.user_id);
      const raised = await Invoice.createFor(conn, { payment: settled, billTo });
      return { fulfilled: result.fulfilled, invoiceRaised: raised };
    });
  } catch (err) {
    if (err.code === 'SUBJECT_ALREADY_SETTLED') {
      await Payment.flagRefundRequired(
        settled.id,
        `Subject ${settled.subject_type}#${settled.subject_id} was already settled by payment #${err.holderPaymentId}`
      );
      return { claimed, fulfilled: false, collided: true };
    }
    throw err;
  }

  // Only the caller that actually claimed the payment tells the buyer, so a webhook and
  // a page refresh do not produce two receipts. The dedupe key would make a second one
  // a no-op anyway; not sending it is cheaper than relying on that.
  if (claimed) {
    await Notification.emit({
      userId: settled.user_id,
      type: 'payment_received',
      title: `Payment received — ${formatMinor(settled.amount_minor, settled.currency)}`,
      body: settled.description,
      link: '/payments/history',
      dedupeKey: `payment:${settled.id}:received`
    });
  }

  return { claimed, fulfilled: Boolean(outcome && outcome.fulfilled), collided: false };
}

module.exports = { fulfil, billingDetailsFor, HANDLERS };
