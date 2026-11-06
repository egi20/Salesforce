'use strict';

const { cvBlocks, defaultOptions } = require('./cvLayout');

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  BorderStyle,
  convertInchesToTwip
} = require('docx');

const { HEX, FONT, formatDate } = require('./brand');
const { assertDocumentOpens } = require('./validate');

/**
 * A consultant's CV, rendered from their Hub profile.
 *
 * THE RULE, the same one the SOW generator follows: this file RENDERS the dossier and
 * writes nothing of its own. It does not summarise a bio, rephrase an achievement or
 * invent a "profile statement" — the moment a generator starts producing prose, the CV
 * stops being the consultant's own claim about themselves and becomes something they have
 * to proofread against a model's idea of their career.
 *
 * The reference implementation put an LLM here, across four thousand lines. What that buys
 * is fluent text about a career the model does not know; what it costs is a document
 * someone sends to a client containing a sentence they never wrote. Structured data the
 * consultant already entered, laid out well, is both cheaper and more honest.
 *
 * Layout choices that are deliberate rather than aesthetic:
 *
 *  - Delivery history comes BEFORE employment. For a contractor the engagements are the
 *    substance; the employing entity is often an agency or their own company and tells a
 *    reader nothing.
 *  - No photo, no date of birth, no nationality, no marital status. They are common on
 *    European CVs and they are discrimination surface; the Hub has the photo and chooses
 *    not to put it here.
 *  - One column. Two-column CV layouts are what shred a document when a recruiter's
 *    parser reads it.
 */

const RULE = { style: BorderStyle.SINGLE, size: 6, color: HEX.rule, space: 6 };

function text(value, options = {}) {
  return new TextRun({ text: String(value ?? ''), font: FONT, ...options });
}

function para(value, options = {}) {
  const { spacing, alignment, ...runOptions } = options;
  return new Paragraph({
    alignment,
    spacing: spacing || { after: 100 },
    children: [text(value, runOptions)]
  });
}

function sectionHeading(value) {
  return new Paragraph({
    spacing: { before: 280, after: 120 },
    border: { bottom: RULE },
    children: [text(value.toUpperCase(), { bold: true, color: HEX.navy, size: 22, characterSpacing: 20 })]
  });
}

/** A line with the role on the left and its period pushed to the right margin. */
function entryHeading(left, right) {
  return new Paragraph({
    spacing: { before: 140, after: 20 },
    tabStops: [{ type: 'right', position: convertInchesToTwip(6.5) }],
    children: [
      text(left, { bold: true, size: 21 }),
      text('\t'),
      text(right || '', { color: HEX.inkMuted, size: 19 })
    ]
  });
}

function bullet(value) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 60 },
    children: [text(value, { size: 20 })]
  });
}

/**
 * Lays out the blocks `cvLayout.js` decided on. Nothing here chooses what a CV contains —
 * that is decided once, there, so the on-page preview and this file cannot disagree.
 */
function paragraphFor(block) {
  switch (block.kind) {
    case 'name':
      return new Paragraph({ spacing: { after: 40 }, children: [text(block.text, { bold: true, size: 36, color: HEX.navy })] });
    case 'headline':
      return para(block.text, { size: 22, color: HEX.blue, spacing: { after: 80 } });
    case 'contact':
      return new Paragraph({
        spacing: { after: 40 },
        border: { bottom: RULE },
        children: [text(block.text, { size: 18, color: HEX.inkMuted })]
      });
    case 'heading':
      return sectionHeading(block.text);
    case 'fact':
      return new Paragraph({
        spacing: { after: 40 },
        tabStops: [{ type: 'left', position: convertInchesToTwip(1.4) }],
        children: [text(block.label, { bold: true, size: 20 }), text('\t'), text(block.value, { size: 20 })]
      });
    case 'bullet':
      return bullet(block.text);
    case 'entry':
      return entryHeading(block.left, block.right);
    case 'subtitle':
      return para(block.text, { size: 19, color: HEX.inkMuted, spacing: { after: 60 } });
    case 'line':
    case 'para':
      return para(block.text, { size: 20 });
    default:
      throw new Error(`Unknown CV block: ${block.kind}`);
  }
}

function buildSections(dossier, options) {
  return cvBlocks(dossier, options).map(paragraphFor);
}

/**
 * @returns {Promise<Buffer>} a .docx that has been opened and parsed before it is returned.
 */
async function generateCvDocx(dossier, options = defaultOptions(dossier)) {
  const doc = new Document({
    creator: dossier.name,
    title: `${dossier.name} — CV`,
    styles: { default: { document: { run: { font: FONT, size: 20, color: HEX.ink } } } },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(0.6),
              bottom: convertInchesToTwip(0.6),
              left: convertInchesToTwip(0.7),
              right: convertInchesToTwip(0.7)
            }
          }
        },
        children: [
          ...buildSections(dossier, options),
          new Paragraph({
            spacing: { before: 300 },
            alignment: AlignmentType.RIGHT,
            children: [text(`Generated ${formatDate(dossier.generatedOn)}`, { size: 16, color: HEX.inkMuted })]
          })
        ]
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  // Never serve a container nobody has opened: a subtly broken XML part downloads fine and
  // then fails in Word, which the recipient experiences as "you sent me a corrupt file".
  assertDocumentOpens(buffer, 'docx', 'CV');
  return buffer;
}

module.exports = { generateCvDocx };
