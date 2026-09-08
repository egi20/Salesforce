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

module.exports = { HEX, FONT, argb, formatNumber, formatMoney, formatDate };
