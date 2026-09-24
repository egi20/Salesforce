-- 026 Placement fees.
--
-- Ported from the reference as a CORRECTION, which is what "do it like theirs" has to mean
-- here: the shape is right and most of the arithmetic is not. What they got right, and it is
-- the important half: the contract value is agreed and stored SERVER-SIDE, and the fee is
-- derived from that stored row rather than from anything the browser sends. Their own
-- security audit calls that the C3 price-tampering finding, and closing it structurally is
-- the same thing `config/payments.js` does for every other product here.
--
-- WHAT IS FIXED, and every one of these is a rule this codebase already states:
--
-- 1. DECIMAL AND parseFloat BECOME MINOR-UNIT INTEGERS. Theirs stores
--    `contract_value DECIMAL(12,2)`, reads it back with `parseFloat`, and computes
--    `Math.round((contractValue * feePercentage) / 100)` — a fee in WHOLE units, then
--    multiplied by 100 to reach cents. A €47,350 contract at 15% is €7,102.50 and their
--    checkout charges €7,103.00. The customer is overcharged fifty cents on a figure they
--    agreed, and `Math.round` sends every half-unit the same way. Here the value is an
--    integer number of minor units and the fee is computed on integers.
--
-- 2. THE RATE IS BASIS POINTS, not a float percentage. `1500` is 15.00%, so
--    `amount_minor * rate_bps / 10000` is exact — the same reason `commission_ledger`
--    carries `rate_bps` rather than the DECIMAL percentage the reference stored there and
--    then reconciled with a `+ 0.001` tolerance in every comparison.
--
-- 3. THE RATE IS SNAPSHOT ON THE ROW. Theirs reads the percentage out of the live pricing
--    config at checkout time, so renegotiating the standard rate silently reprices every
--    quote already agreed with a client. Same rule as `referral_attributions`, and the same
--    rule as a stored quote keeping its catalogue version: an agreement made on a date is
--    priced under the terms of that date.
--
-- 4. DATETIME, NOT TIMESTAMP. Theirs makes `created_at` the first TIMESTAMP column of the
--    table, which with `explicit_defaults_for_timestamp` off gives it an implicit
--    `ON UPDATE CURRENT_TIMESTAMP` — so marking a quote paid re-dates when it was created.
--
-- 5. A CURRENCY COLUMN. Theirs has none at all: a contract value with no currency beside it
--    is a number that means something different depending on who reads it.
--
-- 6. THE SCHEMA LIVES HERE, not in `PlacementQuote.initializeTables()` running
--    `CREATE TABLE IF NOT EXISTS` on boot.

CREATE TABLE placement_quotes (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Opaque and unguessable, because it is the identifier a company is given to pay against.
  -- A sequential id in that position is an invitation to try the neighbouring numbers.
  reference           CHAR(30)     NOT NULL,

  -- Who owes the fee. The payer must be this account; the resolver re-checks it.
  company_user_id     INT UNSIGNED NOT NULL,

  -- Who was placed. Recorded as typed rather than joined: the consultant may have no account
  -- here, and a placement agreed in March must still read correctly when a profile changes.
  consultant_name     VARCHAR(200) NOT NULL,
  consultant_user_id  INT UNSIGNED NULL DEFAULT NULL,
  job_title           VARCHAR(200) NOT NULL,

  placement_kind      VARCHAR(16)  NOT NULL,

  -- MINOR UNITS, integer, with the currency beside it.
  contract_value_minor BIGINT      NOT NULL,
  currency            CHAR(3)      NOT NULL DEFAULT 'EUR',

  -- Basis points, snapshot at agreement. 1500 = 15.00%.
  rate_bps            SMALLINT UNSIGNED NOT NULL,

  -- Derived once, here, from the two columns above and stored so that what the company is
  -- asked to pay is the same figure on the agreement, the checkout page and the invoice.
  -- `utils/documents/` calls this rule "render, never recompute"; it applies to money on a
  -- screen for the same reason it applies to money in a document.
  fee_minor           BIGINT       NOT NULL,

  status              VARCHAR(16)  NOT NULL DEFAULT 'agreed',
  note                VARCHAR(500) NULL DEFAULT NULL,

  agreed_by           INT UNSIGNED NULL DEFAULT NULL,
  cancelled_at        DATETIME     NULL DEFAULT NULL,
  cancel_reason       VARCHAR(300) NULL DEFAULT NULL,

  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_placement_reference (reference),
  KEY idx_placement_company (company_user_id, status),
  KEY idx_placement_status (status, created_at),
  CONSTRAINT fk_placement_company FOREIGN KEY (company_user_id) REFERENCES users (id),
  CONSTRAINT fk_placement_consultant FOREIGN KEY (consultant_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_placement_agreed_by FOREIGN KEY (agreed_by) REFERENCES users (id) ON DELETE SET NULL,

  -- A fee of zero is a placement nobody is charging for, which is a decision somebody can
  -- make; a negative one is a bug. The contract value has a floor for the same reason the
  -- deposit does: below it the payment costs more to process than it collects.
  CONSTRAINT chk_placement_fee CHECK (fee_minor >= 0 AND contract_value_minor > 0),
  CONSTRAINT chk_placement_rate CHECK (rate_bps <= 10000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The fulfilment table. EXCLUSIVE, so it carries a unique key on its SUBJECT as well as on
-- the payment: two checkout tabs against one placement are two DIFFERENT payments, and only
-- one may settle it. The per-payment key cannot give that guard.
--
-- The reference has no such key. Its webhook asks `markPaid` whether this call moved the row
-- and, when it did not, LOGS A LINE AND RETURNS — so the losing tab's money is captured, no
-- fee record is created, no invoice is raised, and nobody is told. Here the unique key makes
-- the second insert a no-op, the handler reports a collision, and `fulfil()` flags the
-- payment `needs_refund` so it appears in /admin/payments for a person to decide about.
CREATE TABLE placement_fees (
  id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  placement_quote_id   INT UNSIGNED NOT NULL,
  payment_id           INT UNSIGNED NOT NULL,

  -- Snapshot of what was charged and on what basis, so the fee record reconciles on its own
  -- without joining back to a row that may since have been cancelled.
  contract_value_minor BIGINT       NOT NULL,
  rate_bps             SMALLINT UNSIGNED NOT NULL,
  amount_minor         BIGINT       NOT NULL,
  currency             CHAR(3)      NOT NULL DEFAULT 'EUR',

  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_placement_fee_payment (payment_id),
  UNIQUE KEY uq_placement_fee_subject (placement_quote_id),
  CONSTRAINT fk_placement_fee_quote FOREIGN KEY (placement_quote_id) REFERENCES placement_quotes (id),
  CONSTRAINT fk_placement_fee_payment FOREIGN KEY (payment_id) REFERENCES payments (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
