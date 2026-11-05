-- 041 A company's private shortlist of consultants.
--
-- CLAUDE.md listed shortlists as "not built" because who may see that a consultant is on one
-- is not an obvious question. This is the answer this table commits to:
--
--   * ONLY the company that saved the profile. The consultant is never told, never sees it,
--     and nothing anyone else reads joins on it.
--   * It never makes anybody visible: the shortlist page lists through
--     ConsultantProfile.buildFilter with the company as viewer, so a profile that went
--     private, was taken down, or hid itself from this company drops out of the list.
--   * It goes with either account: `user_id` (the company) is in the erasure PURGE list, and
--     the consultant's side is removed by erasure too (AccountErasure.PURGE_AS_SUBJECT).
--
-- `user_id` is the owning company rather than `company_user_id` so it falls under the same
-- erasure and export rules as every other private list keyed on its owner (saved_jobs).

CREATE TABLE company_shortlists (
  user_id            INT UNSIGNED NOT NULL,
  consultant_user_id INT UNSIGNED NOT NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, consultant_user_id),
  KEY idx_company_shortlists_consultant (consultant_user_id),
  CONSTRAINT fk_shortlists_company FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_shortlists_consultant FOREIGN KEY (consultant_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
