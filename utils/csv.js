'use strict';

/**
 * CSV for the exports an administrator downloads — the CRM's leads and the error log.
 *
 * ONE copy, because there were about to be two. The CRM export carried this rule inline and
 * the error-log export would have needed it again; `utils/decimalInput.js` exists because a
 * second copy of a rule "the same as the other one" had already drifted on the cases that
 * mattered.
 *
 * The rule: a cell starting with =, +, - or @ (or a tab or carriage return) is executed as a
 * formula when the file is opened in a spreadsheet, so it is prefixed with a quote. That is
 * a real injection path out of a CSV export, and in the error log it is reachable by anybody
 * who can make a request: the path and the message are text a stranger chose. Every cell is
 * quoted and every quote doubled, because a message containing a comma is the ordinary case.
 */
function csvCell(value) {
  let raw;
  if (value === null || value === undefined) raw = '';
  // mysql2 returns DATETIME as a Date, and String(date) is "Thu Oct 29 …" in local time.
  else if (value instanceof Date) raw = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  else raw = String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Rows into a CSV document with the given header order. CRLF, as RFC 4180 says. */
function toCsv(headers, rows) {
  return [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\r\n');
}

module.exports = { csvCell, toCsv };
