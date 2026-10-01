'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { seniorityLabel, SENIORITY_LEVELS } = require('../../config/roleTaxonomy');
const { rateUnit, hasDuration, workModeLabel, engagementLabel } = require('../../config/jobTaxonomy');
const { sanitizeRichText } = require('../../utils/sanitize');
const { VIEW_HELPERS } = require('../../utils/viewHelpers');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.ejs') ? [full] : [];
  });
}

const VIEWS = walk(path.join(ROOT, 'views'));

describe('catalogue labels', () => {
  test('every seniority has a short word for a badge and a banded label for a form', () => {
    for (const level of SENIORITY_LEVELS) {
      expect(level.short).toBeTruthy();
      expect(level.label).toContain(level.short);
      expect(seniorityLabel(level.value)).toBe(level.short);
      expect(seniorityLabel(level.value, { full: true })).toBe(level.label);
    }
  });

  test('no template prints a raw slug where a label exists', () => {
    // Cards were rendering "mid", "onsite", "permanent" — the values, because a route file
    // held the lists and a route file has no labels.
    const offenders = [];
    for (const file of VIEWS) {
      const source = fs.readFileSync(file, 'utf8');
      for (const m of source.matchAll(/<%=\s*([A-Za-z_$][\w$.]*)\.(seniority|work_mode|engagement_type)\s*%>/g)) {
        offenders.push(`${path.relative(ROOT, file)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the rate unit belongs to the engagement', () => {
  test('a contract figure is per day and a permanent one is per year', () => {
    expect(rateUnit('contract')).toBe('/day');
    expect(rateUnit('permanent')).toBe('/yr');
  });

  test('an unrecognised engagement gets NO unit rather than a guess', () => {
    // A number with the wrong unit is a lie, and this one is about money. The seed
    // published a day rate as "468 EUR/yr" because a view chose the unit with
    // `engagement_type === 'contract' ? '/day' : '/yr'` — an else branch that answers for
    // everything it has never heard of.
    expect(rateUnit('bogus')).toBe('');
    expect(rateUnit(undefined)).toBe('');
  });

  test('no template still picks the unit with an inline ternary', () => {
    for (const file of VIEWS) {
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/'\/day'\s*:\s*'\/yr'/);
    }
  });

  test('only a contract carries a duration', () => {
    expect(hasDuration('contract')).toBe(true);
    expect(hasDuration('permanent')).toBe(false);
    expect(hasDuration('bogus')).toBe(false);
  });

  test('the write path clears a duration that cannot mean anything', () => {
    // A row saying "Permanent" and "3 months" leaves every reader to pick a half.
    const source = fs.readFileSync(path.join(ROOT, 'routes', 'jobs.js'), 'utf8');
    expect(source).toMatch(/duration_months:\s*hasDuration\(body_\.engagement_type\)/);
  });

  test('an unknown slug falls back to itself, never to another catalogue entry', () => {
    expect(workModeLabel('teleport')).toBe('teleport');
    expect(engagementLabel('barter')).toBe('barter');
  });
});

describe('plain text typed into a textarea keeps its paragraphs', () => {
  test('blank lines become paragraphs and single newlines become breaks', () => {
    // Every rich-text field here is edited in a bare textarea, so what arrives is plain
    // text — and HTML collapses every newline in it. Three paragraphs rendered as one.
    expect(sanitizeRichText('One.\n\nTwo.\nThree.')).toBe('<p>One.</p><p>Two.<br>Three.</p>');
  });

  test('text that already has structure is left alone', () => {
    const already = '<p>Written</p><p>as markup</p>';
    expect(sanitizeRichText(already)).toBe(already);
  });

  test('it is idempotent, because it runs at render on every read', () => {
    const once = sanitizeRichText('One.\n\nTwo.');
    expect(sanitizeRichText(once)).toBe(once);
  });

  test('it sanitises BEFORE it wraps', () => {
    // Wrapping first would build paragraphs around input nothing had inspected.
    const out = sanitizeRichText('<script>alert(1)</script>Hello');
    expect(out).toBe('<p>Hello</p>');
    expect(out).not.toContain('script');
  });
});

describe('view helpers', () => {
  test('are one frozen list, so adding one cannot miss a caller', () => {
    expect(Object.isFrozen(VIEW_HELPERS)).toBe(true);
    for (const name of ['roleLabel', 'seniorityLabel', 'workModeLabel', 'engagementLabel', 'rateUnit']) {
      expect(typeof VIEW_HELPERS[name]).toBe('function');
    }
  });

  test('server.js attaches them from that list rather than one line at a time', () => {
    const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    expect(source).toMatch(/attachViewHelpers\(res\)/);
    expect(source).not.toMatch(/res\.locals\.roleLabel\s*=/);
  });
});
