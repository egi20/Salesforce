'use strict';

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
 * Free text the consultant wrote, split on blank lines into paragraphs.
 *
 * Rendered as plain runs: whatever they typed, exactly, with no markdown interpretation.
 * A bio is not a rich-text field anywhere else in this application and it does not become
 * one on the way into a document.
 */
function bodyText(value, options = {}) {
  return String(value || '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => para(block, { size: 20, ...options }));
}

function header(dossier) {
  const children = [
    new Paragraph({
      spacing: { after: 40 },
      children: [text(dossier.name, { bold: true, size: 36, color: HEX.navy })]
    })
  ];

  if (dossier.headline) {
    children.push(para(dossier.headline, { size: 22, color: HEX.blue, spacing: { after: 80 } }));
  }

  // One contact line. Everything in it is something the consultant put on their profile
  // on purpose; nothing is derived from the account.
  const contact = [
    dossier.email,
    dossier.location,
    dossier.links.linkedin,
    dossier.links.website,
    dossier.links.trailblazer
  ].filter(Boolean);

  if (contact.length) {
    children.push(
      new Paragraph({
        spacing: { after: 40 },
        border: { bottom: RULE },
        children: [text(contact.join('  ·  '), { size: 18, color: HEX.inkMuted })]
      })
    );
  }

  return children;
}

function facts(dossier) {
  // The things a client screening a contractor checks first, on one line each.
  const rows = [];
  if (dossier.roleLabel) rows.push(['Role', dossier.seniority ? `${dossier.roleLabel} (${dossier.seniority})` : dossier.roleLabel]);
  if (dossier.yearsExperience) rows.push(['Experience', `${dossier.yearsExperience} years`]);
  if (dossier.workMode) {
    rows.push(['Working', dossier.willingToTravel ? `${dossier.workMode}, willing to travel` : dossier.workMode]);
  }
  if (dossier.availability && dossier.availability !== 'not_available') {
    const when = dossier.availability.replace(/_/g, ' ');
    rows.push(['Available', dossier.availableFrom ? `${when} (from ${dossier.availableFrom})` : when]);
  }

  if (!rows.length) return [];

  return [
    sectionHeading('At a glance'),
    ...rows.map(
      ([label, value]) =>
        new Paragraph({
          spacing: { after: 40 },
          tabStops: [{ type: 'left', position: convertInchesToTwip(1.4) }],
          children: [text(`${label}`, { bold: true, size: 20 }), text('\t'), text(value, { size: 20 })]
        })
    )
  ];
}

function buildSections(dossier) {
  const children = [...header(dossier)];

  if (dossier.bio) {
    children.push(sectionHeading('Profile'), ...bodyText(dossier.bio));
  }

  children.push(...facts(dossier));

  if (dossier.skills.length) {
    children.push(sectionHeading('Skills'));
    // One wrapped line rather than a bulleted column: a parser reads it the same way and
    // it costs a tenth of the page.
    children.push(para(dossier.skills.join('  ·  '), { size: 20 }));
  }

  if (dossier.certifications.length) {
    children.push(sectionHeading('Certifications'));
    for (const cert of dossier.certifications) {
      const suffix = [cert.earned, cert.credentialId ? `ID ${cert.credentialId}` : null]
        .filter(Boolean)
        .join(' · ');
      // An expired certification is LABELLED rather than dropped. Quietly removing it
      // would hide from the consultant exactly the thing a client is about to notice.
      children.push(bullet(`${cert.name}${suffix ? ` — ${suffix}` : ''}${cert.expired ? ' (expired)' : ''}`));
    }
  }

  if (dossier.projects.length) {
    children.push(sectionHeading('Delivery history'));
    for (const project of dossier.projects) {
      const subtitle = [project.client, project.cloud, project.role].filter(Boolean).join(' · ');
      children.push(entryHeading(project.name, project.period));
      if (subtitle) children.push(para(subtitle, { size: 19, color: HEX.inkMuted, spacing: { after: 60 } }));
      children.push(...bodyText(project.description));
    }
  }

  if (dossier.experience.length) {
    children.push(sectionHeading('Employment'));
    for (const role of dossier.experience) {
      children.push(entryHeading(`${role.title} — ${role.company}`, role.period));
      children.push(...bodyText(role.description));
    }
  }

  return children;
}

/**
 * @returns {Promise<Buffer>} a .docx that has been opened and parsed before it is returned.
 */
async function generateCvDocx(dossier) {
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
          ...buildSections(dossier),
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
