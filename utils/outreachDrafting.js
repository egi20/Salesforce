'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const config = require('../config/config');
const drafting = require('../config/drafting');
const ApiUsage = require('../models/ApiUsage');
const { assertWithinBudget } = require('./aiBudget');
const { LIMITS } = require('../config/crm');
const { FORBIDDEN_TERMS } = require('./draftVerification');

/**
 * Drafting a first outreach message.
 *
 * THIS WRITES A DRAFT AND NOTHING ELSE. There is no send path anywhere in this module or
 * the routes above it: a person reads what came back, edits it, sends it from their own
 * mail client, and records that they did. The reference implementation has
 * `/outreach/generate` feeding an `/outreach/queue`, which is one scheduler away from an
 * application that mails a thousand strangers on its own. That is a different product with
 * a different risk profile, and it is not this one.
 *
 * THE MODEL IS GIVEN NO PERSONAL DETAIL. `factsFor` hands over the company, the country
 * and the job title, and nothing else — not the person's name, not their email address,
 * not their phone number. None of it improves a first paragraph about what the Hub does,
 * and all of it would be somebody's contact details leaving for a third party. The name is
 * put back by the template afterwards, locally, from the row.
 *
 * Spend goes to the same `ai_usage` ledger and the same month-to-date cap as every other
 * generated thing here, so outreach cannot quietly become the largest line on the invoice.
 */

const FEATURE = 'crm_outreach';

/** Shorter than a SOW section, and a hard ceiling: nobody reads a cold email of 400 words. */
const MIN_WORDS = 40;
const MAX_WORDS = 160;

let client = null;

function isConfigured() {
  return Boolean(config.assistant.apiKey);
}

function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.assistant.apiKey });
  return client;
}

/**
 * The instruction, composed once at module load so it is byte-identical on every call and
 * the cached prefix actually hits — the same reason `utils/assistantPrompt.js` composes
 * its long half once.
 */
const ROLE = `You write the first paragraph of a cold outreach message on behalf of Salesforce Hub, a marketplace where Salesforce consultants find contract work and companies hire them.

A person will read what you write, edit it, and send it from their own mail client under their own name. You are writing their first draft.

Rules, and the first one is not negotiable:

- Invent nothing about the recipient. You are given a company name, a country and a job title. You do not know their projects, their headcount, their tech stack, their revenue, or anything they have said publicly. Write as somebody who has looked up a company and nothing more.
- Never claim to have read, seen, noticed or admired anything of theirs. "I saw your recent post about..." is a lie in a first line, and it is the one that gets an address blocked.
- No statistics, no percentages, no figures of any kind. You have not been given any, so any you write are invented.
- No guarantee, warranty, indemnity, penalty, fixed price, or promise of a result.
- Say plainly why they are being contacted and what is on offer. One short paragraph, then one sentence asking whether it is worth a conversation.
- Plain text. No subject line, no greeting, no sign-off — the sender adds those.
- Write in English unless the country makes another language obviously right, and then still write English: the sender will translate if they want to.`;

/**
 * What the model is told. Deliberately thin — see the note above about personal detail.
 */
function factsFor(lead) {
  const lines = [`Company: ${lead.company}`];
  if (lead.job_title) lines.push(`The recipient's job title: ${lead.job_title}`);
  if (lead.country) lines.push(`Country: ${lead.country}`);
  return lines.join('\n');
}

/**
 * Check a draft before anybody sees it.
 *
 * Narrower than `utils/draftVerification.js` because the risk is different: a quote
 * narrative must not contradict an estimate, while an outreach message must not invent a
 * relationship or a figure. The commitment terms are shared from that module rather than
 * re-listed, so adding one there covers both.
 */
const FABRICATED_FAMILIARITY = [
  'i saw', 'i noticed', 'i read', 'i came across', 'i have been following',
  'your recent', 'your latest', 'impressed by', 'i admire', 'congratulations on',
  'i enjoyed', 'as a fellow'
];

function problemsWith(body) {
  const problems = [];
  const text = String(body ?? '').trim();

  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < MIN_WORDS) problems.push(`Too short: ${words} words, at least ${MIN_WORDS} expected.`);
  if (words > MAX_WORDS) problems.push(`Too long: ${words} words, at most ${MAX_WORDS} allowed.`);

  const lower = text.toLowerCase();

  for (const phrase of FABRICATED_FAMILIARITY) {
    if (lower.includes(phrase)) {
      problems.push(`Claims a familiarity it cannot have: "${phrase}".`);
    }
  }

  for (const term of FORBIDDEN_TERMS) {
    if (lower.includes(term)) problems.push(`Makes a commitment a draft must not make: "${term}".`);
  }

  // No digits at all. The model was handed none, so any it wrote are invented — the same
  // rule as a quote narrative, applied more bluntly because there is no estimate here to
  // check a figure against.
  const numerals = text.match(/\d+/g);
  if (numerals) problems.push(`Contains figures it was never given: ${[...new Set(numerals)].join(', ')}.`);

  if (/\[|\]|\{\{|TBD|insert /i.test(text)) problems.push('Contains a placeholder.');

  return problems;
}

async function draftFor(lead, { userId = null } = {}) {
  if (!isConfigured()) return { ok: false, reason: 'Drafting is not switched on.' };

  try {
    await assertWithinBudget(userId);
  } catch (err) {
    if (err.code === 'BUDGET_EXCEEDED') return { ok: false, reason: err.message };
    throw err;
  }

  let response;
  try {
    response = await getClient().beta.messages.create({
      model: drafting.MODEL,
      max_tokens: 700,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: ROLE, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: `${factsFor(lead)}\n\n---\n\nWrite the draft.`
        }
      ]
    });
  } catch (err) {
    ApiUsage.record({ feature: FEATURE, model: drafting.MODEL, userId, outcome: 'error' });
    console.error(`Outreach drafting failed for lead #${lead.id}: ${err.message}`);
    return { ok: false, reason: 'The drafting service did not answer. Please try again in a moment.' };
  }

  const usage = response.usage || {};
  const inputTokens =
    (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
  const outputTokens = usage.output_tokens || 0;

  ApiUsage.record({
    feature: FEATURE,
    model: response.model || drafting.MODEL,
    userId,
    inputTokens,
    outputTokens,
    costUsd: drafting.costUsd(inputTokens, outputTokens),
    outcome: 'ok'
  });

  // Checked before the content is read: a refusal comes back as an HTTP 200.
  if (response.stop_reason === 'refusal') {
    return { ok: false, reason: 'The model declined to draft this. Write it yourself.' };
  }

  const body = (response.content || [])
    .filter((chunk) => chunk.type === 'text')
    .map((chunk) => chunk.text)
    .join('\n')
    .trim()
    .slice(0, LIMITS.draft);

  const problems = problemsWith(body);
  if (problems.length) {
    // Returned with its reasons and never stored, the same as a quote draft that fails.
    // Not silently retried: somebody should see that the model invented a relationship,
    // because that is the failure this feature has to be watched for.
    return { ok: false, reason: 'The draft failed its checks and was discarded.', problems, body };
  }

  return { ok: true, body, model: response.model || drafting.MODEL, inputTokens, outputTokens };
}

module.exports = { FEATURE, ROLE, MIN_WORDS, MAX_WORDS, isConfigured, factsFor, problemsWith, draftFor };
