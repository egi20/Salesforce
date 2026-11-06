-- 040 What a consultant needs to follow their own applications.
--
-- viewed_at: when the hiring company first opened the application. Set once, by a
-- conditional UPDATE, never moved back — "Viewed by company" is the single most asked
-- question on the consultant side, and without it every silence looks the same.
--
-- cv_document_id: WHICH of the consultant's uploaded CVs went with this application, so
-- both sides can open the same file later. ON DELETE SET NULL: a consultant deleting a CV
-- (or erasing their account) takes the file away from the company too — that is the
-- consultant's call, and the application row stays as the employer's hiring record.
--
-- application_notes: the consultant's PRIVATE notes on an application ("recruiter called,
-- interview Tuesday"). A separate table rather than a column on `applications`, because the
-- employer's queries read `a.*`; a note that only one side may read must not sit in a row
-- the other side selects wholesale.

ALTER TABLE applications
  ADD COLUMN viewed_at DATETIME NULL DEFAULT NULL AFTER status,
  ADD COLUMN cv_document_id INT UNSIGNED NULL DEFAULT NULL AFTER available_from,
  ADD CONSTRAINT fk_applications_cv FOREIGN KEY (cv_document_id) REFERENCES consultant_documents (id) ON DELETE SET NULL;

CREATE TABLE application_notes (
  application_id INT UNSIGNED NOT NULL,
  user_id        INT UNSIGNED NOT NULL,
  body           TEXT         NOT NULL,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (application_id),
  KEY idx_application_notes_user (user_id),
  CONSTRAINT fk_application_notes_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_application_notes_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
