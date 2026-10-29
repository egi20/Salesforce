-- 034 Issue reports learn four things from SAP Hub's report form (its migrations 030 and
-- 031): how badly it hurts, the content being reported, screenshots, and ideas others can
-- see and vote on. Onto THIS table, not a second one — a problem and an idea are the same
-- object, a person writing in and expecting somebody to read it.
--
-- `severity`: low, normal, high or critical (the site is down, or data is being lost).
-- NULL means the reporter did not say, which is a different fact from "low". Checked
-- against config/issues.js, which owns the list.
--
-- `content_path`: under "A problem with something somebody posted", the page of the post
-- or profile being reported — separate from `page_path` (where the reporter was), because
-- the moderator needs the second one to act. A path on this site, like `page_path`, for the
-- same reason: an administrator clicking a link a stranger supplied is the oldest trick.
--
-- `closed_at`: when it was closed. The screenshot retention clock starts here, and
-- `updated_at` cannot serve — any later write would restart it.
--
-- A SHARED IDEA BECOMES PUBLIC ONLY WITH TWO SWITCHES: the sender ticked `publish_consent`,
-- AND an administrator published it (`published_at`). The first is the sender's say over
-- their own words; the second is a person reading it before strangers do. Neither alone
-- puts anything on /ideas, and the sender's name is never shown there.
--
-- STILL NOTHING CAPTURED AUTOMATICALLY. SAP Hub's 031 also added an opt-in browser-details
-- line; it is deliberately not ported. This table's rule is that the reporter types what
-- they want us to have, and a test holds every migration of it to that.
ALTER TABLE issue_reports
  ADD COLUMN severity        VARCHAR(16)  NULL DEFAULT NULL AFTER kind,
  ADD COLUMN content_path    VARCHAR(300) NULL DEFAULT NULL AFTER page_path,
  ADD COLUMN closed_at       DATETIME     NULL DEFAULT NULL AFTER status,
  ADD COLUMN publish_consent TINYINT(1)   NOT NULL DEFAULT 0 AFTER contact_email,
  ADD COLUMN published_at    DATETIME     NULL DEFAULT NULL AFTER publish_consent,
  ADD COLUMN published_by    INT UNSIGNED NULL DEFAULT NULL AFTER published_at,
  ADD KEY idx_issue_published (published_at),
  ADD CONSTRAINT fk_issue_published_by FOREIGN KEY (published_by) REFERENCES users (id) ON DELETE SET NULL;

-- Screenshots. IMAGES ONLY, re-encoded by sharp before they are stored: the re-encode is the
-- sanitiser, exactly as for profile photographs, and what an administrator later opens is
-- what sharp produced rather than whatever a stranger uploaded. In the database because the
-- host's disk is ephemeral (CLAUDE.md, "Uploads and images"), and in their OWN table so the
-- queue's list query never drags the bytes along. Deleted a stated time after the report is
-- closed (IssueReport.purgeExpiredAttachments); the report text stays as the record.
CREATE TABLE issue_report_attachments (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  issue_id     INT UNSIGNED NOT NULL,
  content_type VARCHAR(40)  NOT NULL,
  bytes        MEDIUMBLOB   NOT NULL,
  byte_size    INT UNSIGNED NOT NULL,
  width        INT UNSIGNED NULL DEFAULT NULL,
  height       INT UNSIGNED NULL DEFAULT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_issue_attachments_issue (issue_id),
  CONSTRAINT fk_issue_attachments_issue FOREIGN KEY (issue_id) REFERENCES issue_reports (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One vote per member per published idea, held by the key rather than by a check in the
-- handler. Counted, never shown with names.
CREATE TABLE idea_votes (
  issue_id   INT UNSIGNED NOT NULL,
  user_id    INT UNSIGNED NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (issue_id, user_id),
  KEY idx_idea_votes_user (user_id),
  CONSTRAINT fk_idea_votes_issue FOREIGN KEY (issue_id) REFERENCES issue_reports (id) ON DELETE CASCADE,
  CONSTRAINT fk_idea_votes_user  FOREIGN KEY (user_id)  REFERENCES users (id)         ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
