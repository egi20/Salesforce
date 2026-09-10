'use strict';

const config = require('./config');

/**
 * The in-site assistant: what it costs, what it is allowed to spend, and how much of a
 * conversation ever reaches the model.
 *
 * Every number an attacker could turn into a bill lives here rather than in the route,
 * because a paid endpoint with its limits scattered across three files is a paid endpoint
 * whose limits nobody can state.
 */

// Haiku: this is site navigation help, not reasoning work. A larger model would cost
// several times more per answer for a question whose answer is in the knowledge base.
const MODEL = process.env.ASSISTANT_MODEL || 'claude-haiku-4-5-20251001';

const MAX_OUTPUT_TOKENS = 700;

/*
 * Published list price per MILLION tokens at the time of writing, in USD.
 *
 * These are here to be CHECKED, not trusted forever: a price that moved makes the budget
 * circuit-breaker cut off early or late, and either way silently. Both are overridable
 * from the environment so a deployment can correct them without a release.
 */
const PRICE_PER_MTOK_INPUT = Number(process.env.ASSISTANT_PRICE_INPUT_USD || 1);
const PRICE_PER_MTOK_OUTPUT = Number(process.env.ASSISTANT_PRICE_OUTPUT_USD || 5);

/** What reaches the model from one request. All three are hard caps, not suggestions. */
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_ENTRIES = 12;
const MAX_HISTORY_ENTRY_CHARS = 1500;

/**
 * Spend caps, month to date, in USD. 0 disables a cap.
 *
 * The GLOBAL cap is the one that matters: it is the only thing standing between a
 * distributed flood and an unbounded invoice, because rate limiting per IP cannot bound
 * aggregate spend. The PER-USER cap exists so one signed-in account cannot eat the global
 * budget on its own; anonymous visitors are governed by the global cap and the rate
 * limiters alone, since there is nothing durable to key a per-user total on.
 */
const GLOBAL_MONTHLY_BUDGET_USD = Number(process.env.AI_MONTHLY_BUDGET_USD || 25);
const USER_MONTHLY_BUDGET_USD = Number(process.env.AI_USER_MONTHLY_BUDGET_USD || 2);

/**
 * Request rate. Keyed by IP for the per-visitor limit, and a process-wide backstop on top.
 *
 * The backstop is not redundant with the per-IP limit: 500 addresses each staying politely
 * under 25 requests is still 12,500 model calls. Only a global counter sees that.
 */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_PER_IP = 25;
const RATE_MAX_GLOBAL = 300;

/** Cost of one exchange, in USD, from the token counts the API reported. */
function costUsd(inputTokens, outputTokens) {
  const input = (Number(inputTokens) || 0) / 1e6;
  const output = (Number(outputTokens) || 0) / 1e6;
  return input * PRICE_PER_MTOK_INPUT + output * PRICE_PER_MTOK_OUTPUT;
}

function isConfigured() {
  return Boolean(config.assistant.apiKey);
}

/**
 * Boot assertion, for the same reason the taxonomy, estimation and payment catalogues
 * have one: a negative cap or a non-numeric price does not fail visibly at request time,
 * it fails as an invoice at the end of the month.
 */
function assertAssistantIntegrity() {
  const numbers = {
    PRICE_PER_MTOK_INPUT,
    PRICE_PER_MTOK_OUTPUT,
    GLOBAL_MONTHLY_BUDGET_USD,
    USER_MONTHLY_BUDGET_USD
  };
  for (const [name, value] of Object.entries(numbers)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Assistant: ${name} must be a non-negative number (got ${value})`);
    }
  }
  if (!MODEL) throw new Error('Assistant: no model configured');
  if (MAX_OUTPUT_TOKENS <= 0) throw new Error('Assistant: MAX_OUTPUT_TOKENS must be positive');
  if (USER_MONTHLY_BUDGET_USD > 0 && GLOBAL_MONTHLY_BUDGET_USD > 0
      && USER_MONTHLY_BUDGET_USD > GLOBAL_MONTHLY_BUDGET_USD) {
    // Not fatal in theory, but it means the per-user cap can never bind, which is
    // almost certainly not what whoever set it intended.
    throw new Error('Assistant: the per-user monthly budget exceeds the global one');
  }
  return true;
}

module.exports = {
  MODEL,
  MAX_OUTPUT_TOKENS,
  PRICE_PER_MTOK_INPUT,
  PRICE_PER_MTOK_OUTPUT,
  MAX_MESSAGE_CHARS,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_ENTRY_CHARS,
  GLOBAL_MONTHLY_BUDGET_USD,
  USER_MONTHLY_BUDGET_USD,
  RATE_WINDOW_MS,
  RATE_MAX_PER_IP,
  RATE_MAX_GLOBAL,
  costUsd,
  isConfigured,
  assertAssistantIntegrity
};
