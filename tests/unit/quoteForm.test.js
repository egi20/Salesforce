'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the running total on /quotes/new is the engine, not a copy of it', () => {
  const route = read('routes/quotes.js');
  const client = stripComments(read('public/js/quote-form.js'));

  test('the preview reads the form and runs the estimator exactly as the save does', () => {
    const preview = route.slice(route.indexOf("'/preview'"), route.indexOf("router.get(\n  '/',"));
    expect(preview).toContain('inputsFrom(req.body)');
    expect(preview).toContain('calculateEstimation(inputs, optionsFrom(req.body))');
    expect(preview).toContain('reconciliationProblems(estimate)');
    // The save uses the same two helpers, so the figure on screen is the figure stored.
    const save = route.slice(route.indexOf("router.post(\n  '/',"));
    expect(save).toContain('inputsFrom(req.body)');
    expect(save).toContain('calculateEstimation(inputs, optionsFrom(req.body))');
  });

  test('the preview stores nothing and is rate limited', () => {
    const preview = route.slice(route.indexOf("'/preview'"), route.indexOf("router.get(\n  '/',"));
    expect(preview).not.toMatch(/Quote\.create|INSERT|UPDATE/);
    expect(preview).toMatch(/isEmailVerified,\s*previewLimiter/);
  });

  test('the browser computes no figure of its own', () => {
    expect(client).toContain("'/quotes/preview'");
    // No catalogue numbers and no effort arithmetic: every figure comes back from the server.
    expect(client).not.toMatch(/multiplier|baseEffortDays|foundationEffortDays|dailyRate|\* ?[01]\.\d/i);
    expect(client).not.toMatch(/innerHTML/);
  });

  test('a stale answer never overwrites a newer one', () => {
    expect(client).toMatch(/if \(seq !== inFlight\) return;/);
  });
});

describe('the form works with scripting off', () => {
  const view = read('views/quotes/new.ejs');

  test('the step bar and step buttons are hidden until the script draws them', () => {
    expect(view).toMatch(/data-quote-steps hidden/);
    expect((view.match(/data-step-nav hidden/g) || []).length).toBe(3);
    // Every step is in the one form, so a plain submit posts all of it.
    expect((view.match(/data-step="\d"/g) || []).length).toBe(4);
    expect(view.indexOf('data-step="4"')).toBeLessThan(view.indexOf('</form>'));
  });

  test('a re-shown form ticks what was posted, whether one value or many', () => {
    // A single ticked box arrives as a string, and 'sales-cloud'.includes('sales') is true.
    expect(view).toContain('const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);');
    expect(view).not.toMatch(/\(values\.(families|modules|isvs) \|\| \[\]\)\.includes/);
  });

  test('options read as words: "Simple ×0.8", each with its own one-line description', () => {
    expect(view).toContain('<%= cap(c.id) %>');
    expect(view).not.toMatch(/<%= c\.id %> \(&times;/);
    expect(view).toContain('choice-card-desc');
  });

  test('a refused save opens on the step that holds the problem', () => {
    expect(view).toContain('data-start-step="<%= errorStep %>"');
    expect(read('routes/quotes.js')).toMatch(/errors\.some\(\(e\) => CLIENT_FIELDS\.includes\(e\.path\)\) \? 1 : 2/);
  });
});

describe("the SOW page lists only what the SOW contains", () => {
  const index = read('routes/index.js');
  const sow = read('utils/documents/sowDocx.js');
  const block = index.slice(index.indexOf('const SOW_CONTENTS'), index.indexOf('const SERVICE_PAGES'));
  const headings = [...block.matchAll(/heading: ('[^']*'|"[^"]*")/g)].map((m) => m[1].slice(1, -1));

  test('the list is not empty', () => {
    expect(headings.length).toBeGreaterThanOrEqual(12);
  });

  test.each(headings.map((h) => [h]))('"%s" is a heading the generator writes', (heading) => {
    expect(sow).toContain(heading);
  });

  test('nothing is listed that the document does not have', () => {
    expect(block).not.toMatch(/Acceptance criteria|Work breakdown structure|Change control/i);
  });

  test('the page offers Your quotes to a signed-in visitor', () => {
    expect(read('views/services/document-generator.ejs')).toMatch(/href="\/quotes"><i class="bi bi-clock-history"><\/i> Your quotes/);
  });
});
