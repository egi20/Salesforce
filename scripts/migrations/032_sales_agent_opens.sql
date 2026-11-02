-- 032 Sales agent link opens, one row per counted open, with its time (ported from SAP
-- Hub's migration 040).
--
-- `sales_agents.link_opens` (031) is a lifetime counter: it cannot answer "how many opened
-- the link in the last 24 hours", because an increment carries no date. This table records
-- WHEN each counted open happened, and nothing else — no IP, no session id, no user agent:
-- the same "looks like a person, once per session" decision in routes/index.js decides
-- what is counted, and the row only dates it.
--
-- The lifetime counter stays the source of the "Opens" column and is incremented alongside.
CREATE TABLE sales_agent_link_opens (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_user_id  INT UNSIGNED    NOT NULL,
  opened_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_agent_opens_time (agent_user_id, opened_at),
  CONSTRAINT fk_agent_open_agent FOREIGN KEY (agent_user_id) REFERENCES sales_agents (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
