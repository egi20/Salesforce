'use strict';

const archiver = require('archiver');

const { generateSowDocx } = require('../utils/documents/sowDocx');
const { generateWbsXlsx } = require('../utils/documents/wbsXlsx');
const { generateSummaryPptx } = require('../utils/documents/summaryPptx');
const { slugify } = require('../utils/slug');

/**
 * Build the client-facing deliverables from one stored quote.
 *
 * All three documents render the SAME stored `quote.estimate`. None of them recalculates
 * anything, so the SOW, the workbook and the deck cannot disagree — which is the failure
 * that makes a document set worthless, because the client finds the discrepancy and then
 * trusts none of the three.
 *
 * Each generator validates its own output before returning it (see
 * `utils/documents/validate.js`), so nothing that cannot be opened ever reaches this
 * layer, let alone a recipient.
 */
const DOCUMENT_KINDS = Object.freeze({
  sow: {
    label: 'Statement of work',
    extension: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    generate: generateSowDocx
  },
  wbs: {
    label: 'Work breakdown',
    extension: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    generate: generateWbsXlsx
  },
  deck: {
    label: 'Summary deck',
    extension: 'pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    generate: generateSummaryPptx
  }
});

const PACKAGE_KIND = 'package';

function isDocumentKind(kind) {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_KINDS, kind);
}

/**
 * A safe, descriptive download filename.
 *
 * The client company and project names are slugified rather than interpolated: a name
 * containing a quote, a slash or a newline would otherwise end up in a
 * `Content-Disposition` header, where it is a header-injection vector and, more mundanely,
 * produces a file the recipient's operating system refuses to save.
 */
function filenameFor(quote, kind) {
  const spec = kind === PACKAGE_KIND ? { extension: 'zip' } : DOCUMENT_KINDS[kind];
  const base = [slugify(quote.client_company, 'client'), slugify(quote.project_name, 'project'), quote.reference].join('-');
  return `${base}-${kind}.${spec.extension}`;
}

/**
 * Generate one document.
 * @returns {Promise<{buffer: Buffer, filename: string, contentType: string}>}
 */
async function generateDocument(quote, kind, options = {}) {
  if (!isDocumentKind(kind)) {
    const err = new Error(`Unknown document kind: ${kind}`);
    err.code = 'UNKNOWN_DOCUMENT_KIND';
    throw err;
  }

  const spec = DOCUMENT_KINDS[kind];
  const buffer = await spec.generate(quote, options);

  return { buffer, filename: filenameFor(quote, kind), contentType: spec.contentType };
}

/**
 * Generate all three and zip them.
 *
 * Every document is generated and validated BEFORE the archive is finalised. A package
 * that is missing a file, or that contains a corrupt one, is worse than an error the
 * author can act on — so a failure here throws rather than shipping a partial zip.
 *
 * @returns {Promise<{buffer: Buffer, filename: string, contentType: string, contents: string[]}>}
 */
async function generatePackage(quote, options = {}) {
  const documents = [];
  for (const kind of Object.keys(DOCUMENT_KINDS)) {
    // Sequential on purpose: three OOXML builds in parallel spike memory on a small
    // instance for no wall-clock gain worth having.
    // eslint-disable-next-line no-await-in-loop
    documents.push(await generateDocument(quote, kind, options));
  }

  const buffer = await new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];

    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('warning', reject);
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));

    for (const document of documents) archive.append(document.buffer, { name: document.filename });

    archive.append(readmeFor(quote, documents), { name: 'README.txt' });
    archive.finalize().catch(reject);
  });

  return {
    buffer,
    filename: filenameFor(quote, PACKAGE_KIND),
    contentType: 'application/zip',
    contents: documents.map((d) => d.filename)
  };
}

/**
 * A plain-text note in the archive.
 *
 * Says what the figures are and what they are not. A budget that arrives with no statement
 * of its own basis gets read as a fixed price by whoever opens it third.
 */
function readmeFor(quote, documents) {
  const estimate = quote.estimate;
  return [
    `Statement of work package — ${quote.reference}`,
    `Project: ${quote.project_name}`,
    `Prepared for: ${quote.client_company}`,
    `Date: ${new Date(quote.created_at || Date.now()).toISOString().slice(0, 10)}`,
    '',
    'Contents:',
    ...documents.map((d) => `  - ${d.filename}`),
    '',
    'Headline figures:',
    `  Total effort:  ${estimate.totalManDays} man-days`,
    `  Duration:      ${estimate.projectDurationWeeks} weeks`,
    `  Total:         ${Math.round(estimate.totalBudget)} ${estimate.currency}`,
    '',
    'All three documents render the same stored estimate. None of them recalculates',
    'anything, so the figures in the document, the workbook and the deck agree exactly.',
    '',
    `These are estimates based on the scope stated in the document, not a fixed price. A`,
    `contingency of ${estimate.contingencyPercentage}% is included and is intended to absorb normal discovery`,
    'findings, not additions to scope. Figures exclude VAT, travel and expenses, and',
    'exclude Salesforce licence and AppExchange subscription costs.',
    ''
  ].join('\n');
}

module.exports = { DOCUMENT_KINDS, PACKAGE_KIND, isDocumentKind, filenameFor, generateDocument, generatePackage };
