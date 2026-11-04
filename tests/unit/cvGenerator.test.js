'use strict';

const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const { cvBlocks, defaultOptions, optionsFrom, SECTION_KEYS } = require('../../utils/documents/cvLayout');
const { generateCvDocx } = require('../../utils/documents/cvDocx');

/*
 * The CV Generator's preview is only worth having if it is the document. Both renderers
 * read cvBlocks(); these tests pin the selection logic and that every block's text reaches
 * the .docx.
 */
const DOSSIER = {
  name: 'Ana Pjetri',
  email: 'ana@example.com',
  headline: 'Senior Revenue Cloud consultant',
  roleLabel: 'Revenue Cloud Consultant',
  seniority: 'senior',
  yearsExperience: 9,
  location: 'Tirana, AL',
  workMode: 'Remote',
  willingToTravel: false,
  availability: 'immediate',
  availableFrom: null,
  dayRate: 750,
  hourlyRate: null,
  currency: 'EUR',
  rateVisible: false,
  bio: 'Ten years of quote-to-cash.\n\nSecond paragraph.',
  trailhead: { rank: 'Ranger', badges: 120 },
  links: { linkedin: null, website: null, trailblazer: null },
  skills: ['Apex', 'CPQ'],
  certifications: [{ name: 'Platform Developer I', credentialId: null, earned: 'Mar 2020', expired: false }],
  experience: [{ company: 'Acme', title: 'Lead', period: 'Mar 2021 – present', description: 'Led delivery.' }],
  projects: [{ name: 'Q2C rollout', client: 'BigCo', cloud: null, role: null, period: 'Jan 2024 – present', description: 'Shipped it.' }],
  generatedOn: new Date('2026-11-04T00:00:00Z')
};

const texts = (blocks) => blocks.map((b) => [b.text, b.left, b.right, b.label, b.value].filter(Boolean).join(' ')).join('\n');

describe('what goes on the CV', () => {
  it('includes every optional section by default except a rate kept on request', () => {
    expect(defaultOptions(DOSSIER)).toEqual({ projects: true, experience: true, certifications: true, trailhead: true, rate: false });
    expect(defaultOptions({ ...DOSSIER, rateVisible: true }).rate).toBe(true);
    const all = texts(cvBlocks(DOSSIER));
    expect(all).toMatch(/Delivery history/);
    expect(all).toMatch(/Ranger rank · 120 badges/);
    expect(all).not.toMatch(/750/);
  });

  it('leaves out exactly what was unticked', () => {
    const only = optionsFrom({ opts: '1', include: ['rate'] }, DOSSIER);
    const out = texts(cvBlocks(DOSSIER, only));
    expect(out).toMatch(/Day rate 750 EUR/);
    for (const gone of ['Delivery history', 'Employment', 'Certifications', 'Trailhead']) expect(out).not.toMatch(gone);
    // Always there whatever is ticked.
    expect(out).toMatch(/Ana Pjetri/);
    expect(out).toMatch(/Apex/);
  });

  it('treats a submitted form with nothing ticked as nothing, not as the defaults', () => {
    expect(optionsFrom({ opts: '1' }, DOSSIER)).toEqual(Object.fromEntries(SECTION_KEYS.map((k) => [k, false])));
    expect(optionsFrom({}, DOSSIER)).toEqual(defaultOptions(DOSSIER));
  });

  it('puts every previewed line into the .docx', async () => {
    const options = { ...defaultOptions(DOSSIER), rate: true };
    const buffer = await generateCvDocx(DOSSIER, options);
    const xml = new PizZip(buffer).file('word/document.xml').asText();
    for (const block of cvBlocks(DOSSIER, options)) {
      for (const value of [block.text, block.left, block.right, block.label, block.value].filter(Boolean)) {
        const escaped = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const shown = block.kind === 'heading' ? escaped.toUpperCase() : escaped;
        expect(xml).toContain(shown);
      }
    }
  });

  it('never carries markup from the profile into a document', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../services/consultantDossier.js'), 'utf8');
    // The profile stores bio and descriptions as sanitised HTML; the dossier converts them.
    expect(src).toMatch(/bio: richTextToEditable\(profile\.bio\)/);
    expect(src.match(/description: richTextToEditable/g)).toHaveLength(2);
  });
});

describe('two pages, two audiences', () => {
  it('the SOW pack page no longer advertises the CV, and points to it instead', () => {
    const index = fs.readFileSync(path.join(__dirname, '../../routes/index.js'), 'utf8');
    const block = index.slice(index.indexOf("'document-generator': {"), index.indexOf("aside: { text"));
    expect(block).not.toMatch(/CV and rate card/);
    expect(block).toMatch(/label: 'FOR COMPANIES'/);
  });

  it('every "CV Generator" link goes to the CV page', () => {
    const files = ['views/partials/navigation.ejs', 'views/partials/footer.ejs', 'routes/index.js'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
      const lines = src.split('\n').filter((l) => /CV Generator/.test(l) && /href|\[/.test(l));
      for (const line of lines) expect(line).not.toMatch(/services\/document-generator/);
    }
  });
});

describe('sections with nothing in them', () => {
  it('start unticked, so a ticked box always adds something', () => {
    const bare = { ...DOSSIER, trailhead: { rank: null, badges: null }, dayRate: null, hourlyRate: null, rateVisible: true };
    expect(defaultOptions(bare)).toMatchObject({ trailhead: false, rate: false });
  });
});
