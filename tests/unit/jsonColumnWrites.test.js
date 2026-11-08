'use strict';

/**
 * A JSON column is written with a plain JSON string, never `CAST(? AS JSON)`.
 *
 * MySQL 8 stores a JSON string in a JSON column as is. MariaDB keeps JSON as LONGTEXT with a
 * json_valid check and rejects `CAST(... AS JSON)` with ER_PARSE_ERROR, so the cast turned
 * saving a recruiter profile and submitting a daily challenge into a 500 there — and the seed
 * grew a wrapper that skipped both sections rather than reveal it. The suite mocks the
 * database, so nothing else here would catch the cast coming back.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIRS = ['models', 'services', 'routes', 'scripts', 'utils'];

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('JSON column writes', () => {
  const files = DIRS.flatMap((dir) => jsFilesUnder(path.join(ROOT, dir)));

  it('scans the models directory (an empty scan passes every "nothing here" check)', () => {
    const models = files.filter((f) => f.startsWith(path.join(ROOT, 'models') + path.sep));
    expect(models.length).toBeGreaterThan(10);
    expect(models.map((f) => path.basename(f))).toEqual(expect.arrayContaining(['RecruiterProfile.js', 'Challenge.js']));
  });

  it('no query casts a parameter to JSON', () => {
    const offenders = files
      .filter((file) => /CAST\s*\(\s*\?\s+AS\s+JSON\s*\)/i.test(stripComments(fs.readFileSync(file, 'utf8'))))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('the seed no longer skips sections for MariaDB', () => {
    const seed = stripComments(fs.readFileSync(path.join(ROOT, 'scripts', 'seed-data.js'), 'utf8'));
    expect(seed).not.toMatch(/mysql8Only/);
  });
});
