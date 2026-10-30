'use strict';

/**
 * How one row of /admin/users is printed (ported from SAP Hub). PURE, so the odd cases are
 * tested rather than discovered on the screen.
 *
 * `users.name` is ONE column. The table splits it at the first space because SAP Hub's
 * table has two, and that is all the split is: a display convenience over the single stored
 * value, never written back — "Maria de la Cruz" is printed as "Maria" and "de la Cruz",
 * which is wrong for some people and is why nothing reads these halves.
 */
function nameColumns(row) {
  if (row.user_type === 'company') {
    // The company's own name where it has given one; the account name otherwise.
    return { first: row.company_name || row.name || '—', last: '—' };
  }
  const parts = String(row.name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '—', last: '—' };
  return { first: parts[0], last: parts.slice(1).join(' ') || '—' };
}

/**
 * "DE" → the flag emoji, built from regional-indicator symbols. Anything that is not two
 * letters gives '' rather than a broken glyph, and the code is printed beside it anyway,
 * because a flag is a picture and some systems draw it as two letters in boxes.
 */
function flagEmoji(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/**
 * dd/mm/yyyy, read in UTC. Not the viewer's locale: two administrators comparing one row
 * over the phone must see the same date, and a timestamp stored at 23:30 UTC must not move
 * to the next day on one of their screens. '' for no date, so "never" is the caller's word.
 */
function shortDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** The full instant for a tooltip: "2026-10-30 14:05 UTC". */
function fullTimestamp(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

module.exports = { nameColumns, flagEmoji, shortDate, fullTimestamp };
