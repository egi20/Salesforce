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

describe('the SOW pages list only what the SOW contains', () => {
  const { SOW_SECTIONS } = require('../../config/sowPack');
  const sow = read('utils/documents/sowDocx.js');

  test('every line names the heading that produces it', () => {
    expect(SOW_SECTIONS.length).toBeGreaterThanOrEqual(12);
    for (const item of SOW_SECTIONS) expect(item.heading).toBeTruthy();
  });

  test.each(SOW_SECTIONS.map((i) => [i.label, i.heading]))('"%s" is written by the generator (%s)', (label, heading) => {
    expect(sow).toContain(heading);
  });

  test('acceptance criteria are listed because section 2.2 writes them', () => {
    expect(SOW_SECTIONS.map((i) => i.heading)).toContain('2.2 Acceptance criteria');
    expect(sow).toContain("heading('2.2 Acceptance criteria'");
  });

  test('a section that appears only sometimes says when', () => {
    for (const item of SOW_SECTIONS.filter((i) => i.optional)) expect(item.note).toBeTruthy();
  });

  test('the introduction lives on /quotes/new only; the pack page restates none of it', () => {
    const form = read('views/quotes/new.ejs');
    for (const part of ['sow/how', 'sow/clouds', 'sow/included']) expect(form).toContain(`include('../partials/${part}'`);
    const pack = read('views/services/document-generator.ejs');
    expect(pack).not.toMatch(/partials\/sow\//);
    expect(pack).not.toMatch(/How it works<\/h2>|Supported Salesforce clouds|What's included/);
    expect(read('routes/index.js')).not.toMatch(/SOW_INCLUDED|label: 'Cover page'|sowPageLocals/);
  });

  test('"Get SOW Quote" goes straight to the form; "SOW Generator" goes to the top of the page', () => {
    const nav = read('views/partials/navigation.ejs') + read('views/partials/footer.ejs') + read('routes/index.js');
    for (const line of nav.split('\n').filter((l) => /Get SOW Quote/.test(l) && /quotes\/new/.test(l))) {
      expect(line).toContain('/quotes/new#wizard');
    }
    for (const line of nav.split('\n').filter((l) => /SOW Generator/.test(l) && /quotes\/new/.test(l))) {
      expect(line).not.toContain('#wizard');
    }
  });

  test('Your quotes is in the SOW pack page hero; a visitor is sent through sign-in to it', () => {
    expect(read('views/services/document-generator.ejs')).toContain("currentUser ? '/quotes' : '/auth/login?redirect=%2Fquotes'");
  });

  test('the three cloud cards cover every cloud exactly once', () => {
    const { cloudGroupProblems, cloudGroups, CLOUD_FAMILIES } = require('../../config/cloudFamilies');
    expect(cloudGroupProblems()).toEqual([]);
    expect(cloudGroups().reduce((n, g) => n + g.families.length, 0)).toBe(CLOUD_FAMILIES.length);
  });
});

describe('section 2.2 of the SOW: acceptance criteria', () => {
  const PizZip = require('pizzip');
  const { calculateEstimation } = require('../../utils/sowEstimation');
  const { PHASE_DISTRIBUTION, PHASE_ACCEPTANCE, catalogueVersion } = require('../../config/estimation');
  const { generateSowDocx } = require('../../utils/documents/sowDocx');

  test('every phase has a criterion', () => {
    for (const id of Object.keys(PHASE_DISTRIBUTION)) expect(PHASE_ACCEPTANCE[id]).toBeTruthy();
  });

  test('the document carries one row per timeline phase, with its milestone', async () => {
    const estimate = calculateEstimation({ selectedFamilies: ['sales-cloud'], selectedModules: ['cpq'], includeTraining: true, includeSupport: true, supportDurationDays: 30 });
    const quote = {
      reference: 'Q-TEST0001', client_company: 'Acme', client_name: 'Jane', project_name: 'Rollout',
      estimate, catalogue_version: catalogueVersion(), created_at: new Date('2026-11-05T09:00:00Z')
    };
    const text = new PizZip(await generateSowDocx(quote)).file('word/document.xml').asText()
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('2.2 Acceptance criteria');
    for (const t of estimate.timeline) {
      expect(text).toContain(t.milestone);
      expect(text).toContain(PHASE_ACCEPTANCE[t.phaseId].replace(/\u2019/g, '\u2019'));
    }
    // A sub-section: nothing after it was renumbered.
    expect(text).toContain('3. Team and commercials');
    expect(text).toContain('4. Assumptions');
  });
});

describe('Reuse details from your last quote', () => {
  const { inputsFrom, valuesFromQuote } = require('../../utils/quoteFormInputs');

  test('a stored quote read back into the form gives the same inputs', () => {
    const inputs = inputsFrom({
      families: ['sales-cloud', 'revenue-cloud'], modules: ['cpq', 'lead-management'], isvs: ['isv-conga'],
      complexity: 'complex', customization_level: 'high', client_industry: 'Retail', company_size: 'Medium (51-500)',
      number_of_users: '120', number_of_orgs: '2', number_of_integrations: '3', integration_complexity: 'simple',
      include_training: 'on', include_support: '', support_duration_days: '45',
      other_modules: 'legacy approvals', other_integrations: 'SAP'
    });
    const quote = {
      client_company: 'Acme', client_name: 'Jane', client_email: null, client_industry: 'Retail', company_size: 'Medium (51-500)',
      project_name: 'Rollout', project_summary: '<p>Quote &amp; bill</p>',
      inputs, estimate: { contingencyPercentage: 10, currency: 'GBP' }
    };
    const values = valuesFromQuote(quote);
    const again = inputsFrom(values);
    // Numbers come back as numbers rather than the strings a form posts; compare as strings.
    const norm = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? String(v) : v)));
    expect(norm(again)).toEqual(norm(inputs));
    expect(values).toMatchObject({ contingency_percentage: 10, currency: 'GBP', project_summary: 'Quote & bill' });
  });

  test("only the author's own quote can be reused", () => {
    expect(read('routes/quotes.js')).toMatch(/const reusedFrom = source && source\.owner_user_id === ownerId \? source : null;/);
  });

  test('a key on Object.prototype is not a catalogue entry', () => {
    const inputs = inputsFrom({ complexity: '__proto__', customization_level: 'constructor', client_industry: 'toString', isvs: ['__proto__'] });
    expect(inputs).toMatchObject({ complexity: 'moderate', customizationLevel: 'medium', clientIndustry: '', selectedIsvs: [] });
  });

  test('Download SOW pack saves first, then downloads from the stored quote', () => {
    const route = read('routes/quotes.js');
    expect(route).toContain("if (req.body.then === 'download')");
    expect(route).toContain('`/quotes/${quote.reference}?download=${PACKAGE_KIND}`');
    expect(read('public/js/main.js')).toContain('window.history.replaceState(null, \'\', window.location.pathname)');
  });
});

