'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'views');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.ejs') ? [full] : [];
  });
}

/*
 * WHY THIS FILE EXISTS.
 *
 * `<input type="number" step="10">` is INVALID for any value that is not a multiple of ten,
 * and an invalid field makes the browser refuse to submit the WHOLE form, silently, with a
 * tooltip on a field nobody touched.
 *
 * A consultant whose stored day rate was 752 could not save their profile at all — not the
 * rate, not the bio, not the availability. The same attribute was on both job rate fields
 * and on the rate submission, so an employer could not edit a role priced at 833 either.
 * Nothing in the suite could see it: the value is valid, the server accepts it, and the
 * markup looks deliberate. Driving the form in a real browser is what found it.
 *
 * The rule: a field holding a FIGURE SOMEBODY CHOOSES may not carry a step that rules out
 * ordinary values. `step` is a convenience for the spinner arrows; it is also a validity
 * constraint, and the second one is the part that bites.
 */
describe('number inputs do not refuse ordinary values', () => {
  const money = /(rate|amount|salary|price|value|fee|cost|budget)/i;

  test('no figure field carries a step that invalidates a plain number', () => {
    const offenders = [];
    for (const file of walk(VIEWS)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const m of source.matchAll(/<input[^>]*type="number"[^>]*>/g)) {
        const tag = m[0];
        const name = (tag.match(/name="([^"]+)"/) || [])[1] || '';
        const step = (tag.match(/step="([^"]+)"/) || [])[1];
        if (!step || step === '1' || step === 'any') continue;
        if (money.test(name)) offenders.push(`${path.relative(ROOT, file)}: ${name} step="${step}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the fields that actually broke are pinned by name', () => {
    // Named rather than left to the pattern above, because these are the four that cost
    // somebody a form they could not submit.
    const checks = [
      ['views/profile/consultant.ejs', 'day_rate'],
      ['views/jobs/form.ejs', 'rate_min'],
      ['views/jobs/form.ejs', 'rate_max'],
      ['views/rates/submit.ejs', 'amount']
    ];
    for (const [file, name] of checks) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const tag = source.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`));
      expect(tag).not.toBeNull();
      expect(tag[0]).not.toMatch(/step="(?!1"|any")/);
    }
  });
});
