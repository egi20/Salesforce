'use strict';

const sanitizeHtml = require('sanitize-html');

/**
 * Rich text authored by users. Allows a deliberately small tag set; everything else,
 * including every attribute not listed, is stripped rather than escaped.
 */
const RICH_TEXT_OPTIONS = {
  allowedTags: [
    'p',
    'br',
    'strong',
    'em',
    'u',
    's',
    'ul',
    'ol',
    'li',
    'blockquote',
    'h3',
    'h4',
    'a',
    'code',
    'pre'
  ],
  allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    // Any surviving link leaves the site with no referrer and no window.opener handle.
    a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow noopener noreferrer', target: '_blank' })
  }
};

/*
 * Whether the text already carries structure of its own.
 *
 * `br` counts: a value that already has line breaks has been through this once.
 */
const BLOCK_TAG = /<(p|ul|ol|h3|h4|blockquote|pre|br)\b/i;

/** Blank line starts a paragraph, single newline is a break. */
function asParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/*
 * Sanitise first, then give plain text its paragraphs.
 *
 * Every rich-text field in this application is edited in a BARE TEXTAREA — the job
 * description, a consultant's bio, a company's About. There is no editor emitting markup,
 * so what a person types is plain text with blank lines in it, and HTML collapses every
 * one of them: three paragraphs rendered as a single run-on block and nobody could see
 * why, because the stored value looked exactly as it had been typed.
 *
 * The conversion runs HERE, on the stored value at render time, for the same reason
 * `utils/videoEmbed.js` converts at render: today's rules then apply to every row,
 * including the ones written before this existed. It is idempotent — the output carries
 * `<p>`, so a second pass leaves it alone — and it never runs on text that already has
 * structure, so markup a person did type is untouched.
 *
 * Sanitising FIRST is not an ordering preference. Wrapping before sanitising would build
 * paragraphs around input nothing had inspected yet.
 */
function sanitizeRichText(html) {
  if (!html) return '';
  const clean = sanitizeHtml(String(html), RICH_TEXT_OPTIONS);
  if (BLOCK_TAG.test(clean)) return clean;
  return asParagraphs(clean);
}

/** Strip all markup, e.g. for meta descriptions and list previews. */
function toPlainText(html, maxLength = 0) {
  if (!html) return '';
  const text = sanitizeHtml(String(html), { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim();
  if (maxLength > 0 && text.length > maxLength) {
    return `${text.slice(0, maxLength - 1).trimEnd()}…`;
  }
  return text;
}

/**
 * Serialise a value for embedding inside a <script> block.
 *
 * `</script>` inside a string would close the block early, and U+2028/U+2029 are
 * literal line terminators in JavaScript source even though they are legal, unescaped,
 * inside a JSON string.
 */
function jsonForScript(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

module.exports = { sanitizeRichText, toPlainText, jsonForScript };
