'use strict';

/**
 * One brand definition shared by the DOCX, XLSX and PPTX generators.
 *
 * The three libraries want colours in different shapes — `docx` and `exceljs` want hex
 * without a hash (exceljs additionally wants an alpha prefix), `pptxgenjs` wants hex
 * without a hash too — so the raw hex lives here once and each generator converts. Three
 * separate colour constants is how a deck ends up a different blue from the document.
 *
 * These mirror the tokens in `public/css/style.css`. Changing a brand colour means
 * changing both, and that is worth a comment because nothing enforces it.
 */
const HEX = {
  navy: '032D60',
  blue: '0B5CAB',
  cyan: '00A1E0',
  ink: '16191D',
  inkMuted: '6B7280',
  rule: 'C9CFD6',
  wash: 'F6F8FA',
  ok: '2E7D5B',
  warn: 'A86A00'
};

const FONT = 'Calibri';

/** exceljs wants ARGB. */
function argb(hex) {
  return `FF${hex}`;
}

/** Format an integer with thin thousands separators, for document text. */
function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-GB');
}

function formatMoney(value, currency) {
  return `${formatNumber(Math.round(Number(value || 0)))} ${currency}`;
}

/** ISO date, which is unambiguous in every locale a client might read it in. */
function formatDate(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * The palette one document renders with.
 *
 * A company may replace the two ACCENT colours and nothing else. Body text, rules and
 * shading stay the Hub's neutrals — a company choosing its own heading colour is branding;
 * a company choosing its own body-text colour is a company shipping an unreadable document
 * to a client under its own name.
 *
 * Values arriving here have already passed a 4.5:1 contrast check in
 * `config/companyTemplates.js` and are stored only if they pass, so this function does not
 * re-check: it would be checking the same value twice and the second check would be the
 * one nobody maintains. It does guard the SHAPE, because a malformed value would reach
 * `docx` as a colour and produce a file that opens to garbage.
 */
function paletteFor(branding) {
  const colours = (branding && branding.colours) || {};
  const palette = { ...HEX };

  for (const key of ['navy', 'blue']) {
    const value = colours[key];
    if (typeof value === 'string' && /^[0-9A-F]{6}$/i.test(value)) {
      palette[key] = value.toUpperCase();
    }
  }

  return palette;
}

/**
 * The letterhead lines, in the order they are printed, with nothing empty in between.
 *
 * Returns an empty array when a company has configured none, which is what lets every
 * generator render the block unconditionally instead of branching on whether it exists.
 */
function letterheadLines(branding) {
  const head = (branding && branding.letterhead) || {};

  return [
    head.legal_name,
    head.address,
    [head.contact_email, head.contact_phone].filter(Boolean).join('  ·  ') || null,
    head.website,
    [
      head.registration_number ? `Reg. ${head.registration_number}` : null,
      head.vat_number ? `VAT ${head.vat_number}` : null
    ].filter(Boolean).join('  ·  ') || null
  ].filter(Boolean);
}

module.exports = {
  HEX,
  FONT,
  argb,
  formatNumber,
  formatMoney,
  formatDate,
  paletteFor,
  letterheadLines
};
