-- 015 Drafted narrative for a quote.
--
-- THE REASON THIS IS A SEPARATE TABLE, and not a column on `quotes`: the stored
-- `estimate` is a statement made to a client on a date, reconciled by
-- `utils/sowEstimation.js` and never recomputed on read. Generated prose has none of those
-- properties. Keeping it beside the estimate rather than inside it means the figures
-- cannot be touched by the drafting path at all — there is no code path from a model
-- response to `quotes.estimate`.
--
-- A draft becomes part of the quote only when the author ACCEPTS it. Until then it is a
-- suggestion; after that it is the author's own text, because they could edit every word
-- of it first. That distinction is the whole ethical basis of the feature: what goes to a
-- client is what a person put their name to.
--
-- History is kept. A superseded draft is not deleted — `accepted_at` and `superseded_at`
-- say which one is live — because "what did the model actually write, before I edited it"
-- is the question anyone reviewing this feature will ask first.

CREATE TABLE quote_drafts (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  quote_id        INT UNSIGNED NOT NULL,

  -- One of the keys in config/drafting.js. Not an ENUM: adding a section should not need
  -- an ALTER on a table holding text somebody may already have sent to a client.
  section         VARCHAR(40)  NOT NULL,

  -- What the model produced, kept EXACTLY as it came back. Never overwritten by an edit:
  -- an edit writes `edited_body`, so the two can be compared.
  body            MEDIUMTEXT   NOT NULL,
  edited_body     MEDIUMTEXT   NULL DEFAULT NULL,

  -- Which model, and what it cost. The same figures go to `ai_usage`; these are here so a
  -- single quote's drafting cost can be answered without joining across a shared ledger.
  model           VARCHAR(80)  NOT NULL,
  input_tokens    INT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens   INT UNSIGNED NOT NULL DEFAULT 0,

  -- The catalogue the estimate was priced under WHEN THIS WAS DRAFTED. A draft written
  -- against one set of figures and then shown beside another is exactly the contradiction
  -- this whole feature has to avoid, so the mismatch is detectable rather than invisible.
  catalogue_version VARCHAR(32) NULL DEFAULT NULL,

  -- Null until a person reads it and accepts it. Nothing unaccepted reaches a document.
  accepted_at     DATETIME     NULL DEFAULT NULL,
  -- Set when a later draft for the same section is accepted. Kept, not deleted.
  superseded_at   DATETIME     NULL DEFAULT NULL,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_drafts_quote (quote_id, section, created_at),
  -- The query behind every read: the live draft for one section of one quote.
  KEY idx_drafts_live (quote_id, section, accepted_at, superseded_at),
  CONSTRAINT fk_drafts_quote FOREIGN KEY (quote_id) REFERENCES quotes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
