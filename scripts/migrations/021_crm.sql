-- 021 The internal sales CRM.
--
-- READ THIS BEFORE CHANGING ANYTHING HERE. Every other table in this application holds
-- data somebody gave us. This one holds the names, addresses, phone numbers and job titles
-- of people who never asked to be contacted, so that somebody can contact them. That is a
-- different kind of object, and the three structural differences from the reference
-- implementation's `crm_leads` are what make holding it defensible.

-- THE SUPPRESSION LIST, FIRST, because it outranks everything below it.
--
-- Keyed on a SHA-256 of the lower-cased address and holding no address, so the list itself
-- is not a mailing list. NO foreign key to `crm_leads`, and that absence is the whole
-- point: deleting a lead is exactly how the reference would lose the fact that its subject
-- asked never to be contacted again, and the next quarterly import would write them
-- straight back in.
--
-- Nothing in this application deletes from this table.
CREATE TABLE crm_suppressions (
  email_hash  CHAR(64)     NOT NULL,

  -- Why they are suppressed. Not who they are.
  reason      VARCHAR(32)  NOT NULL DEFAULT 'requested',
  note        VARCHAR(500) NULL DEFAULT NULL,

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by  INT UNSIGNED NULL DEFAULT NULL,

  PRIMARY KEY (email_hash),
  CONSTRAINT fk_crm_suppressions_actor FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE crm_leads (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  company        VARCHAR(200) NOT NULL,
  contact_name   VARCHAR(200) NULL DEFAULT NULL,
  contact_email  VARCHAR(190) NULL DEFAULT NULL,
  contact_phone  VARCHAR(40)  NULL DEFAULT NULL,
  job_title      VARCHAR(200) NULL DEFAULT NULL,

  country        CHAR(2)      NULL DEFAULT NULL,
  website        VARCHAR(500) NULL DEFAULT NULL,
  linkedin_url   VARCHAR(500) NULL DEFAULT NULL,

  -- NOT NULL, and validated against config/crm.js. A lead cannot exist without an answer
  -- to "where did you get this person's address". The reference has no such column; its
  -- `source_found` is nullable free text, so most rows end up with nothing in it and the
  -- answer has to be reconstructed a year later from memory.
  source         VARCHAR(32)  NOT NULL,
  source_detail  VARCHAR(300) NULL DEFAULT NULL,

  status         VARCHAR(32)  NOT NULL DEFAULT 'new',

  -- Denormalised from `crm_lead_activities` inside the same transaction that writes one,
  -- exactly as `posts.reply_count` is — it is what lets the board sort without aggregating.
  last_activity_at DATETIME   NULL DEFAULT NULL,

  owner_user_id  INT UNSIGNED NULL DEFAULT NULL,
  created_by     INT UNSIGNED NULL DEFAULT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- One row per address. An import that runs twice updates rather than duplicating, which
  -- is what stops the same person being written to twice by two people who each thought
  -- the lead was theirs. NULL never collides in MySQL, so a lead with only a phone number
  -- is still allowed.
  UNIQUE KEY uq_crm_leads_email (contact_email),

  KEY idx_crm_leads_status (status, last_activity_at),
  KEY idx_crm_leads_company (company),
  KEY idx_crm_leads_owner (owner_user_id),
  KEY idx_crm_leads_stale (last_activity_at),
  CONSTRAINT fk_crm_leads_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_crm_leads_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only, like every other event table here. There is no edit and no delete: "who
-- contacted this person, when, through what, and what happened" is the record that answers
-- a complaint, and a record somebody can tidy up is not one.
CREATE TABLE crm_lead_activities (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  lead_id       INT UNSIGNED NOT NULL,
  actor_user_id INT UNSIGNED NULL DEFAULT NULL,

  channel       VARCHAR(32)  NULL DEFAULT NULL,
  outcome       VARCHAR(32)  NOT NULL,
  from_status   VARCHAR(32)  NULL DEFAULT NULL,
  to_status     VARCHAR(32)  NULL DEFAULT NULL,
  note          VARCHAR(2000) NULL DEFAULT NULL,

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_crm_activities_lead (lead_id, created_at),
  CONSTRAINT fk_crm_activities_lead FOREIGN KEY (lead_id) REFERENCES crm_leads (id) ON DELETE CASCADE,
  CONSTRAINT fk_crm_activities_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A drafted message. NOT a queue.
--
-- The reference has `/outreach/queue` and a "sent" endpoint that walks it. Nothing in this
-- application sends: a person reads the draft, sends it from their own mail client, and
-- records that they did by writing an activity. `sent_at` is therefore a note somebody
-- made, not a delivery receipt, and the column is named for what it is.
--
-- `edited_body` keeps what a person actually sent while `body` keeps what the model wrote,
-- the same split `quote_drafts` uses — the ethical basis of both is that what goes out is
-- what a person put their name to.
CREATE TABLE crm_outreach_drafts (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  lead_id       INT UNSIGNED NOT NULL,

  channel       VARCHAR(32)  NOT NULL DEFAULT 'email',
  body          TEXT         NOT NULL,
  edited_body   TEXT         NULL DEFAULT NULL,

  model         VARCHAR(64)  NULL DEFAULT NULL,
  input_tokens  INT UNSIGNED NULL DEFAULT NULL,
  output_tokens INT UNSIGNED NULL DEFAULT NULL,

  -- When somebody recorded having sent it by hand. Never set by this application on its own.
  marked_sent_at DATETIME    NULL DEFAULT NULL,
  superseded_at  DATETIME    NULL DEFAULT NULL,

  created_by    INT UNSIGNED NULL DEFAULT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_crm_drafts_lead (lead_id, created_at),
  CONSTRAINT fk_crm_drafts_lead FOREIGN KEY (lead_id) REFERENCES crm_leads (id) ON DELETE CASCADE,
  CONSTRAINT fk_crm_drafts_author FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
