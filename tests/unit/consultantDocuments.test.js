'use strict';

const { generateCvDocx } = require('../../utils/documents/cvDocx');
const { generateRateCardDocx } = require('../../utils/documents/rateCardDocx');
const { filenameFor, isDocumentKind, generateDocument, generatePackage } = require('../../services/consultantPackage');
const { inspectDocument } = require('../../utils/documents/validate');
const { period, displayName } = require('../../services/consultantDossier');

/**
 * The consultant's documents.
 *
 * Two things are being pinned. First, that a generated file actually OPENS — a subtly
 * broken OOXML part downloads fine and then fails in Word, which the recipient experiences
 * as "you sent me a corrupt file". Second, that a name cannot escape into a
 * `Content-Disposition` header, which on this route is every download the consultant makes
 * rather than a value they typed into one form.
 */
const FULL = {
  name: 'Ana Pjetri',
  email: 'ana@example.com',
  headline: 'Senior Revenue Cloud consultant',
  roleLabel: 'Revenue Cloud Consultant',
  seniority: 'senior',
  yearsExperience: 9,
  location: 'Dublin, IE',
  workMode: 'remote',
  willingToTravel: true,
  availability: 'two_weeks',
  availableFrom: 'Oct 2026',
  dayRate: 750,
  currency: 'EUR',
  bio: 'Ten years of quote-to-cash delivery.\n\nA second paragraph.',
  links: { linkedin: 'https://www.linkedin.com/in/x', website: null, trailblazer: null },
  skills: ['Apex', 'CPQ', 'Flow'],
  certifications: [
    { name: 'Platform Developer I', credentialId: '123', earned: 'Mar 2020', expired: false },
    { name: 'Sales Cloud Consultant', credentialId: null, earned: 'Jan 2018', expired: true }
  ],
  experience: [{ company: 'Acme', title: 'Lead consultant', period: 'Mar 2021 – present', description: 'Led delivery.' }],
  projects: [
    { name: 'Quote-to-cash rollout', client: 'BigCo', cloud: 'CPQ', role: 'CPQ Consultant', period: 'Jan 2024 – Jun 2024', description: 'Shipped it.' }
  ],
  generatedOn: new Date('2026-09-11T00:00:00Z')
};

/** What a brand-new account looks like: everything empty. */
const BARE = {
  name: 'New Member',
  email: 'new@example.com',
  headline: '',
  roleLabel: null,
  seniority: null,
  yearsExperience: null,
  location: '',
  workMode: 'remote',
  willingToTravel: false,
  availability: 'not_available',
  availableFrom: null,
  dayRate: null,
  currency: 'EUR',
  bio: '',
  links: { linkedin: null, website: null, trailblazer: null },
  skills: [],
  certifications: [],
  experience: [],
  projects: [],
  generatedOn: new Date('2026-09-11T00:00:00Z')
};

describe('the CV', () => {
  it('produces a document that opens', async () => {
    const buffer = await generateCvDocx(FULL);
    expect(inspectDocument(buffer, 'docx').ok).toBe(true);
  });

  it('opens for an empty profile too', async () => {
    // The most common state of a real account, and the one a generator built only against
    // full sample data falls over on.
    const buffer = await generateCvDocx(BARE);
    expect(inspectDocument(buffer, 'docx').ok).toBe(true);
  });

  it('survives the characters that break XML', async () => {
    const buffer = await generateCvDocx({
      ...FULL,
      name: 'A & B <script>',
      headline: 'Quotes "and" \'apostrophes\' & ampersands',
      bio: 'Angle < brackets > and an & ampersand.',
      projects: [{ ...FULL.projects[0], description: '<not markup> & "quoted"' }]
    });
    // The docx library escapes for us, but this is exactly the thing that has to be
    // asserted rather than assumed: an unescaped ampersand makes the whole part unparseable.
    expect(inspectDocument(buffer, 'docx').ok).toBe(true);
  });
});

