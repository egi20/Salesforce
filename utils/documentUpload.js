'use strict';

const PizZip = require('pizzip');

/**
 * Whether an uploaded CV or cover letter may be stored, and as what.
 *
 * WHY THIS IS STRICT. Everywhere else in this codebase a document a person downloads is one
 * the Hub generated and opened first (CLAUDE.md, "Open it before anyone else has to"). An
 * uploaded CV is the one exception, and it is only acceptable because of what is refused
 * here, before a byte is stored:
 *
 *   - Only PDF and .docx. A legacy .doc is a binary OLE file whose macros cannot be told
 *     apart from its text without a full parser; it is refused with a way forward.
 *   - .docx: must actually be a Word package; refused if it carries macros (vbaProject, any
 *     macro-enabled content type), embedded OLE objects, or a relationship that loads
 *     something from OUTSIDE the file — a remote template is the classic way a .docx fetches
 *     its payload on open. Ordinary hyperlinks are external relationships too, and allowed.
 *   - PDF: must start as a PDF; refused if it names JavaScript, a launch action, embedded
 *     files, rich media or XFA forms.
 *
 * The extension, the declared type and the bytes must all agree. None of the three alone is
 * evidence: the browser chooses the first two.
 *
 * What this cannot promise: a PDF can hide a keyword inside a compressed object stream. The
 * file is therefore only ever served back as an attachment, never inline, with nosniff.
 */

const MAX_BYTES = 5 * 1024 * 1024;

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_TYPE = 'application/pdf';

const PDF_FORBIDDEN = [/\/JavaScript\b/, /\/JS\s*[(<[/]/, /\/Launch\b/, /\/EmbeddedFile\b/, /\/RichMedia\b/, /\/XFA\b/];

/* External relationships a CV has no business making. A hyperlink is not on this list. */
const FORBIDDEN_EXTERNAL = /\/(attachedTemplate|oleObject|frame|subDocument|externalLinkPath|package)$/;

function checkPdf(buffer) {
  if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') return 'That file is not a PDF.';
  const text = buffer.toString('latin1');
  if (PDF_FORBIDDEN.some((re) => re.test(text))) {
    return 'That PDF contains scripts, launch actions or embedded files. Export it again as a plain PDF.';
  }
  return null;
}

function checkDocx(buffer) {
  let zip;
  try {
    zip = new PizZip(buffer);
  } catch {
    return 'That file is not a Word (.docx) document.';
  }
  const names = Object.keys(zip.files);
  if (!names.includes('[Content_Types].xml') || !names.includes('word/document.xml')) {
    return 'That file is not a Word (.docx) document.';
  }
  const contentTypes = zip.file('[Content_Types].xml').asText();
  if (/macroEnabled|vbaProject/i.test(contentTypes) || names.some((n) => /vbaProject|vbaData/i.test(n))) {
    return 'That document contains macros. Save it as a regular .docx or as PDF.';
  }
  if (names.some((n) => /^word\/embeddings\//.test(n) || /oleObject/i.test(n))) {
    return 'That document contains embedded objects. Save it as a regular .docx or as PDF.';
  }
  for (const name of names.filter((n) => n.endsWith('.rels'))) {
    const rels = zip.file(name).asText();
    const external = rels.match(/<Relationship\b[^>]*TargetMode="External"[^>]*>/g) || [];
    for (const rel of external) {
      const type = (rel.match(/Type="([^"]+)"/) || [])[1] || '';
      if (FORBIDDEN_EXTERNAL.test(type)) {
        return 'That document loads a template or object from outside the file. Save it as a regular .docx or as PDF.';
      }
    }
  }
  return null;
}

/**
 * @returns {{ok:true, contentType:string} | {ok:false, reason:string}}
 */
function validateDocument({ buffer, originalname = '', mimetype = '' }) {
  if (!buffer || buffer.length === 0) return { ok: false, reason: 'Please choose a file.' };
  if (buffer.length > MAX_BYTES) return { ok: false, reason: `That file is too large. The limit is ${MAX_BYTES / 1024 / 1024} MB.` };

  const name = String(originalname).toLowerCase();
  if (/\.doc$/.test(name) || mimetype === 'application/msword') {
    return { ok: false, reason: 'Older .doc files are not accepted. Save it as .docx or PDF and upload that.' };
  }
  if (/\.pdf$/.test(name)) {
    if (mimetype && mimetype !== PDF_TYPE && mimetype !== 'application/octet-stream') return { ok: false, reason: 'That file is not a PDF.' };
    const problem = checkPdf(buffer);
    return problem ? { ok: false, reason: problem } : { ok: true, contentType: PDF_TYPE };
  }
  if (/\.docx$/.test(name)) {
    if (mimetype && mimetype !== DOCX_TYPE && mimetype !== 'application/octet-stream' && mimetype !== 'application/zip') {
      return { ok: false, reason: 'That file is not a Word (.docx) document.' };
    }
    const problem = checkDocx(buffer);
    return problem ? { ok: false, reason: problem } : { ok: true, contentType: DOCX_TYPE };
  }
  return { ok: false, reason: 'Only PDF and Word (.docx) files are accepted.' };
}

/** A download filename that is safe in a Content-Disposition header. */
function safeFilename(name, contentType) {
  const ext = contentType === PDF_TYPE ? '.pdf' : '.docx';
  const base = String(name || 'document').replace(/\.(pdf|docx)$/i, '').normalize('NFKD')
    .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'document';
  return base + ext;
}

module.exports = { validateDocument, safeFilename, MAX_BYTES, PDF_TYPE, DOCX_TYPE };
