'use strict';

const { GLOBAL_MONTHLY_BUDGET_USD } = require('./assistant');

/**
 * AI-assisted CV import for the consultant profile form.
 *
 * Haiku, not Opus: this is extraction from a document the consultant themselves supplied,
 * not prose written under their name — closer to the assistant's job than the quote
 * drafter's. It shares the assistant's month-to-date budget for the same reason drafting
 * does: one ledger, one number to reconcile with an invoice.
 *
 * WHAT IT CANNOT DO: nothing here writes to the profile. The model returns a JSON object,
 * the route hands it to the browser, and the consultant sees it filled into the form
 * fields they were already going to fill in by hand — reviewed and saved (or not) exactly
 * like every other edit on this page. There is no path from a CV's bytes to a stored row.
 */

const MODEL = process.env.CV_IMPORT_MODEL || 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 1200;

const PRICE_PER_MTOK_INPUT = Number(process.env.CV_IMPORT_PRICE_INPUT_USD || 1);
const PRICE_PER_MTOK_OUTPUT = Number(process.env.CV_IMPORT_PRICE_OUTPUT_USD || 5);

/** A CV is a page or two of text; anything past this is almost certainly not one. */
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 20000;

/**
 * .docx and .txt only. A PDF CV is common, but reading one needs a parser this codebase
 * does not otherwise depend on — better to say plainly what is accepted than to add a
 * dependency for one feature and hope it never mishandles a hostile file.
 */
const ACCEPTED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
]);
const ACCEPTED_EXT = /\.(docx|txt)$/i;

function costUsd(inputTokens, outputTokens) {
  const input = (Number(inputTokens) || 0) / 1e6;
  const output = (Number(outputTokens) || 0) / 1e6;
  return input * PRICE_PER_MTOK_INPUT + output * PRICE_PER_MTOK_OUTPUT;
}

function assertCvImportIntegrity() {
  if (!MODEL) throw new Error('CV import: no model configured');
  if (MAX_OUTPUT_TOKENS <= 0) throw new Error('CV import: MAX_OUTPUT_TOKENS must be positive');
  for (const value of [PRICE_PER_MTOK_INPUT, PRICE_PER_MTOK_OUTPUT]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('CV import: prices must be non-negative numbers');
  }
  if (ACCEPTED_MIME.size === 0) throw new Error('CV import: no accepted file types configured');
}

module.exports = {
  MODEL,
  MAX_OUTPUT_TOKENS,
  PRICE_PER_MTOK_INPUT,
  PRICE_PER_MTOK_OUTPUT,
  MAX_DOCUMENT_BYTES,
  MAX_TEXT_CHARS,
  ACCEPTED_MIME,
  ACCEPTED_EXT,
  GLOBAL_MONTHLY_BUDGET_USD,
  costUsd,
  assertCvImportIntegrity
};
