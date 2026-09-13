'use strict';

const { MIN_TEXT_RATIO, normaliseHex, contrastRatio, isReadableOnPaper } = require('../utils/contrast');

/**
 * What a company may change about the documents this Hub produces for it.
 *
 * THE DECISION THAT DEFINES THIS FEATURE: **no document is ever uploaded.** A company
 * supplies its brand and its standard wording; the Hub's own validated generators render
 * with them. There is no mail-merge into a file somebody sent us.
 *
 * The reference implementation went the other way, and it is worth being specific about
 * what that costs, because "let them upload their template" sounds obviously friendlier:
 *
 *  - It asks a company to upload A REAL PERSON'S CV as the sample, then stores that
 *    person's name and up to forty thousand characters of their document indefinitely as
 *    "template configuration". That is a third party's personal data, retained by us, on a
 *    basis nobody established.
 *  - The uploaded bytes are written to DISK, which this application's own rule forbids —
 *    the host filesystem is assumed wiped on every deploy.
 *  - Whatever Open XML arrived is then served back out. A .docx can carry macros, remote
 *    template references and external relationships; serving one we did not build breaks
 *    "never serve a document you have not opened" in the most complete way available.
 *
 * Branding our own generators gets a company a document that looks like theirs, and gets
 * us none of that.
 */

/**
 * Only the ACCENT colours are brandable.
 *
 * Body text, rules and table shading stay the Hub's neutrals. A company choosing its own
 * heading colour is branding; a company choosing its own body-text colour is a company
 * shipping an unreadable document to a client under its own name, and the person who chose
 * it is the last to find out.
 */
const BRANDABLE_KEYS = Object.freeze(['navy', 'blue']);

/** Where a company's own clause text can be added to a generated document. */
const CLAUSE_KINDS = Object.freeze({
  assumption: {
    key: 'assumption',
    label: 'Assumption',
    help: 'Added to the standard assumptions in a statement of work.',
    maxLength: 400
  },
  exclusion: {
    key: 'exclusion',
    label: 'Exclusion',
    help: 'Added to the standard exclusions. Say what is NOT in scope.',
    maxLength: 400
  },
  term: {
    key: 'term',
    label: 'Term',
    help: 'Payment terms, notice, change control. Appears under its own heading.',
    maxLength: 600
  }
});

const CLAUSE_KIND_KEYS = Object.freeze(Object.keys(CLAUSE_KINDS));

/** A cap, so one company cannot turn a two-page quote into a contract nobody reads. */
const MAX_CLAUSES_PER_KIND = 12;

/**
 * The letterhead fields.
 *
 * Plain text, every one of them, and rendered with the escaping output tag. This is the
 * block that appears on every document a company sends a client, which makes it the
 * highest-value place in the application to put markup — and it buys nothing: a letterhead
 * needs a company name and a VAT number, not formatting.
 */
const LETTERHEAD_FIELDS = Object.freeze([
  { key: 'legal_name', label: 'Legal entity name', maxLength: 200, help: 'As registered. Not the trading name, if they differ.' },
  { key: 'registration_number', label: 'Company registration number', maxLength: 60 },
  { key: 'vat_number', label: 'VAT number', maxLength: 60 },
  { key: 'address', label: 'Registered address', maxLength: 300, multiline: true },
  { key: 'contact_email', label: 'Contact email', maxLength: 255 },
  { key: 'contact_phone', label: 'Contact phone', maxLength: 60 },
  { key: 'website', label: 'Website', maxLength: 255 },
  { key: 'footer_note', label: 'Footer line', maxLength: 200, help: 'One line at the foot of every page. A registration line, or nothing.' }
]);

/**
 * Check a proposed brand colour.
 *
 * Refuses rather than silently substituting. A company that picks a colour and then finds
 * the document rendered in a different one has been lied to about what it configured; a
 * company told "that colour is unreadable on white, here is the measurement" can choose
 * again.
 *
 * @returns {{ok:true, hex:string, ratio:number} | {ok:false, reason:string, ratio?:number}}
 */
function checkBrandColour(value) {
  const hex = normaliseHex(value);
  if (!hex) return { ok: false, reason: 'That is not a hex colour. Use something like #0176D3.' };

  const ratio = contrastRatio(hex, 'FFFFFF');
  if (!isReadableOnPaper(hex)) {
    return {
      ok: false,
      ratio,
      reason:
        `#${hex} sits at ${ratio.toFixed(2)}:1 against white, below the ${MIN_TEXT_RATIO}:1 needed for `
        + 'readable text. Pick a darker shade of the same hue — it will still read as your brand.'
    };
  }

  return { ok: true, hex, ratio };
}

function isClauseKind(kind) {
  return Object.prototype.hasOwnProperty.call(CLAUSE_KINDS, kind);
}

/**
 * Boot assertion, in the same spirit as every other catalogue here. The one that matters
 * is the last: a brandable key that is not actually a colour in `utils/documents/brand.js`
 * would be configuration a company can set and no document reads.
 */
function assertCompanyTemplateIntegrity() {
  const { HEX } = require('../utils/documents/brand');

  for (const key of BRANDABLE_KEYS) {
    if (!HEX[key]) throw new Error(`Company templates: brandable key "${key}" is not a document colour`);
  }
  for (const [key, clause] of Object.entries(CLAUSE_KINDS)) {
    if (clause.key !== key) throw new Error(`Company templates: clause "${key}" disagrees with its own key`);
    if (!clause.maxLength || clause.maxLength < 50) {
      throw new Error(`Company templates: clause "${key}" has an unusable length cap`);
    }
  }
  for (const field of LETTERHEAD_FIELDS) {
    if (!field.key || !field.label) throw new Error('Company templates: a letterhead field has no key or label');
  }
  // The Hub's own defaults must pass the check a company's colour has to pass.
  for (const key of BRANDABLE_KEYS) {
    if (!isReadableOnPaper(HEX[key])) {
      throw new Error(`Company templates: the Hub's own "${key}" fails its own contrast rule`);
    }
  }
  return true;
}

module.exports = {
  BRANDABLE_KEYS,
  CLAUSE_KINDS,
  CLAUSE_KIND_KEYS,
  MAX_CLAUSES_PER_KIND,
  LETTERHEAD_FIELDS,
  checkBrandColour,
  isClauseKind,
  assertCompanyTemplateIntegrity
};
