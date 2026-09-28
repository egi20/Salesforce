'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const config = require('../config/config');
const cvImportConfig = require('../config/cvImport');
const ApiUsage = require('../models/ApiUsage');
const { assertWithinBudget } = require('./aiBudget');

const FEATURE = 'cv_import';

let client = null;

function isConfigured() {
  return Boolean(config.assistant.apiKey);
}

function getClient() {
  if (!isConfigured()) throw new Error('CV import is not configured (ANTHROPIC_API_KEY is unset)');
  if (!client) client = new Anthropic({ apiKey: config.assistant.apiKey });
  return client;
}

/**
 * Byte-identical on every request, same reasoning as the assistant's and the drafter's own
 * split prompt: nothing per-request is interpolated here, so Anthropic's prompt cache can
 * hit on the instruction half every time.
 */
const ROLE = `You extract structured facts from a consultant's own CV, to prefill a profile form they will review before saving. You do not write anything new.

Rules:

1. Extract only what the CV states. A field you cannot find is an empty string or null — never guessed, never invented, never filled with something plausible.
2. "bio" is a short professional summary IN THE CV'S OWN WORDS, condensed to at most three sentences — a compression of what is there, not new prose about the person.
3. "skills" lists technologies, platforms and tools named in the CV, as short strings.
4. "years_experience" is a whole number if the CV states or clearly implies one (e.g. from employment dates), otherwise null.
5. Return ONLY a single JSON object, no markdown fences, no commentary before or after it, matching exactly this shape:
{"given_name":"","family_name":"","phone":"","headline":"","city":"","country":"","years_experience":null,"skills":[],"bio":""}`;

/** Every key the model is allowed to have produced — nothing else survives the parse. */
const ALLOWED_KEYS = ['given_name', 'family_name', 'phone', 'headline', 'city', 'country', 'years_experience', 'skills', 'bio'];

function sanitizeResult(parsed) {
  const out = {};
  for (const key of ALLOWED_KEYS) {
    const value = parsed[key];
    if (key === 'skills') {
      out.skills = Array.isArray(value) ? value.filter((s) => typeof s === 'string').slice(0, 40).map((s) => s.slice(0, 60)) : [];
    } else if (key === 'years_experience') {
      const n = Number(value);
      out.years_experience = Number.isFinite(n) && n >= 0 && n <= 60 ? Math.round(n) : null;
    } else {
      out[key] = typeof value === 'string' ? value.slice(0, 300) : '';
    }
  }
  return out;
}

/**
 * @param {string} cvText plain text already extracted from the upload (utils/cvText.js)
 * @returns {Promise<{ok:true, fields:object} | {ok:false, reason:string}>}
 *
 * Same shape of contract as `quoteDrafting.draftSection`: errors come back, never throw,
 * because the caller is a route that must still answer the fetch() that is waiting on it.
 */
async function importFromText(cvText, { userId = null } = {}) {
  if (!isConfigured()) return { ok: false, reason: 'CV import is not configured.' };
  if (!cvText || !cvText.trim()) return { ok: false, reason: 'That file did not contain any readable text.' };

  const text = cvText.slice(0, cvImportConfig.MAX_TEXT_CHARS);

  try {
    await assertWithinBudget(userId);
  } catch (err) {
    if (err.code === 'BUDGET_EXCEEDED') return { ok: false, reason: err.message };
    throw err;
  }

  let response;
  try {
    response = await getClient().messages.create({
      model: cvImportConfig.MODEL,
      max_tokens: cvImportConfig.MAX_OUTPUT_TOKENS,
      system: [{ type: 'text', text: ROLE, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `CV text:\n\n${text}` }]
    });
  } catch (err) {
    ApiUsage.record({ feature: FEATURE, model: cvImportConfig.MODEL, userId, outcome: 'error' });
    console.error(`CV import failed: ${err.message}`);
    return { ok: false, reason: 'The import service did not answer. Please try again in a moment.' };
  }

  const usage = response.usage || {};
  const inputTokens =
    (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const outputTokens = usage.output_tokens || 0;

  ApiUsage.record({
    feature: FEATURE,
    model: response.model || cvImportConfig.MODEL,
    userId,
    inputTokens,
    outputTokens,
    costUsd: cvImportConfig.costUsd(inputTokens, outputTokens),
    outcome: 'ok'
  });

  if (response.stop_reason === 'refusal') {
    return { ok: false, reason: 'The model declined to read this file.' };
  }

  const body = (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  let parsed;
  try {
    // Defensive: strip an accidental ```json fence even though the prompt asks for none.
    const jsonText = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, reason: 'The import did not return a readable result.' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'The import did not return a readable result.' };
  }

  return { ok: true, fields: sanitizeResult(parsed) };
}

module.exports = { FEATURE, isConfigured, importFromText };
