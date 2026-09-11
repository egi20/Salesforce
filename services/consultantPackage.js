'use strict';

const archiver = require('archiver');

const { slugify } = require('../utils/slug');
const { generateCvDocx } = require('../utils/documents/cvDocx');
const { generateRateCardDocx } = require('../utils/documents/rateCardDocx');
const { project } = require('../utils/contractorEconomics');

/**
 * The consultant's own documents: a CV and a rate card, separately or zipped.
 *
 * Mirrors `services/quotePackage.js` deliberately, including the two rules that are not
 * negotiable there either:
 *
 *  1. RENDER, NEVER RECOMPUTE. Both generators format the dossier assembled by
 *     `services/consultantDossier.js`. The one derived figure on the rate card — the
 *     annual equivalent — is computed here by `utils/contractorEconomics.js`, whose
 *     arithmetic is tested, and passed in ready.
 *  2. OPEN IT BEFORE ANYONE ELSE HAS TO. Each generator ends with `assertDocumentOpens`,
 *     and a failure throws rather than shipping a file that downloads fine and then will
 *     not open.
 */

const DOCUMENT_KINDS = Object.freeze({
  cv: {
    label: 'CV',
    extension: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    generate: (dossier) => generateCvDocx(dossier)
  },
  'rate-card': {
    label: 'Rate card',
    extension: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    /*
     * The projection uses the DEFAULT assumptions, not anything the consultant typed into
     * the calculator. A rate card is sent to someone else, and quoting an annual figure
     * derived from that person's private view of their own bench time would be both
     * misleading and a small privacy leak. The document says which assumption it used.
     */
    generate: (dossier) => generateRateCardDocx(dossier, dossier.dayRate ? project({ dayRate: dossier.dayRate }) : null)
  }
});

const PACKAGE_KIND = 'package';

function isDocumentKind(kind) {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_KINDS, kind);
}

/**
 * A safe, descriptive download filename.
 *
 * The consultant's name is SLUGIFIED rather than interpolated. It lands in a
 * `Content-Disposition` header, so a name containing a quote, a slash or a newline is a
 * header-injection vector as well as a file the recipient's operating system refuses to
 * save — and unlike a client name typed into a form, this one is on every download the
 * consultant makes.
 */
function filenameFor(dossier, kind) {
  const spec = kind === PACKAGE_KIND ? { extension: 'zip' } : DOCUMENT_KINDS[kind];
  return `${slugify(dossier.name, 'consultant')}-${kind}.${spec.extension}`;
}

async function generateDocument(dossier, kind) {
  if (!isDocumentKind(kind)) {
    const err = new Error(`Unknown document kind: ${kind}`);
    err.code = 'UNKNOWN_DOCUMENT_KIND';
    throw err;
  }

  const spec = DOCUMENT_KINDS[kind];
  const buffer = await spec.generate(dossier);
  return { buffer, filename: filenameFor(dossier, kind), contentType: spec.contentType };
}

async function generatePackage(dossier) {
  const documents = [];
  for (const kind of Object.keys(DOCUMENT_KINDS)) {
    // Sequential: two OOXML builds in parallel spike memory on a small instance for no
    // wall-clock gain worth having.
    // eslint-disable-next-line no-await-in-loop
    documents.push(await generateDocument(dossier, kind));
  }

  const buffer = await new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];

    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('warning', reject);
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));

    for (const document of documents) archive.append(document.buffer, { name: document.filename });
    archive.append(readmeFor(dossier, documents), { name: 'README.txt' });
    archive.finalize().catch(reject);
  });

  return {
    buffer,
    filename: filenameFor(dossier, PACKAGE_KIND),
    contentType: 'application/zip',
    contents: documents.map((d) => d.filename)
  };
}

/**
 * A plain-text note in the archive.
 *
 * Says where the documents came from and, more usefully, that editing them is expected.
 * A CV generated from a profile is a starting point for a specific application, not a
 * finished artefact, and saying so is the difference between a tool people use and one
 * they try once.
 */
function readmeFor(dossier, documents) {
  return [
    `Documents for ${dossier.name}`,
    `Generated ${dossier.generatedOn.toISOString().slice(0, 10)} from the Salesforce Hub profile.`,
    '',
    'Contents:',
    ...documents.map((d) => `  - ${d.filename}`),
    '',
    'These are rendered from the profile exactly as it stands — nothing has been summarised,',
    'rephrased or invented. Edit them freely: a CV tailored to one role beats a generated one,',
    'and regenerating here is cheap once the profile itself is up to date.',
    '',
    'The rate card states an annual figure at a standard assumption of billable days. It is',
    'revenue before costs and before tax, not a salary equivalent.'
  ].join('\n');
}

module.exports = {
  DOCUMENT_KINDS,
  PACKAGE_KIND,
  isDocumentKind,
  filenameFor,
  generateDocument,
  generatePackage
};
