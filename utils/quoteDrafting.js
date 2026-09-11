'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const config = require('../config/config');
const drafting = require('../config/drafting');
const ApiUsage = require('../models/ApiUsage');
const { assertWithinBudget } = require('./aiBudget');
const { problemsWith } = require('./draftVerification');
const { moduleLabel } = require('../config/cloudFamilies');
const { ISV_SOLUTIONS } = require('../config/estimation');

/**
 * Drafting the narrative sections of a quote.
 *
 * Degrades exactly like the assistant: with no `ANTHROPIC_API_KEY` the module loads,
 * `isConfigured()` is false, the buttons are not rendered and the route answers plainly.
 *
 * The flow, and every step of it is load-bearing:
 *
 *   budget check -> build facts from the STORED estimate -> ask -> VERIFY -> store
 *
 * The verify step is the one that makes this feature honest. A draft containing a figure
 * the estimate does not contain is never stored and never shown; the author is told what
 * the model did. Retrying silently would hide the single failure mode that matters.
 */

const FEATURE = 'quote_drafting';

let client = null;

function isConfigured() {
  return Boolean(config.assistant.apiKey);
}

function getClient() {
  if (!isConfigured()) throw new Error('Drafting is not configured (ANTHROPIC_API_KEY is unset)');
  if (!client) client = new Anthropic({ apiKey: config.assistant.apiKey });
  return client;
}

/**
 * The stable half of the system prompt.
 *
 * Byte-identical on every request so Anthropic's prompt cache can hit, for the same reason
 * `utils/assistantPrompt.js` splits its prompt: anything interpolated here would miss the
 * cache on every draft. The quote's own facts go in the user message, where they belong.
 */
const ROLE = `You draft the narrative sections of a Statement of Work for a Salesforce implementation. The consultant sending it puts their own name on it, so you are writing a first draft for them to edit — not a finished document.

Absolute rules, in order of importance:

1. NEVER WRITE A NUMERAL. Not a day count, not a cost, not a percentage, not a week number, not a date, not a version. Write small quantities as words ("three phases", "two workstreams"). Every figure this project has is already printed in tables beside your text; repeating one in prose is how a document ends up contradicting itself, and inventing one is worse. A draft containing any numeral that is not in the estimate is rejected automatically and the consultant is shown what you did.
2. NEVER MAKE A COMMITMENT. No guarantees, no warranties, no indemnities, no penalties, no "fixed price". You are describing an approach, not agreeing terms.
3. NEVER INVENT A FACT about the client, their systems, their industry or their people. Write only from the facts given. Where something is genuinely unknown, say it is to be confirmed during discovery — in those words, as prose.
4. Leave no placeholder. No square brackets, no TBD, no "insert here". If you cannot write a section from the facts given, write less rather than filling space.

Style: plain professional English, short paragraphs, no headings, no bullet lists unless the section asks for them, no marketing language. Write as "we" for the delivering team and "you" for the client. British spelling.`;

/** Bands like "Large (501-5000)" carry digits. The narrative wants the sense, not the range. */
function sizePhrase(companySize) {
  if (!companySize) return null;
  const band = String(companySize).toLowerCase();
  if (band.startsWith('small')) return 'Client size: a small organisation';
  if (band.startsWith('medium')) return 'Client size: a mid-sized organisation';
  if (band.startsWith('large')) return 'Client size: a large organisation';
  if (band.startsWith('enterprise')) return 'Client size: a global enterprise';
  return null;
}

