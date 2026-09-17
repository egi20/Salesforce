-- 022 Finance: clients, invoices, costs.
--
-- THE TWO RULES THIS SCHEMA EXISTS TO ENFORCE, both broken by the reference implementation.
--
-- 1. AN INVOICE NUMBER IS ALLOCATED ONCE AND NEVER REUSED.
--    The reference reads `SELECT COALESCE(MAX(invoice_seq), 0) + 1 ... WHERE invoice_year = ?`
--    outside any transaction and then inserts. Two invoices issued in the same second read
--    the same maximum and both get the same number, and two invoices bearing one number is
--    not a display bug. Here a counter row is locked FOR UPDATE inside the transaction that
--    writes the invoice, and UNIQUE (invoice_year, invoice_seq) sits behind it so a bug in
--    that code fails loudly instead of quietly duplicating.
--
-- 2. AN ISSUED INVOICE IS NEVER DELETED.
--    `CompanyInvoice.remove(id)` there is a hard DELETE reachable from a list button at any
--    status. Deleting an issued invoice leaves a GAP in the sequence, which is the specific
--    thing an auditor looks for, and it cannot be undone. Here an issued invoice can only
--    be cancelled: the row stays, the number stays used, and every report shows it as a
--    cancellation rather than as an absence.

-- Who gets invoiced. Separate from `users` on purpose: most people you invoice never had an
-- account here, and a customer closing their marketplace account must not affect an invoice
-- already sent to them.
CREATE TABLE finance_clients (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(200) NOT NULL,
  contact_name VARCHAR(200) NULL DEFAULT NULL,
  email        VARCHAR(190) NULL DEFAULT NULL,

  -- Free text, deliberately multi-line: an invoice address has no reliable shape across
  -- jurisdictions, and splitting it into fields guarantees the one country it does not fit.
  address      VARCHAR(500) NULL DEFAULT NULL,
  country      CHAR(2)      NULL DEFAULT NULL,

  -- VAT number, company registration, whatever the jurisdiction calls it. Printed on the
  -- invoice exactly as entered; nothing here validates or looks it up.
  tax_id       VARCHAR(64)  NULL DEFAULT NULL,

  notes        VARCHAR(2000) NULL DEFAULT NULL,
  is_archived  TINYINT(1)   NOT NULL DEFAULT 0,

  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_finance_clients_name (name),
  KEY idx_finance_clients_archived (is_archived)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per year. Locked FOR UPDATE to hand out the next number, so two concurrent
-- issues serialise on it rather than racing a MAX().
CREATE TABLE finance_invoice_counters (
  invoice_year SMALLINT UNSIGNED NOT NULL,
  last_seq     INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (invoice_year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE finance_invoices (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id     INT UNSIGNED NOT NULL,

  -- NULL while it is a draft. A draft holds no number, which is what makes discarding one
  -- harmless: nothing was ever allocated, so nothing is left with a hole in it.
  invoice_year  SMALLINT UNSIGNED NULL DEFAULT NULL,
  invoice_seq   INT UNSIGNED NULL DEFAULT NULL,

  status        VARCHAR(16)  NOT NULL DEFAULT 'draft',

  -- The client's details AS THEY WERE when the invoice was issued. Copied rather than
  -- joined, for the same reason a stored quote keeps its catalogue version: an invoice is a
  -- statement made on a date, and a customer moving office next year must not silently
  -- rewrite the address on an invoice already sent and filed.
  bill_to_name    VARCHAR(200) NULL DEFAULT NULL,
  bill_to_address VARCHAR(500) NULL DEFAULT NULL,
  bill_to_tax_id  VARCHAR(64)  NULL DEFAULT NULL,
  bill_to_country CHAR(2)      NULL DEFAULT NULL,

  currency      CHAR(3)      NOT NULL DEFAULT 'EUR',

  -- MINOR UNITS as integers, like every other amount in this application. Denormalised
  -- from the lines inside the same transaction that writes them, and re-checked by
  -- `reconciliationProblems` before the invoice is shown or downloaded.
  net_minor     BIGINT       NOT NULL DEFAULT 0,
  vat_minor     BIGINT       NOT NULL DEFAULT 0,
  gross_minor   BIGINT       NOT NULL DEFAULT 0,

  issue_date    DATE         NULL DEFAULT NULL,
  due_date      DATE         NULL DEFAULT NULL,
  paid_at       DATETIME     NULL DEFAULT NULL,
  cancelled_at  DATETIME     NULL DEFAULT NULL,
  cancel_reason VARCHAR(300) NULL DEFAULT NULL,

  reference     VARCHAR(64)  NULL DEFAULT NULL,
  notes         VARCHAR(2000) NULL DEFAULT NULL,

  created_by    INT UNSIGNED NULL DEFAULT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The guard the counter cannot give on its own. NULLs do not collide in MySQL, so every
  -- draft is allowed while every issued number is unique.
  UNIQUE KEY uq_finance_invoice_number (invoice_year, invoice_seq),
  KEY idx_finance_invoices_status (status, issue_date),
  KEY idx_finance_invoices_client (client_id),
  KEY idx_finance_invoices_period (issue_date),
  CONSTRAINT fk_finance_invoices_client FOREIGN KEY (client_id) REFERENCES finance_clients (id),
  CONSTRAINT fk_finance_invoices_author FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Note the FK to finance_clients has NO `ON DELETE CASCADE` and no `SET NULL`: a client
-- with invoices cannot be deleted at all. Archiving is the operation; removing the customer
-- an invoice was sent to is not.

CREATE TABLE finance_invoice_lines (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id       INT UNSIGNED NOT NULL,
  position         SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  description      VARCHAR(300) NOT NULL,

  -- THOUSANDTHS, so 7.5 hours is 7500 and the arithmetic stays on integers end to end.
  quantity_milli   INT UNSIGNED NOT NULL DEFAULT 1000,
  unit             VARCHAR(32)  NULL DEFAULT NULL,
  unit_price_minor BIGINT       NOT NULL DEFAULT 0,

  -- BASIS POINTS: 2100 is 21.00%. Entered by whoever issues the invoice, never inferred —
  -- see config/finance.js on why that is not the tax refusal this codebase carries
  -- elsewhere. Zero is valid and common: reverse charge, exempt, outside scope.
  vat_bps          SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  -- Rounded ONCE, per line, and the invoice total is the sum of these. Storing them rather
  -- than recomputing on read is what makes the printed total equal the sum of the printed
  -- lines for ever, including after a rounding rule is changed.
  net_minor        BIGINT       NOT NULL DEFAULT 0,
  vat_minor        BIGINT       NOT NULL DEFAULT 0,

  PRIMARY KEY (id),
  KEY idx_finance_lines_invoice (invoice_id, position),
  CONSTRAINT fk_finance_lines_invoice FOREIGN KEY (invoice_id) REFERENCES finance_invoices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Costs. One table for both a recurring subscription and a one-off purchase: they differ
-- by whether `interval` is set, not by what they store. Two near-identical tables would
-- mean two of every query and a P&L built on a UNION.
CREATE TABLE finance_costs (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,

  description  VARCHAR(300) NOT NULL,
  category     VARCHAR(32)  NOT NULL,
  currency     CHAR(3)      NOT NULL DEFAULT 'EUR',
  amount_minor BIGINT       NOT NULL,

  -- NULL for a one-off. Set for a recurring cost, with the window it applies over —
  -- `ends_on` NULL means it is still running.
  recur_every  VARCHAR(16)  NULL DEFAULT NULL,
  starts_on    DATE         NOT NULL,
  ends_on      DATE         NULL DEFAULT NULL,

  vendor       VARCHAR(200) NULL DEFAULT NULL,
  notes        VARCHAR(2000) NULL DEFAULT NULL,

  created_by   INT UNSIGNED NULL DEFAULT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_finance_costs_period (starts_on, ends_on),
  KEY idx_finance_costs_category (category),
  CONSTRAINT fk_finance_costs_author FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
