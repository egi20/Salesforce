'use strict';

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  AlignmentType,
  BorderStyle,
  convertInchesToTwip
} = require('docx');

const { HEX, FONT, formatNumber, formatDate } = require('./brand');
const { assertDocumentOpens } = require('./validate');

/**
 * A one-page rate card: the commercial half of what a consultant sends an agency.
 *
 * Separate from the CV on purpose. A CV is a history and gets forwarded to a client; a
 * rate card is a current offer with a date on it, and combining them means either the
 * history goes stale or the price does. Sending one without the other is a normal thing
 * to want to do.
 *
 * Renders the dossier and computes NOTHING. Where a derived figure appears — the annual
 * equivalent — it is passed in already calculated by `utils/contractorEconomics.js`, the
 * module whose arithmetic is tested, rather than multiplied out here. A formatter doing
 * its own sums is how a document ends up disagreeing with the page it came from.
 */

const CELL_MARGIN = { top: 90, bottom: 90, left: 140, right: 140 };
const RULE = { style: BorderStyle.SINGLE, size: 6, color: HEX.rule, space: 6 };

function text(value, options = {}) {
  return new TextRun({ text: String(value ?? ''), font: FONT, ...options });
}

function para(value, options = {}) {
  const { spacing, alignment, ...runOptions } = options;
  return new Paragraph({
    alignment,
    spacing: spacing || { after: 120 },
    children: [text(value, runOptions)]
  });
}

function cell(value, { bold = false, shade = null, align = AlignmentType.LEFT, width = null } = {}) {
  return new TableCell({
    margins: CELL_MARGIN,
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    shading: shade ? { type: ShadingType.CLEAR, fill: shade } : undefined,
    children: [new Paragraph({ alignment: align, spacing: { after: 0 }, children: [text(value, { bold, size: 20 })] })]
  });
}

function table(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      ([label, value]) =>
        new TableRow({
          children: [cell(label, { bold: true, shade: HEX.wash, width: 35 }), cell(value, { width: 65 })]
        })
    )
  });
}

function sectionHeading(value) {
  return new Paragraph({
    spacing: { before: 300, after: 140 },
    border: { bottom: RULE },
    children: [text(value.toUpperCase(), { bold: true, color: HEX.navy, size: 22, characterSpacing: 20 })]
  });
}

/**
 * @param {object} dossier from services/consultantDossier.js
 * @param {object|null} projection an already-computed `contractorEconomics.project()`
 *   result, or null. When present, the annual equivalent is READ from it.
 */
async function generateRateCardDocx(dossier, projection = null) {
  const commercial = [];

  if (dossier.dayRate) {
    commercial.push(['Day rate', `${formatNumber(dossier.dayRate)} ${dossier.currency}`]);
  }
  if (projection && projection.money) {
    // Stated as what it is — revenue at an assumed number of billable days — rather than
    // as "annual salary". The two are not the same number and conflating them is the most
    // common mistake in this whole area.
    commercial.push([
      'Annual at this rate',
      `${formatNumber(projection.money.revenue)} ${dossier.currency} `
        + `(${projection.days.billable} billable days, before costs and tax)`
    ]);
  }
  if (dossier.workMode) {
    commercial.push(['Working arrangement', dossier.willingToTravel ? `${dossier.workMode}, willing to travel` : dossier.workMode]);
  }
  if (dossier.location) commercial.push(['Based in', dossier.location]);
  if (dossier.availability) {
    const when = dossier.availability === 'not_available' ? 'not currently available' : dossier.availability.replace(/_/g, ' ');
    commercial.push(['Availability', dossier.availableFrom ? `${when} (from ${dossier.availableFrom})` : when]);
  }

  const children = [
    new Paragraph({ spacing: { after: 40 }, children: [text(dossier.name, { bold: true, size: 34, color: HEX.navy })] }),
    para(dossier.headline || 'Salesforce consultant', { size: 22, color: HEX.blue }),
    new Paragraph({
      spacing: { after: 60 },
      border: { bottom: RULE },
      children: [text([dossier.email, dossier.links.linkedin].filter(Boolean).join('  ·  '), { size: 18, color: HEX.inkMuted })]
    })
  ];

  if (commercial.length) {
    children.push(sectionHeading('Commercial terms'), table(commercial));
  }

  if (dossier.skills.length) {
    children.push(sectionHeading('Specialisms'), para(dossier.skills.join('  ·  '), { size: 20 }));
  }

  if (dossier.certifications.length) {
    // Current ones only. A rate card is an offer, and an expired certification is not part
    // of one — the CV is where the full history, expiry labels included, belongs.
    const current = dossier.certifications.filter((c) => !c.expired).map((c) => c.name);
    if (current.length) children.push(sectionHeading('Certifications'), para(current.join('  ·  '), { size: 20 }));
  }

  children.push(
    sectionHeading('Terms'),
    para(
      'Rates are exclusive of VAT and of travel and accommodation, which are charged at cost '
        + 'where on-site attendance is requested. Quoted for the engagement described and valid '
        + 'for 30 days from the date below.',
      { size: 19, color: HEX.inkMuted }
    ),
    new Paragraph({
      spacing: { before: 240 },
      alignment: AlignmentType.RIGHT,
      children: [text(`Issued ${formatDate(dossier.generatedOn)}`, { size: 16, color: HEX.inkMuted })]
    })
  );

  const doc = new Document({
    creator: dossier.name,
    title: `${dossier.name} — rate card`,
    styles: { default: { document: { run: { font: FONT, size: 20, color: HEX.ink } } } },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(0.7),
              bottom: convertInchesToTwip(0.7),
              left: convertInchesToTwip(0.8),
              right: convertInchesToTwip(0.8)
            }
          }
        },
        children
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  assertDocumentOpens(buffer, 'docx', 'rate card');
  return buffer;
}

module.exports = { generateRateCardDocx };
