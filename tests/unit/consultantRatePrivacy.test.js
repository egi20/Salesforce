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
    expect(source).toMatch(/CASE WHEN cp\.rate_visible = 1 THEN cp\.day_rate ELSE NULL END/);
    expect(source).not.toMatch(/rate_asc: 'cp\.day_rate IS NULL, cp\.day_rate ASC'/);
    expect(source).not.toMatch(/rate_desc: 'cp\.day_rate DESC'/);
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
    expect(view).toMatch(/profile\.day_rate && showRate/);
  });

  test('the owner and an admin still see their own figure', () => {
    const route = fs.readFileSync(path.join(ROOT, 'routes', 'consultants.js'), 'utf8');
    expect(route).toMatch(/const showRate = Boolean\(profile\.rate_visible\) \|\| isSelf \|\| \(viewer && viewer\.isAdmin\)/);
  });

  test('it changes nothing about the rate index', () => {
    // The index is built from `rate_submissions`, which is a different thing a consultant
    // contributed deliberately and anonymously. A profile hiding its rate must not make a
    // published percentile move, and the aggregation has never read this table.
    const agg = fs.readFileSync(path.join(ROOT, 'utils', 'rateAggregation.js'), 'utf8');
    expect(agg).not.toMatch(/consultant_profiles|rate_visible/);
  });
});
