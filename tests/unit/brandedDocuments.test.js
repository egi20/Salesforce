'use strict';

const { generateSowDocx } = require('../../utils/documents/sowDocx');
const { generateWbsXlsx } = require('../../utils/documents/wbsXlsx');
const { generateSummaryPptx } = require('../../utils/documents/summaryPptx');
const { inspectDocument } = require('../../utils/documents/validate');
const PizZip = require('pizzip');

/**
 * The text of a .docx, not the size of its zip.
 *
 * Comparing byte lengths looked like the obvious way to ask "did branding change the
 * document" — and it flakes: two identical calls produce zips that differ by a byte or
 * two, because the archive carries timestamps that compress differently. The content is
 * what the assertion is actually about, so read the content.
 */
function documentXml(buffer) {
  return new PizZip(buffer).file('word/document.xml').asText();
}
const { calculateEstimation } = require('../../utils/sowEstimation');

/**
 * The three generators, rendered with a company's branding.
 *
 * The rule that never bends: **open it before anyone else has to.** Branding introduces
 * caller-supplied values into the file, so every case here is checked by actually parsing
 * the produced package — a colour that reached `docx` malformed produces a file that
 * downloads fine and then opens to garbage, which the recipient experiences as "you sent
 * me a corrupt file".
 */
const ESTIMATE = calculateEstimation({
  modules: ['lead-management', 'opportunity-management'],
  complexity: 'standard',
  customization: 'moderate',
  industry: 'Technology',
  companySize: 'Medium (51-500)',
  isvSolutions: [],
  includeTraining: true,
  includeHypercare: true
});

const QUOTE = {
  id: 1,
  reference: 'Q-TEST',
  client_company: 'BigCo',
  client_name: 'A Person',
  project_name: 'Commerce rollout',
  estimate: ESTIMATE,
  catalogue_version: 'abc123',
  created_at: new Date('2026-09-13T00:00:00Z')
};

const BRANDING = {
  colours: { navy: '7A0F2B', blue: 'B3364A' },
  letterhead: {
    legal_name: 'Acme Consulting Limited',
    address: '1 Main Street, Dublin 2',
    vat_number: 'IE1234567X',
    registration_number: '123456',
    contact_email: 'hello@acme.example',
    footer_note: 'Acme Consulting Limited, registered in Ireland'
  },
  clauses: {
    assumption: [{ body: 'The client provides a sandbox org within five working days.' }],
    exclusion: [{ body: 'Third-party licence costs are not included.' }],
    term: [{ body: 'Payment is due within thirty days of invoice.' }]
  }
};

const GENERATORS = [
  ['statement of work', generateSowDocx, 'docx'],
  ['work breakdown', generateWbsXlsx, 'xlsx'],
  ['summary deck', generateSummaryPptx, 'pptx']
];

describe('every generator, branded and unbranded', () => {
  it.each(GENERATORS)('produces a %s that opens without branding', async (_label, generate, kind) => {
    expect(inspectDocument(await generate(QUOTE), kind).ok).toBe(true);
  });

  it.each(GENERATORS)('produces a %s that opens WITH branding', async (_label, generate, kind) => {
    expect(inspectDocument(await generate(QUOTE, { branding: BRANDING }), kind).ok).toBe(true);
  });

  it.each(GENERATORS)('produces a %s that opens when branding is half-filled', async (_label, generate, kind) => {
    // The normal state of a company that set a colour and stopped. Every field is
    // optional, so a generator that assumed any of them would break on the common case.
    const partial = { colours: { navy: '7A0F2B' }, letterhead: { legal_name: 'Acme' }, clauses: {} };
    expect(inspectDocument(await generate(QUOTE, { branding: partial }), kind).ok).toBe(true);
  });

  it.each(GENERATORS)('produces a %s that opens when branding is nonsense', async (_label, generate, kind) => {
    /*
     * `paletteFor` ignores a malformed colour rather than passing it through, and the
     * letterhead is plain text. This asserts the whole chain rather than the unit: a value
     * that slipped past would show up here as a file that will not parse.
     */
    const hostile = {
      colours: { navy: 'not-a-colour', blue: '<script>', ink: 'FFFFFF' },
      letterhead: { legal_name: 'Acme & Sons <Ltd> "Quoted"', footer_note: 'x & y < z' },
      clauses: { assumption: [{ body: 'Ampersands & angle < brackets > survive.' }] }
    };
    expect(inspectDocument(await generate(QUOTE, { branding: hostile }), kind).ok).toBe(true);
  });
});

