#!/usr/bin/env node
'use strict';

/**
 * Pre-flight checks that do not need a database.
 *
 * Runs the config loader (which throws on a missing production SESSION_SECRET), the
 * taxonomy integrity assertion, and a require() of every route, model and middleware
 * module so a syntax error or a bad import is caught before the process tries to serve
 * traffic.
 */
const fs = require('fs');
const path = require('path');

const problems = [];

function check(label, fn) {
  try {
    fn();
    console.log(`  ok    ${label}`);
  } catch (err) {
    problems.push(`${label}: ${err.message}`);
    console.log(`  FAIL  ${label} — ${err.message}`);
  }
}

console.log('Boot validation');

check('config loads', () => require('../config/config'));
check('role taxonomy is consistent', () => require('../config/roleTaxonomy').assertTaxonomyIntegrity());
check('cloud families load', () => require('../config/cloudFamilies'));
check('tax advisory options are consistent', () => require('../config/taxAdvisory').assertAdvisoryIntegrity());
check('challenge question bank is consistent', () => require('../config/challenges').assertChallengeIntegrity());
check('CRM pipeline is consistent', () => require('../config/crm').assertCrmIntegrity());
check('country list is non-empty', () => {
  const countries = require('../config/all-countries.json');
  if (!Array.isArray(countries) || countries.length < 100) throw new Error(`only ${countries.length} countries`);
});

for (const dir of ['models', 'middleware', 'utils', 'routes']) {
  const full = path.join(__dirname, '..', dir);
  for (const file of fs.readdirSync(full).filter((f) => f.endsWith('.js'))) {
    check(`${dir}/${file} loads`, () => require(path.join(full, file)));
  }
}

check('every view template compiles', () => {
  const ejs = require('ejs');
  const viewsDir = path.join(__dirname, '..', 'views');
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const p = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(p) : p.endsWith('.ejs') ? [p] : [];
    });

  const failures = [];
  for (const file of walk(viewsDir)) {
    try {
      ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file });
    } catch (err) {
      failures.push(`${path.relative(viewsDir, file)}: ${err.message.split('\n')[0]}`);
    }
  }
  if (failures.length) throw new Error(`\n      ${failures.join('\n      ')}`);
});

if (problems.length) {
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log('\nAll boot checks passed.');