/** The facts, and nothing else. Derived from the STORED estimate, never recomputed. */
function factsFor(quote) {
  const estimate = quote.estimate || {};
  const inputs = quote.inputs || {};

  const lines = [
    `Client: ${quote.client_company || quote.client_name || 'not stated'}`,
    `Project: ${quote.project_name}`,
    quote.client_industry ? `Industry: ${quote.client_industry}` : null,
    // Written as a phrase, not a band like "201-1000": rule 1 tells the model to write no
    // numerals, and handing it some in the facts is an invitation to echo them.
    sizePhrase(quote.company_size),
    quote.project_summary ? `What the client asked for, in their words: ${quote.project_summary}` : null,
    '',
    'Scope, as chosen:',
    ...(inputs.modules || []).map((m) => `  - ${moduleLabel(m) || m}`),
    ...(inputs.isvSolutions || []).map((s) => `  - add-on: ${(ISV_SOLUTIONS[s] && ISV_SOLUTIONS[s].name) || s}`),
    inputs.complexity ? `Complexity: ${inputs.complexity}` : null,
    inputs.customization ? `Customisation level: ${inputs.customization}` : null,
    '',
    'Delivery phases, in order:',
    ...(estimate.phaseBreakdown || []).map((p) => `  - ${p.name}: ${p.description}`),
    '',
    'Team shape:',
    ...(estimate.resourceAllocation || []).map((r) => `  - ${r.name}`),
    '',
    (inputs.includeTraining ? 'Training is in scope.' : 'Training is NOT in scope.'),
    (inputs.includeHypercare ? 'Post-go-live hypercare is in scope.' : 'Hypercare is NOT in scope.')
  ];

  /*
   * Note what is NOT in this list: no day counts, no costs, no rates, no week numbers.
   * The model cannot repeat a figure it was never given, which makes rule 1 something the
   * prompt supports rather than something it merely asks for.
   */
  return lines.filter((line) => line !== null).join('\n');
}

function instructionFor(section) {
  return [
    `Write the "${section.label}" section.`,
    `It covers: ${section.writes}.`,
    `It must NOT include: ${section.neverWrites}.`,
    `Length: between ${section.minWords} and ${section.maxWords} words.`,
    'Return the section body only — no heading, no preamble, no closing remark.'
  ].join('\n');
}

/**
 * Draft one section.
 *
 * @returns {Promise<{ok:true, body:string, inputTokens:number, outputTokens:number}
 *   | {ok:false, reason:string, problems?:string[], body?:string}>}
 *
 * Errors are RETURNED rather than thrown: every caller is a route rendering a page that
 * must still render, and "the model invented a figure" is information for the author, not
 * a 500.
 */
async function draftSection(quote, sectionKey, { userId = null } = {}) {
  if (!drafting.isSection(sectionKey)) return { ok: false, reason: 'unknown section' };
  if (!isConfigured()) return { ok: false, reason: 'not configured' };

  const section = drafting.SECTIONS[sectionKey];
  // Built once and reused: the same text goes to the model AND into the verifier's
  // permitted set, so a product name the model was handed cannot fail the numeral check.
  const facts = factsFor(quote);

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
      max_tokens: drafting.MAX_OUTPUT_TOKENS,
      /*
       * Adaptive thinking: deciding what belongs in a scope narrative, from a module list
       * and a phase plan, is judgement rather than transcription.
       *
       * Server-side refusal fallback is on by default for this model family. A scope
       * document is unlikely to be declined, but a decline with no fallback would surface
       * to the author as an unexplained empty draft.
       */
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [
        { type: 'text', text: ROLE, cache_control: { type: 'ephemeral' } }
      ],
      messages: [
        {
          role: 'user',
          content: `Facts about this engagement:\n\n${facts}\n\n---\n\n${instructionFor(section)}`
        }
      ]
    });
  } catch (err) {
    ApiUsage.record({ feature: FEATURE, model: drafting.MODEL, userId, outcome: 'error' });
    console.error(`Drafting failed for quote #${quote.id} (${sectionKey}): ${err.message}`);
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

  // Checked BEFORE reading the content, as the API requires: a refusal is an HTTP 200.
  if (response.stop_reason === 'refusal') {
    return { ok: false, reason: 'The model declined to draft this section. Please write it yourself.' };
  }

  const body = (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  /*
   * THE GATE. A draft that fails is returned with its reasons and never stored — see
   * `utils/draftVerification.js`. It is not silently retried: the author should see that
   * the model invented a figure, because that is the thing this feature has to be
   * watched for.
   */
  const problems = problemsWith(body, quote.estimate, {
    minWords: section.minWords,
    maxWords: section.maxWords,
    context: facts
  });

  if (problems.length) {
    return { ok: false, reason: 'The draft failed its own checks and was discarded.', problems, body };
  }

  return { ok: true, body, inputTokens, outputTokens, model: response.model || drafting.MODEL };
}

module.exports = { FEATURE, ROLE, isConfigured, factsFor, instructionFor, draftSection };
