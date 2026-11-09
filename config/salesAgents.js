'use strict';

const { MAX_RATE_BPS, ATTRIBUTION_WINDOW_DAYS } = require('./referrals');
const { isValidProduct } = require('./payments');

/**
 * The sales agent dashboard: the vocabulary of an agent's pipeline, and what earns them
 * commission. Catalogue values, under version control. An agent's own TERMS — department,
 * commission rate, monthly target — are not here: an administrator sets them per agent
 * (`sales_agents`, migration 046), so nobody's pay is a constant in code.
 */

/** Pipeline stages, in order. `tone` is a `.badge-hub` / tile modifier, never a colour. */
const LEAD_STAGES = Object.freeze([
  { value: 'new', label: 'New', tone: '' },
  { value: 'contacted', label: 'Contacted', tone: '' },
  { value: 'qualified', label: 'Qualified', tone: 'cloud' },
  { value: 'proposal', label: 'Proposal', tone: 'cloud' },
  { value: 'negotiation', label: 'Negotiation', tone: 'warn' },
  { value: 'won', label: 'Won', tone: 'ok' },
  { value: 'lost', label: 'Lost', tone: 'danger' }
]);

/** Where a lead came from. A fixed list: a free-text source fills up with "web". */
const LEAD_SOURCES = Object.freeze([
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'referral', label: 'Referral' },
  { value: 'event', label: 'Event' },
  { value: 'website', label: 'Website' },
  { value: 'outbound', label: 'Outbound' },
  { value: 'partner', label: 'Partner' },
  { value: 'other', label: 'Other' }
]);

/**
 * What an agent earns on: a share of what the Hub is PAID, by a person who signed up through
 * the agent's link, for these and nothing else.
 *
 * `product` is the `config/payments.js` product that carries the money, or null when the Hub
 * takes no payment for it yet. Tax optimization is an enquiry today: there is no payment to
 * take a share of, so it is listed honestly with nothing counted rather than left off the card.
 */
const AGENT_EARNINGS = Object.freeze([
  { key: 'tax_optimization', label: 'Tax optimization', product: null },
  { key: 'sow_quote', label: 'SOW quote', product: 'quote_deposit' }
]);

/** Shown greyed on the card so the line is drawn where an agent can see it. */
const AGENT_NOT_EARNING = Object.freeze(['Sign-ups', 'Job posts', 'Hires']);

const AGENT_COMMISSION_PRODUCTS = Object.freeze(AGENT_EARNINGS.filter((e) => e.product).map((e) => e.product));

/**
 * How long after a person signs up their payments still earn the agent: the same finite
 * window the referral scheme uses, for the same reason — a link opened once must not create
 * a claim on everything that person ever pays.
 */
const AGENT_EARNING_WINDOW_DAYS = ATTRIBUTION_WINDOW_DAYS;

/** Ceilings on what an administrator can type, so a slip of the keyboard is refused. */
const MAX_AGENT_COMMISSION_BPS = MAX_RATE_BPS;
const MAX_MONTHLY_TARGET = 500;

const own = (list, value) => typeof value === 'string' && list.some((x) => x.value === value);
const isStage = (value) => own(LEAD_STAGES, value);
const isSource = (value) => own(LEAD_SOURCES, value);
const stageFor = (value) => LEAD_STAGES.find((s) => s.value === value) || null;
const sourceLabel = (value) => (LEAD_SOURCES.find((s) => s.value === value) || { label: value }).label;

function assertSalesAgentConfig() {
  for (const e of AGENT_EARNINGS) {
    if (e.product && !isValidProduct(e.product)) throw new Error(`Sales agents: ${e.key} names an unknown payment product ${e.product}`);
  }
  if (!LEAD_STAGES.some((s) => s.value === 'won') || !LEAD_STAGES.some((s) => s.value === 'lost')) {
    throw new Error('Sales agents: the pipeline needs a won and a lost stage');
  }
  if (new Set(LEAD_STAGES.map((s) => s.value)).size !== LEAD_STAGES.length) throw new Error('Sales agents: duplicate stage');
  if (new Set(LEAD_SOURCES.map((s) => s.value)).size !== LEAD_SOURCES.length) throw new Error('Sales agents: duplicate source');
  return true;
}

module.exports = {
  LEAD_STAGES,
  LEAD_SOURCES,
  AGENT_EARNINGS,
  AGENT_NOT_EARNING,
  AGENT_COMMISSION_PRODUCTS,
  AGENT_EARNING_WINDOW_DAYS,
  MAX_AGENT_COMMISSION_BPS,
  MAX_MONTHLY_TARGET,
  isStage,
  isSource,
  stageFor,
  sourceLabel,
  assertSalesAgentConfig
};
