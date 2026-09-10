'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const config = require('../config/config');
const assistantConfig = require('../config/assistant');
const ApiUsage = require('../models/ApiUsage');
const { buildSystemPrompt } = require('./assistantPrompt');
const { assertWithinBudget } = require('./aiBudget');

/**
 * The only module that talks to the model.
 *
 * It degrades the same way `utils/email.js` and `utils/stripe.js` do: with no
 * `ANTHROPIC_API_KEY` the module loads, `isConfigured()` is false, the widget is never
 * rendered and the endpoint answers 503. That is what keeps local development, CI and
 * `npm run validate-boot` working without credentials.
 */

const FEATURE = 'assistant';

let client = null;

function getClient() {
  if (!assistantConfig.isConfigured()) {
    throw new Error('The assistant is not configured (ANTHROPIC_API_KEY is unset)');
  }
  if (!client) {
    client = new Anthropic({ apiKey: config.assistant.apiKey });
  }
  return client;
}

/**
 * Turn the client's claimed history into something safe to send.
 *
 * The history lives in the visitor's own sessionStorage and is posted back with every
 * message, so ALL of it is untrusted input. Three things matter here and each is a cost
 * or a safety bound, not tidiness:
 *
 *  1. the array is cut BEFORE it is walked — a hostile request can carry tens of
 *     thousands of entries inside the JSON body limit, and only the tail can survive the
 *     final slice anyway;
 *  2. every entry is truncated, so a long history cannot inflate one request's input
 *     tokens without bound;
 *  3. anything malformed is dropped silently rather than repaired. A "role" that is not
 *     `user` or `assistant` is not a typo to fix, it is someone probing.
 */
function sanitiseHistory(history) {
  const { MAX_HISTORY_ENTRIES, MAX_HISTORY_ENTRY_CHARS } = assistantConfig;
  if (!Array.isArray(history)) return [];

  const clean = [];
  for (const entry of history.slice(-MAX_HISTORY_ENTRIES * 2)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.role !== 'user' && entry.role !== 'assistant') continue;
    if (typeof entry.content !== 'string') continue;
    const content = entry.content.trim();
    if (!content) continue;
    clean.push({ role: entry.role, content: content.slice(0, MAX_HISTORY_ENTRY_CHARS) });
  }

  const capped = clean.slice(-MAX_HISTORY_ENTRIES);

  // The API rejects a conversation that does not start with a user turn, and a history
  // whose head was cut mid-exchange can easily start with an assistant one.
  while (capped.length && capped[0].role !== 'user') capped.shift();
  return capped;
}

/**
 * Ask the assistant one question.
 *
 * @param {{message:string, history:Array, user:object|null}} input
 * @returns {Promise<{reply:string, inputTokens:number, outputTokens:number}>}
 * @throws {Error & {code:'BUDGET_EXCEEDED'}} when a spend cap has been reached.
 */
async function ask({ message, history = [], user = null }) {
  const userId = user && user.id ? user.id : null;

  // Before the call, because the cost of a call is only known after it. The cap is
  // therefore crossed by at most one exchange; see utils/aiBudget.js.
  await assertWithinBudget(userId);

  const { stable, viewer } = buildSystemPrompt(user);
  const messages = [...sanitiseHistory(history), { role: 'user', content: message }];

  let response;
  try {
    response = await getClient().messages.create({
      model: assistantConfig.MODEL,
      max_tokens: assistantConfig.MAX_OUTPUT_TOKENS,
      system: [
        /*
         * Two blocks, and the split is the point. The first is byte-identical on every
         * request and marked cacheable; the second carries the per-viewer context and is
         * not. Merging them would make the whole system prompt volatile and cost full
         * price on every exchange.
         *
         * If the stable block is below the model's minimum cacheable length the marker is
         * simply ignored — no error, no behaviour change — so this stays correct as the
         * knowledge base grows past it.
         */
        { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: viewer }
      ],
      messages
    });
  } catch (err) {
    // A failed call can still have consumed input tokens, so it belongs in the ledger.
    // Fire and forget: the visitor is about to be told it failed either way.
    ApiUsage.record({
      feature: FEATURE,
      model: assistantConfig.MODEL,
      userId,
      outcome: 'error'
    });
    throw err;
  }

  const usage = response.usage || {};
  // Cache reads and writes are billed differently from ordinary input; counting them in
  // keeps the ledger honest rather than flattering.
  const inputTokens =
    (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
  const outputTokens = usage.output_tokens || 0;

  ApiUsage.record({
    feature: FEATURE,
    model: assistantConfig.MODEL,
    userId,
    inputTokens,
    outputTokens,
    costUsd: assistantConfig.costUsd(inputTokens, outputTokens),
    outcome: 'ok'
  });

  const reply = (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  return { reply, inputTokens, outputTokens };
}

module.exports = {
  FEATURE,
  ask,
  sanitiseHistory,
  isConfigured: assistantConfig.isConfigured
};