describe('the pack cards name what is in each file, not just how many', () => {
  const { PACK_CARDS } = require('../../config/sowPack');
  const card = (ext) => PACK_CARDS.find((c) => c.ext === ext).items.join(' | ').toLowerCase().replace(/&/g, 'and');

  test('the SOW card names every numbered section the document writes', () => {
    const sections = [...read('utils/documents/sowDocx.js').matchAll(/heading\((?:[^']*?)'\d\. ([A-Za-z ]+)'/g)].map((m) => m[1].toLowerCase());
    expect(sections.length).toBeGreaterThan(0);
    for (const s of sections) expect(card('.docx')).toContain(s);
  });

  test('the workbook card names every sheet', () => {
    const sheets = [...read('utils/documents/wbsXlsx.js').matchAll(/addWorksheet\('([^']+)'/g)].map((m) => m[1].toLowerCase().replace(/&/g, 'and'));
    expect(sheets.length).toBeGreaterThan(0);
    for (const s of sheets) expect(card('.xlsx')).toContain(s);
  });

  test('the deck card names every titled slide', () => {
    const slides = [...read('utils/documents/summaryPptx.js').matchAll(/addSlide\(pptx, '([^']+)'/g)].map((m) => m[1].toLowerCase());
    expect(slides.length).toBeGreaterThan(0);
    for (const s of slides) expect(card('.pptx')).toContain(s);
  });

  test('no bare count is left on either page', () => {
    const all = read('config/sowPack.js') + read('views/services/document-generator.ejs') + read('views/quotes/new.ejs')
      + ['how', 'clouds', 'included'].map((p) => read(`views/partials/sow/${p}.ejs`)).join('');
    // Comments may quote the old wording to explain why it went; the page may not show it.
    const shown = all.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<%#[\s\S]*?%>/g, '');
    expect(shown).not.toMatch(/\b(four|seven|six) (sheets|slides|numbered sections)\b/i);
  });
});
