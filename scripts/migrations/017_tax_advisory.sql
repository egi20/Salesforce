-- 017 Tax advisory enquiries.
--
-- Two tables for what the reference implementation does in one, and the difference is
-- almost entirely SUBTRACTION.
--
-- The reference's `tax_applications` has thirty-five columns and collects all of them
-- from an anonymous visitor: current employer, contract end date, notice period, gross
-- and net monthly pay, current tax rate, VAT registration, desired and current day rate,
-- certifications, languages, client industries, travel preference. It also stores
-- `estimated_monthly_savings` and `estimated_annual_savings`, which its form POSTS BACK
-- FROM THE BROWSER after a client-side calculator produced them — so the saving on the
-- record is a number the client sent, attached to a person's name and pay.
--
-- This table holds what an introduction needs and stops: who you are, how to reach you,
-- where you are tax-resident, how you work today, and what you want to ask. The specialist
-- asks the rest in the conversation, under their own engagement terms — which is where a
-- professional duty of confidentiality attaches, and it does not attach here.
--
-- There is no savings column because there is no calculator. See config/taxAdvisory.js.

CREATE TABLE tax_enquiries (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- NULL for an anonymous enquirer, and that is the common case: most people asking how
  -- they should be set up have not joined anything yet. When it is set, the enquirer can
  -- see their own enquiry back; when it is not, the confirmation email is the only copy
  -- they get, which is a reason to keep the email honest about what happens next.
  user_id         INT UNSIGNED NULL DEFAULT NULL,

  full_name       VARCHAR(120) NOT NULL,
  email           VARCHAR(190) NOT NULL,
  phone           VARCHAR(40)  NULL DEFAULT NULL,

  -- ISO country of TAX RESIDENCE, which is the one fact that decides whether anybody can
  -- help at all. Not the city, not the timezone: neither routes an enquiry, and both
  -- narrow a person down.
  country         CHAR(2)      NOT NULL,

  -- Both validated against config/taxAdvisory.js rather than declared as an ENUM here.
  -- An ENUM would put the option list in two places, and the migration is the copy nobody
  -- remembers to change.
  topic           VARCHAR(32)  NOT NULL,
  arrangement     VARCHAR(32)  NOT NULL,

  -- What they actually want to ask, in their own words. Plain text, rendered escaped.
  question        TEXT         NOT NULL,

  status          VARCHAR(32)  NOT NULL DEFAULT 'new',

  -- THE RESERVATION. Holds the lower-cased email while the enquiry is open and is set to
  -- NULL the moment it closes. The UNIQUE key below therefore means "one OPEN enquiry per
  -- address" — a double-submitted form is one row, and a person who was helped in March
  -- can ask again in September without a duplicate-key error. MySQL does not collide NULLs
  -- in a unique index, which is exactly the property this leans on. Idempotency lives in
  -- the schema, not in a check-then-insert a later handler can forget to call.
  open_key        VARCHAR(190) NULL DEFAULT NULL,

  -- Consent, stamped the same way registration stamps it. The reference records none at
  -- all, for a form that collects somebody's pay. The purpose is named on the form and the
  -- version is stamped here, so what a person agreed to on a date can still be read back.
  consent_version VARCHAR(32)  NOT NULL,
  consented_at    DATETIME     NOT NULL,

  -- DATETIME with an explicit default throughout, never TIMESTAMP: with
  -- `explicit_defaults_for_timestamp` off, MySQL gives a table's first TIMESTAMP column an
  -- implicit ON UPDATE CURRENT_TIMESTAMP, which would silently re-date a record on every
  -- unrelated write.
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_tax_enquiries_open (open_key),
  KEY idx_tax_enquiries_status (status, created_at),
  KEY idx_tax_enquiries_created (created_at),
  KEY idx_tax_enquiries_user (user_id),
  CONSTRAINT fk_tax_enquiries_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only, exactly as `application_events` and `moderation_events` are. "Who moved
-- this, when, and why" must always have an answer, and on a queue that handles other
-- people's financial questions that answer is the whole accountability of the feature.
--
-- ON DELETE CASCADE is deliberate here and is not a contradiction of "append-only": the
-- retention purge deletes the enquiry and its history together, because keeping an audit
-- trail of a record we promised to delete is keeping the record.
CREATE TABLE tax_enquiry_events (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  enquiry_id    INT UNSIGNED NOT NULL,
  actor_user_id INT UNSIGNED NULL DEFAULT NULL,
  from_status   VARCHAR(32)  NULL DEFAULT NULL,
  to_status     VARCHAR(32)  NOT NULL,
  note          VARCHAR(500) NULL DEFAULT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tax_enquiry_events_enquiry (enquiry_id, created_at),
  CONSTRAINT fk_tax_enquiry_events_enquiry FOREIGN KEY (enquiry_id) REFERENCES tax_enquiries (id) ON DELETE CASCADE,
  CONSTRAINT fk_tax_enquiry_events_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
