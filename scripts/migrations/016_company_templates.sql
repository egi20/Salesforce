-- 016 Company document branding and standard clauses.
--
-- WHAT IS NOT HERE, and the omission is the whole design: **no uploaded file.** There is
-- no template blob, no original filename, no extracted sample text and no path on disk. A
-- company supplies its brand and its own standard wording; the Hub's validated generators
-- render with them.
--
-- The reference implementation stores an uploaded sample CV — a REAL PERSON'S document,
-- their name extracted by a model into `samplePersonInfo`, and up to forty thousand
-- characters of their text kept as "template configuration" — written to the host
-- filesystem and later served back out. Three of this codebase's standing rules at once:
-- durable bytes never live on disk, a document nobody validated is never served, and
-- personal data fetched without a purpose is personal data to explain later.

CREATE TABLE company_templates (
  user_id             INT UNSIGNED NOT NULL,

  -- Six upper-case hex digits, no hash — the shape every generator wants. NULL means the
  -- Hub's own default. Both are checked against a 4.5:1 contrast floor on white before
  -- they are stored: a company cannot configure a document its own client cannot read.
  brand_navy          CHAR(6)      NULL DEFAULT NULL,
  brand_blue          CHAR(6)      NULL DEFAULT NULL,

  -- The letterhead. PLAIN TEXT, every field, rendered with the escaping tag. This block
  -- appears on every document a company sends a client, which makes it the highest-value
  -- place in the application to accept markup — and markup buys a letterhead nothing.
  legal_name          VARCHAR(200) NULL DEFAULT NULL,
  registration_number VARCHAR(60)  NULL DEFAULT NULL,
  vat_number          VARCHAR(60)  NULL DEFAULT NULL,
  address             VARCHAR(300) NULL DEFAULT NULL,
  contact_email       VARCHAR(255) NULL DEFAULT NULL,
  contact_phone       VARCHAR(60)  NULL DEFAULT NULL,
  website             VARCHAR(255) NULL DEFAULT NULL,
  footer_note         VARCHAR(200) NULL DEFAULT NULL,

  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- One per account, so "this company's template" is never a question about which row.
  PRIMARY KEY (user_id),
  CONSTRAINT fk_company_templates_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The company's own standard wording, added to what the generators already print.
--
-- Rows rather than one text blob per kind: they are a LIST in a document, they are
-- reordered, and one of them is deleted without touching the others. A blob would make
-- every edit a full rewrite and every reorder a diff nobody can read.
--
-- `position` rather than `created_at` ordering, because the order these appear in is a
-- decision — an exclusion that matters most belongs first, not oldest-first.
CREATE TABLE company_clauses (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,

  -- assumption | exclusion | term, from config/companyTemplates.js. Not an ENUM: adding a
  -- clause kind should not need an ALTER on a table holding text somebody may already
  -- have sent to a client.
  kind       VARCHAR(32)  NOT NULL,

  -- PLAIN TEXT. Same reasoning as the letterhead, and more so: this is contract-adjacent
  -- wording that lands in a client's document.
  body       VARCHAR(600) NOT NULL,

  position   SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_clauses_company (user_id, kind, position),
  CONSTRAINT fk_company_clauses_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
