-- 025 Issue reports: somewhere for a person to say "this does not work".
--
-- The site had `/admin/errors`, which records what the SERVER noticed. That misses every
-- failure a server cannot see: a button that does nothing, a figure that looks wrong, a page
-- that renders but is unusable, a rule that behaves differently from what it says. Those
-- arrive as nothing at all, and the first sign of one is somebody leaving.
--
-- ANONYMOUS REPORTS ARE ACCEPTED, because the most valuable report on a marketplace is from
-- somebody who could not finish signing up — and requiring an account to say "registration is
-- broken" loses exactly the report you most need. `user_id` is therefore nullable and set only
-- when there was a session.
--
-- WHAT IS DELIBERATELY NOT COLLECTED: no IP address, no user agent, no referrer, no automatic
-- capture of anything. A bug report is not a reason to start logging visitors, and every one
-- of those fields is personal data that would then need a retention rule and a line in the
-- privacy policy. The reporter types what they want us to have. `contact_email` is optional
-- and exists only so somebody without an account can be answered.
--
-- Status is a small fixed set, and there is no DELETE: a report that was dismissed is
-- evidence somebody complained and nobody acted, which is the one thing worth keeping. Same
-- reasoning as moderation hiding rather than deleting.

CREATE TABLE issue_reports (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- NULL for an anonymous report. ON DELETE SET NULL rather than CASCADE: the bug does not
  -- stop existing because the person who found it closed their account, and their name is
  -- already gone from the row by then.
  user_id        INT UNSIGNED NULL DEFAULT NULL,

  -- Where they were. Stored as the path they typed or the page they came from, capped, and
  -- never trusted as a link — it is rendered as text.
  page_path      VARCHAR(300) NULL DEFAULT NULL,

  kind           VARCHAR(24)  NOT NULL DEFAULT 'bug',
  summary        VARCHAR(200) NOT NULL,
  detail         TEXT         NOT NULL,

  -- Optional, and the only way to answer an anonymous reporter.
  contact_email  VARCHAR(190) NULL DEFAULT NULL,

  status         VARCHAR(16)  NOT NULL DEFAULT 'new',
  -- What an administrator wrote back. Shown to the reporter on /my-issues when they had an
  -- account: a report that disappears into a queue teaches people not to send the next one.
  response       TEXT         NULL DEFAULT NULL,
  responded_at   DATETIME     NULL DEFAULT NULL,
  responded_by   INT UNSIGNED NULL DEFAULT NULL,

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_issue_status (status, created_at),
  KEY idx_issue_reporter (user_id, created_at),
  CONSTRAINT fk_issue_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_issue_responder FOREIGN KEY (responded_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