describe('the rate card', () => {
  it('produces a document that opens, with and without a projection', async () => {
    expect(inspectDocument(await generateRateCardDocx(FULL, null), 'docx').ok).toBe(true);
    const { project } = require('../../utils/contractorEconomics');
    expect(inspectDocument(await generateRateCardDocx(FULL, project({ dayRate: 750 })), 'docx').ok).toBe(true);
  });

  it('opens when there is no rate to quote', async () => {
    expect(inspectDocument(await generateRateCardDocx(BARE, null), 'docx').ok).toBe(true);
  });
});

describe('download filenames', () => {
  it('slugifies the name, so it cannot inject a Content-Disposition header', () => {
    const hostile = { ...FULL, name: 'Ana"; rm -rf /\r\nX-Evil: yes' };
    const filename = filenameFor(hostile, 'cv');
    expect(filename).toMatch(/^[a-z0-9-]+-cv\.docx$/);
    expect(filename).not.toMatch(/["\r\n\\/]/);
  });

  it('falls back rather than producing a nameless file', () => {
    expect(filenameFor({ name: '???' }, 'cv')).toBe('consultant-cv.docx');
    expect(filenameFor({ name: '' }, 'cv')).toBe('consultant-cv.docx');
  });

  it('names the package as a zip', () => {
    expect(filenameFor(FULL, 'package')).toBe('ana-pjetri-package.zip');
  });
});

describe('the package', () => {
  it('rejects a kind it does not know rather than guessing', async () => {
    expect(isDocumentKind('cv')).toBe(true);
    expect(isDocumentKind('rate-card')).toBe(true);
    expect(isDocumentKind('cover-letter')).toBe(false);
    await expect(generateDocument(FULL, 'cover-letter')).rejects.toMatchObject({ code: 'UNKNOWN_DOCUMENT_KIND' });
  });

  it('zips both documents and a README', async () => {
    const result = await generatePackage(FULL);
    expect(result.contents).toEqual(['ana-pjetri-cv.docx', 'ana-pjetri-rate-card.docx']);
    expect(result.contentType).toBe('application/zip');
    expect(result.buffer.length).toBeGreaterThan(1000);
  });
});

describe('dossier formatting', () => {
  it('writes a period as month and year, never a day', () => {
    expect(period('2024-01-15', '2024-06-30')).toBe('Jan 2024 – Jun 2024');
  });

  it('calls an open-ended engagement "present"', () => {
    expect(period('2024-01-15', null)).toBe('Jan 2024 – present');
    expect(period('2024-01-15', '2024-06-30', true)).toBe('Jan 2024 – present');
  });

  it('NEVER falls back to the email local part for a display name', () => {
    /*
     * A real finding carried over from the messaging module: an account with no name
     * would otherwise put a `firstname.lastname` email prefix on a document its owner
     * sends to clients.
     */
    const name = displayName({ email: 'firstname.lastname@example.com' }, null);
    expect(name).not.toMatch(/firstname/);
    expect(name).toBe('Salesforce consultant');
  });

  it('prefers the real name when there is one', () => {
    /*
     * `users.name`, because that is the only name column the schema has ever had.
     *
     * This test used to pass `{ first_name, last_name }` and assert they were joined — and it
     * was GREEN, because the function read two undefined properties and fell through to a
     * branch that happened to produce the expected string for a different reason. A test
     * asserting behaviour over a column the database does not have is what kept the real
     * version of this mistake invisible: `services/paymentFulfilment.js` was SELECTing those
     * same two columns, which MySQL answers with ER_BAD_FIELD_ERROR, inside the transaction
     * every payment's invoice is raised in.
     */
    expect(displayName({ name: 'Ana Pjetri', email: 'a@b.c' }, null)).toBe('Ana Pjetri');
  });

  it('no module selects a name column that does not exist', () => {
    // The guard that would have caught the payment-path bug. `users` has one name column.
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', '..');
    const offenders = [];
    for (const dir of ['models', 'services', 'routes']) {
      for (const file of fs.readdirSync(path.join(root, dir))) {
        const body = fs.readFileSync(path.join(root, dir, file), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        if (/\b(first_name|last_name)\b/.test(body)) offenders.push(`${dir}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
