-- 046 Referral link opens, and the sales agent dashboard: terms, leads, commission.
--
-- 1. referrers.link_opens — the referral link (`/referrals/go/<code>`) counted the way an
--    agent's link already is (031): people, once per browser session, no previews or robots.
--    A counter only; nothing about the visitor is stored.
ALTER TABLE referrers
  ADD COLUMN link_opens INT UNSIGNED NOT NULL DEFAULT 0;

-- 2. An agent's terms, SET BY AN ADMINISTRATOR, never in code: the department shown on their
--    dashboard, their commission in basis points, and their monthly target of won deals.
--    NULL means "not agreed yet" and is shown as such — a NULL commission earns nothing,
--    rather than a rate nobody chose (the `?.percentage || 15` fault CLAUDE.md records).
--    Migration 031 said an agent's link "pays nothing"; the owner has since decided agents
--    earn a share of what their sign-ups pay for, and this is where that is recorded per agent.
ALTER TABLE sales_agents
  ADD COLUMN department      VARCHAR(80)       NULL DEFAULT NULL,
  ADD COLUMN commission_bps  SMALLINT UNSIGNED NULL DEFAULT NULL,
  ADD COLUMN monthly_target  SMALLINT UNSIGNED NULL DEFAULT NULL;

-- 3. When the account was shown, at sign-up, that an agent whose link it came through may see
--    its contact details. The agent dashboard shows an email address only where this is set:
--    people who signed up before the notice existed were told nothing of the kind, so their
--    address stays hidden from the agent.
ALTER TABLE users
  ADD COLUMN agent_notice_at DATETIME NULL DEFAULT NULL;

-- 4. An agent's own pipeline. Third parties' contact details, typed by the agent: private to
--    that agent and to administrators, purged with the agent's account (`user_id` is the
--    AGENT), and exported to the agent on request.
CREATE TABLE sales_agent_leads (
  id                     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id                INT UNSIGNED NOT NULL,
  company                VARCHAR(160) NOT NULL,
  contact_name           VARCHAR(120) NULL DEFAULT NULL,
  email                  VARCHAR(254) NULL DEFAULT NULL,
  phone                  VARCHAR(40)  NULL DEFAULT NULL,
  -- Validated against `config/salesAgents.js`; there is no free-text source.
  source                 VARCHAR(30)  NOT NULL,
  -- EUR minor units, an estimate typed by the agent.
  estimated_value_minor  INT UNSIGNED NULL DEFAULT NULL,
  stage                  VARCHAR(20)  NOT NULL,
  next_step_on           DATE         NULL DEFAULT NULL,
  notes                  TEXT         NULL,
  -- Set when the lead moves to `won`, cleared if it moves away: the monthly target counts
  -- deals won IN the month, not leads that happen to be in the column today.
  won_at                 DATETIME     NULL DEFAULT NULL,
  created_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_agent_leads_owner (user_id, stage, created_at),
  KEY idx_agent_leads_won (user_id, won_at),
  CONSTRAINT fk_agent_leads_agent FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. What an agent earned, one row per payment. Written by `SalesAgent.credit` beside
--    `Referral.credit`, outside the fulfilment transaction, never throwing. UNIQUE on the
--    payment, so the webhook and the success page racing write one row. The rate is a
--    SNAPSHOT: changing an agent's commission later never reprices a payment already credited.
--    `user_id` is the AGENT. Retained on erasure, like `commission_ledger`: money owed.
CREATE TABLE agent_commission_ledger (
  id                    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id               INT UNSIGNED NOT NULL,
  payment_id            INT UNSIGNED NOT NULL,
  product               VARCHAR(40)  NOT NULL,
  payment_amount_minor  INT UNSIGNED NOT NULL,
  rate_bps              SMALLINT UNSIGNED NOT NULL,
  commission_minor      INT UNSIGNED NOT NULL,
  currency              CHAR(3)      NOT NULL DEFAULT 'EUR',
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_agent_commission_payment (payment_id),
  KEY idx_agent_commission_agent (user_id, created_at),
  CONSTRAINT fk_agent_commission_agent FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_agent_commission_payment FOREIGN KEY (payment_id) REFERENCES payments (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
