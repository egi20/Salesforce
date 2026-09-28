'use strict';

const sax = require('sax');
const PizZip = require('pizzip');

/**
 * Plain text out of an uploaded CV, for "Import from CV" to hand to the model.
 *
 * .docx only, of the two accepted upload types that need real parsing — .txt is already
 * plain text. A SAX walk of word/document.xml, not a regex strip: this is untrusted input
 * from a stranger's upload, and the rest of this codebase already reaches for `sax` in
 * strict mode (utils/documents/validate.js) rather than pattern-matching XML by hand.
 */
function textFromDocx(buffer) {
  const zip = new PizZip(buffer);
  const part = zip.file('word/document.xml');
  if (!part) throw new Error('That does not look like a .docx file.');
  const xml = part.asText();

  const paragraphs = [];
  let current = '';
  const parser = sax.parser(true, {});

  parser.ontext = (text) => {
    current += text;
  };
  // Word represents a line break inside a paragraph as <w:br/>; a paragraph boundary is
  // the closing </w:p>. Both become a newline in the plain-text version.
  parser.onopentag = (node) => {
    if (node.name === 'w:br' || node.name === 'w:tab') current += ' ';
  };
  parser.onclosetag = (name) => {
    if (name === 'w:p') {
      paragraphs.push(current.trim());
      current = '';
    }
  };
  parser.onerror = function onerror() {
    // A CV that is not perfectly well-formed OOXML still has readable text in it — resume
    // rather than discarding the whole document over one malformed part.
    this.resume();
  };

  parser.write(xml).close();
  if (current.trim()) paragraphs.push(current.trim());

  return paragraphs.filter(Boolean).join('\n');
}

/** @param {Buffer} buffer @param {string} mimetype @returns {string} plain text */
function extractText(buffer, mimetype) {
  if (mimetype === 'text/plain') return buffer.toString('utf8');
  return textFromDocx(buffer);
}

module.exports = { extractText, textFromDocx };
