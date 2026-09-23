-- 024 Hiding a consultant profile from named companies.
--
-- The case this exists for: somebody looking for their next contract while still in their
-- current one. A public profile is how they get found, and their present employer seeing it
-- is the reason they do not publish one at all.
--
-- TWO KINDS OF ENTRY, and the difference matters to what can be promised.
--
-- `company_user_id` names a REGISTERED account. That is enforceable: when that company is
-- signed in and browsing, the profile is not in the result set.
--
-- `company_name` is free text, for an employer with no account here. It is matched against a
-- registered company's profile name, case- and space-insensitively — so it only ever bites if
-- that employer later signs up under a name that matches. It is kept because a consultant
-- naming their employer before that employer registers is the common case, and the block
-- then takes effect on its own. The interface says exactly this rather than implying more:
-- a hide nobody can enforce, described as though it were enforced, is worse than no hide.
--
-- NEITHER kind hides anything from a signed-out visitor. The directory is public, so a person
-- browsing without an account sees every public profile, and no filter can tell who they work
-- for. A consultant who needs real invisibility makes the profile non-public; that switch
-- already exists and is the honest answer to that requirement.
--
-- The exclusion is applied in `ConsultantProfile.buildFilter` and nowhere else. The reference
-- implementation put its equivalent clause inline in ONE query out of the fourteen that read
-- `consultant_profiles`, so the browse list honoured the block and everything else did not —
-- which is the precise failure the one-builder rule in CLAUDE.md exists to prevent, wearing
-- the most costly shape available: a privacy promise that holds on one page.

CREATE TABLE consultant_hidden_companies (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  consultant_user_id  INT UNSIGNED NOT NULL,

  -- Exactly one of these is set. A CHECK enforces it rather than a comment asking nicely:
  -- a row with neither blocks nothing and a row with both is two rules pretending to be one.
  company_user_id     INT UNSIGNED NULL DEFAULT NULL,

  -- Stored as typed, for display. `company_name_key` is the lower-cased, space-collapsed
  -- form the unique index and the match use, so "Acme  Ltd" and "acme ltd" are one entry
  -- rather than two blocks that each half-work.
  company_name        VARCHAR(200) NULL DEFAULT NULL,
  company_name_key    VARCHAR(200) NULL DEFAULT NULL,

  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- One block per company per consultant, of each kind. Adding the same one twice is a
  -- duplicate-key no-op rather than a second row that has to be removed twice.
  UNIQUE KEY uq_hidden_registered (consultant_user_id, company_user_id),
  UNIQUE KEY uq_hidden_named (consultant_user_id, company_name_key),
  KEY idx_hidden_lookup (company_user_id),
  KEY idx_hidden_name (company_name_key),

  CONSTRAINT fk_hidden_consultant FOREIGN KEY (consultant_user_id) REFERENCES users (id) ON DELETE CASCADE,
  -- The blocking consultant's row goes when their account does. The BLOCKED company's
  -- account going away removes the block too, which is correct: there is nobody left to hide
  -- from, and keeping a dangling id would quietly block whoever inherited it.
  CONSTRAINT fk_hidden_company FOREIGN KEY (company_user_id) REFERENCES users (id) ON DELETE CASCADE,

  CONSTRAINT chk_hidden_one_kind CHECK (
    (company_user_id IS NOT NULL AND company_name_key IS NULL) OR
    (company_user_id IS NULL AND company_name_key IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
