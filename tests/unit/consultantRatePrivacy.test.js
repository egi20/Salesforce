'use strict';

const fs = require('fs');
const path = require('path');

const ConsultantProfile = require('../../models/ConsultantProfile');

const ROOT = path.join(__dirname, '..', '..');

/*
 * WHY THIS FILE EXISTS.
 *
 * A public profile is how a consultant gets found; their day rate is the number they
 * negotiate with. Until migration 029 those were one decision, while the employer side had
 * been able to advertise a role without its budget since the beginning.
 *
 * The part worth testing is not that the figure is missing from the markup. It is that
 * hiding it in the markup ALONE would have been a lie: a figure that still answers the
 * rate filter can be read one query at a time, and a figure that still orders a sorted
 * list can be read from a position.
 */
describe('a hidden day rate is an unknown rate, not a withheld one', () => {
  test('the rate filter cannot be used to narrow it down', () => {
    const { clause } = ConsultantProfile.buildFilter({ rate_max: 700 });
    // Hidden profiles satisfy the clause whatever the maximum, exactly as profiles with no
    // rate at all already did — so dropping out of the list reveals nothing.
    expect(clause).toContain('cp.rate_visible = 0 OR cp.day_rate IS NULL OR cp.day_rate <= ?');
  });

  test('ordering by rate does not order by a rate nobody may see', () => {
    // Position in a sorted list is a measurement. A hidden rate sorts with the ones that
    // do not exist.
    const source = fs.readFileSync(path.join(ROOT, 'models', 'ConsultantProfile.js'), 'utf8');
    expect(source).toContain("CASE WHEN cp.rate_visible = 1 THEN cp.${column} ELSE NULL END");
    expect(source).toContain('const RATE_OR_NULL = hiddenUnlessVisible(\'day_rate\')');
    expect(source).not.toContain("rate_asc: 'cp.day_rate IS NULL, cp.day_rate ASC'");
    expect(source).not.toContain("rate_desc: 'cp.day_rate DESC'");
  });

  test('the list query nulls the figure rather than trusting each template', () => {
    // Three call sites read this list — the directory, the home page and
    // services/search.js. The one that forgets the check is the one that leaks.
    const source = fs.readFileSync(path.join(ROOT, 'models', 'ConsultantProfile.js'), 'utf8');
    const browse = source.slice(source.indexOf('static async browse'));
    expect(browse).toMatch(/\$\{RATE_OR_NULL\} AS day_rate/);
    expect(browse).not.toMatch(/cp\.day_rate,/);
  });

  test('the owner can still change it, and a stranger cannot', () => {
    const model = fs.readFileSync(path.join(ROOT, 'models', 'ConsultantProfile.js'), 'utf8');
    const route = fs.readFileSync(path.join(ROOT, 'routes', 'profile.js'), 'utf8');
    // In the allowed-field list, so `update` will write it...
    expect(model).toMatch(/'rate_visible'/);
    // ...and read as a NAMED field from the body, like every other checkbox here. An
    // unticked box posts nothing, so absence has to mean "hide", not "publish".
    expect(route).toMatch(/rate_visible: req\.body\.rate_visible === 'on' \? 1 : 0/);
  });

  test('the public page says "Rate on request", not "hidden"', () => {
    // Saying it is hidden tells the reader there is a figure and that they are not allowed
    // to see it, which is more than the consultant chose to publish.
    const view = fs.readFileSync(path.join(ROOT, 'views', 'consultants', 'show.ejs'), 'utf8');
    expect(view).toContain('Rate on request');
    // Every figure is gated on the one flag: `showRate` decides the whole list.
    expect(view).toContain('const figures = showRate');
    /*
     * Scoped to the rate block, with comments stripped. A bare `not.toContain('hidden')`
     * over the whole file matches `<input type="hidden">` and the banner telling an owner
     * their profile is hidden from the directory — neither of which is this.
     */
    const block = view
      .slice(view.indexOf('const figures = showRate'), view.indexOf('Availability and rate') + 2000)
      .replace(/<%#[\s\S]*?%>/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(block).not.toMatch(/hidden/i);
  });

  test('the owner and an admin still see their own figure', () => {
    const route = fs.readFileSync(path.join(ROOT, 'routes', 'consultants.js'), 'utf8');
    expect(route).toMatch(/const showRate = Boolean\(profile\.rate_visible\) \|\| isSelf \|\| \(viewer && viewer\.isAdmin\)/);
  });

  test('ONE switch covers every figure, not just the day rate', () => {
    /*
     * Migration 030 added an hourly rate and an expected salary. Publishing the hourly one
     * while the day rate was hidden would defeat the whole thing: multiply it by a working
     * day and you are within a few per cent of the number somebody chose to keep back.
     */
    const source = fs.readFileSync(path.join(ROOT, 'models', 'ConsultantProfile.js'), 'utf8');
    const browse = source.slice(source.indexOf('static async browse'));
    for (const column of ['hourly_rate', 'annual_salary']) {
      expect(browse).toContain(`hiddenUnlessVisible('${column}')} AS ${column}`);
      // Never selected raw, which would hand the figure to a template to forget about.
      expect(browse).not.toContain(`cp.${column},`);
    }
  });

  test('nothing is derived from anything else', () => {
    /*
     * An hourly rate is not a day rate over eight: the divisor is a contract term, 7 or 7.5
     * or 8, and choosing one would put a figure on somebody's profile that they never
     * agreed to. A salary is a different engagement, not a converted rate. The same refusal
     * `utils/contractorEconomics.js` makes about tax.
     */
    const sources = ['models/ConsultantProfile.js', 'routes/profile.js', 'services/consultantDossier.js']
      .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // No arithmetic between the three columns anywhere in the write or read paths.
    expect(sources).not.toMatch(/day_rate\s*[*/]\s*\d/);
    expect(sources).not.toMatch(/hourly_rate\s*[*/]/);
    expect(sources).not.toMatch(/annual_salary\s*[*/]/);
  });

  test('it changes nothing about the rate index', () => {
    // The index is built from `rate_submissions`, which is a different thing a consultant
    // contributed deliberately and anonymously. A profile hiding its rate must not make a
    // published percentile move, and the aggregation has never read this table.
    const agg = fs.readFileSync(path.join(ROOT, 'utils', 'rateAggregation.js'), 'utf8');
    expect(agg).not.toMatch(/consultant_profiles|rate_visible/);
  });
});