describe('a company name with an ampersand', () => {
  /*
   * A bug this suite found rather than a precaution. `pptxgenjs` escapes slide body text
   * but writes `author` and `company` straight into `docProps/app.xml`, so a company
   * called "Smith & Jones Ltd" produced a package whose app.xml would not parse — and
   * `assertDocumentOpens` refused to serve it. About as ordinary a company name as exists.
   */
  const branding = { colours: {}, letterhead: { legal_name: 'Smith & Jones Ltd' }, clauses: {} };

  it('produces a deck that opens', async () => {
    expect(inspectDocument(await generateSummaryPptx(QUOTE, { branding }), 'pptx').ok).toBe(true);
  });

  it('writes the name escaped EXACTLY once into the document properties', async () => {
    // Both directions. A parse check alone would miss a double-escape, because
    // "&amp;amp;" is perfectly valid XML that displays as "&amp;" to a reader — so if a
    // future pptxgenjs starts escaping this field, this is what catches it.
    const buffer = await generateSummaryPptx(QUOTE, { branding });
    const appXml = new PizZip(buffer).file('docProps/app.xml').asText();

    expect(appXml.match(/Smith &amp; Jones Ltd/g)).toHaveLength(1);
    expect(appXml).not.toMatch(/&amp;amp;/);
  });

  it('renders the name on the cover slide as well', async () => {
    const buffer = await generateSummaryPptx(QUOTE, { branding });
    const slide = new PizZip(buffer).file('ppt/slides/slide1.xml').asText();
    expect(slide).toMatch(/Smith &amp; Jones Ltd/);
  });
});

describe('what branding changes and what it does not', () => {
  it('changes the document', async () => {
    const plain = documentXml(await generateSowDocx(QUOTE));
    const branded = documentXml(await generateSowDocx(QUOTE, { branding: BRANDING }));

    expect(branded).not.toBe(plain);
    expect(branded).toMatch(/Acme Consulting Limited/);
    expect(branded).toMatch(/7A0F2B/);
    // And the Hub's default heading colour is gone from it.
    expect(plain).toMatch(/032D60/);
    expect(branded).not.toMatch(/032D60/);
  });

  it('leaves the document unchanged when nothing is configured', async () => {
    // A company with no template must get exactly the document it always got, byte for
    // byte in the content — not merely a document of about the same size.
    const plain = documentXml(await generateSowDocx(QUOTE));
    const empty = documentXml(
      await generateSowDocx(QUOTE, {
        branding: { colours: {}, letterhead: {}, clauses: { assumption: [], exclusion: [], term: [] } }
      })
    );
    expect(empty).toBe(plain);
  });

  it('ADDS the company\'s clauses rather than replacing the standard ones', async () => {
    /*
     * The standard assumptions are what make the estimate mean anything. A company that
     * could replace them could ship a figure with its basis quietly removed, so the
     * branded document must be strictly larger in that section.
     */
    const withClauses = await generateSowDocx(QUOTE, {
      branding: { colours: {}, letterhead: {}, clauses: BRANDING.clauses }
    });
    const xml = documentXml(withClauses);

    // The company's clause is present...
    expect(xml).toMatch(/sandbox org within five working days/);
    // ...and so is the Hub's own standard assumption, which it must never displace.
    expect(xml).toMatch(/timely access to stakeholders/);
    expect(inspectDocument(withClauses, 'docx').ok).toBe(true);
  });

  it('survives a company that filled every clause slot', async () => {
    const many = (kind) =>
      Array.from({ length: 12 }, (_, i) => ({ body: `${kind} number ${i + 1}, stated in a full sentence.` }));
    const buffer = await generateSowDocx(QUOTE, {
      branding: {
        colours: BRANDING.colours,
        letterhead: BRANDING.letterhead,
        clauses: { assumption: many('Assumption'), exclusion: many('Exclusion'), term: many('Term') }
      }
    });
    expect(inspectDocument(buffer, 'docx').ok).toBe(true);
  });
});
