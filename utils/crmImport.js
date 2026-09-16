'use strict';

const { LIMITS, SOURCE_VALUES, sourceNeedsDetail } = require('../config/crm');

/**
 * CSV import for leads, as a PREVIEW first and a write second.
 *
 * CSV ONLY, and that is a decision rather than a limitation. The reference implementation
 * accepts .xlsx and sniffs every sheet in the workbook by its headers, trying to guess
 * which tabs are leads, which are templates, and which to ignore — roughly three hundred
 * lines whose own comments describe the failure it was written to fix ("357 partner rows
 * in one export, 1306 people in another" silently skipped). Guessing at the shape of a
 * file full of other people's contact details is the wrong place to be clever. One format,
 * named columns, and a preview the person confirms.
 *
 * The parser is deliberately small and hand-written: `csv-parse` would be another
 * dependency for a file this application reads on one admin screen. It handles quoted
 * fields, embedded commas, embedded newlines and doubled quotes, which is the whole of RFC
 * 4180 that matters here.
 */

/** Column aliases, so an export does not have to be renamed by hand first. */
const COLUMNS = Object.freeze({
  company: ['company', 'company name', 'organisation', 'organization', 'account'],
  contact_name: ['contact', 'contact name', 'name', 'full name'],
  contact_email: ['email', 'contact email', 'e-mail', 'email address'],
  contact_phone: ['phone', 'telephone', 'contact phone', 'mobile'],
  job_title: ['title', 'job title', 'role', 'position'],
  country: ['country', 'country code'],
  website: ['website', 'web', 'url', 'site'],
  linkedin_url: ['linkedin', 'linkedin url', 'linkedin profile']
});

/**
 * Split CSV text into rows of cells.
 *
 * Returns rows as arrays; the caller maps headers. A trailing newline does not produce an
 * empty final row, and a lone `\r` inside a quoted field survives.
 */
function parseCsv(input) {
  // Written as an escape rather than a literal BOM: an invisible character in source is
  // one nobody can see when it goes wrong, and eslint refuses it for that reason.
  const text = String(input ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      // Treat \r\n as one break.
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }

  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }

  // Drop rows that are entirely empty — a trailing newline, or a blank line in the middle.
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function headerIndex(headerRow) {
  const normalised = headerRow.map((h) => String(h ?? '').trim().toLowerCase());
  const index = {};
  for (const [field, aliases] of Object.entries(COLUMNS)) {
    const position = normalised.findIndex((h) => aliases.includes(h));
    if (position !== -1) index[field] = position;
  }
  return index;
}

/**
 * Read a CSV into candidate leads, WITHOUT writing anything.
 *
 * The source is supplied once, by the person doing the import, and stamped on every row —
 * it is not read from the file. A source column in a spreadsheet is a source nobody
 * checked; a source chosen on the import screen is somebody answering the question.
 *
 * Every row comes back with its own `problems`, so the preview can show exactly which
 * lines will be skipped and why, rather than reporting "412 imported, 88 failed".
 */
function readLeads(csvText, { source, sourceDetail = '' } = {}) {
  if (!SOURCE_VALUES.includes(source)) {
    const err = new Error('Choose where this file came from before importing it.');
    err.code = 'SOURCE_REQUIRED';
    throw err;
  }
  if (sourceNeedsDetail(source) && String(sourceDetail).trim().length < 3) {
    const err = new Error('Say specifically where the file came from.');
    err.code = 'SOURCE_DETAIL_REQUIRED';
    throw err;
  }

  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    const err = new Error('That file has no rows under its header.');
    err.code = 'EMPTY_FILE';
    throw err;
  }

  const index = headerIndex(rows[0]);
  if (index.company === undefined && index.contact_email === undefined) {
    const err = new Error(
      `No column that looks like a company or an email. Found: ${rows[0].map((h) => `"${String(h).trim()}"`).join(', ')}.`
    );
    err.code = 'NO_USABLE_COLUMNS';
    throw err;
  }

  const truncated = rows.length - 1 > LIMITS.importRows;
  const body = rows.slice(1, 1 + LIMITS.importRows);

  const candidates = body.map((cells, position) => {
    const pick = (field) => (index[field] === undefined ? '' : String(cells[index[field]] ?? '').trim());

    const lead = {
      company: pick('company'),
      contact_name: pick('contact_name'),
      contact_email: pick('contact_email').toLowerCase(),
      contact_phone: pick('contact_phone'),
      job_title: pick('job_title'),
      country: pick('country'),
      website: pick('website'),
      linkedin_url: pick('linkedin_url'),
      source,
      source_detail: String(sourceDetail).trim()
    };

    const problems = [];
    if (!lead.company) problems.push('no company name');
    if (lead.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(lead.contact_email)) {
      problems.push('the email is not an address');
    }

    // Line 1 is the header, so a spreadsheet row number is position + 2.
    return { line: position + 2, lead, problems };
  });

  // Within-file duplicates, flagged here rather than silently collapsed by the unique key
  // on the way in: two rows with one address usually means the file was concatenated, and
  // that is worth seeing before it is written.
  const seen = new Map();
  for (const candidate of candidates) {
    const email = candidate.lead.contact_email;
    if (!email) continue;
    if (seen.has(email)) {
      candidate.problems.push(`duplicate of line ${seen.get(email)} in this file`);
    } else {
      seen.set(email, candidate.line);
    }
  }

  return {
    columns: Object.keys(index),
    missingColumns: Object.keys(COLUMNS).filter((c) => index[c] === undefined),
    candidates,
    truncated,
    totalInFile: rows.length - 1
  };
}

module.exports = { parseCsv, readLeads, COLUMNS };
