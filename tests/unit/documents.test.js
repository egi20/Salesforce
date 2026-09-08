'use strict';

const PizZip = require('pizzip');
const ExcelJS = require('exceljs');

const { calculateEstimation } = require('../../utils/sowEstimation');
const { catalogueVersion } = require('../../config/estimation');
const { assertWellFormedXml, inspectDocument, assertDocumentOpens, escapeXml } = require('../../utils/documents/validate');
const { generateSowDocx } = require('../../utils/documents/sowDocx');
const { generateWbsXlsx } = require('../../utils/documents/wbsXlsx');
const { generateSummaryPptx } = require('../../utils/documents/summaryPptx');
const { filenameFor, isDocumentKind, generateDocument, generatePackage } = require('../../services/quotePackage');

const INPUTS = {
  selectedFamilies: ['sales-cloud', 'revenue-cloud'],
  selectedModules: ['lead-management', 'cpq', 'billing'],
  selectedIsvs: ['isv-conga'],
  complexity: 'complex',
  customizationLevel: 'high',
  clientIndustry: 'Financial Services',
  companySize: 'Large (501-5000)',
  numberOfUsers: 450,
  numberOfOrgs: 2,
  numberOfIntegrations: 3,
  integrationComplexity: 'complex',
  includeTraining: true,
  includeSupport: true,
  supportDurationDays: 30,
  otherModules: 'legacy pricing engine, custom approvals'
};

const ESTIMATE = calculateEstimation(INPUTS, { contingencyPercentage: 15, currency: 'EUR' });

const QUOTE = {
  id: 1,
  reference: 'Q-7F3K9B2M',
  owner_user_id: 1,
  client_name: 'Marta Lind',
  client_company: 'Meridian Retail Group',
  client_industry: 'Financial Services',
  company_size: 'Large (501-5000)',
  project_name: 'Revenue Cloud rollout, phase 1',
  project_summary: '<p>Quote-to-cash on Salesforce.</p>',
  inputs: INPUTS,
  estimate: ESTIMATE,
  catalogue_version: catalogueVersion(),
  currency: 'EUR',
  status: 'draft',
  created_at: new Date('2026-09-08T09:00:00Z')
};

function docxText(buffer) {
  return new PizZip(buffer)
    .file('word/document.xml')
    .asText()
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('XML validation', () => {
  it('accepts well-formed XML', () => {
    expect(() => assertWellFormedXml('<a><b attr="x"/></a>')).not.toThrow();
  });

  it('rejects an unbalanced tag, which a presence check would miss', () => {
    expect(() => assertWellFormedXml('<a><b></a>')).toThrow(/Malformed XML/);
  });

  it('rejects an unescaped ampersand', () => {
    expect(() => assertWellFormedXml('<a>Tom & Jerry</a>')).toThrow(/Malformed XML/);
  });

  it('names the part and quotes the surrounding text', () => {
    expect(() => assertWellFormedXml('<a><b></a>', 'word/document.xml')).toThrow(/word\/document\.xml.*near/s);
  });

  it('escapes all five XML entities', () => {
    expect(escapeXml(`a & b < c > "d" 'e'`)).toBe('a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
    expect(escapeXml(null)).toBe('');
  });
});

describe('package inspection', () => {
  it('rejects an empty buffer', () => {
    expect(inspectDocument(Buffer.alloc(0), 'docx')).toMatchObject({ ok: false });
  });

  it('rejects something that is not a zip', () => {
    expect(inspectDocument(Buffer.from('hello there'), 'docx')).toMatchObject({ ok: false, reason: /not a zip/ });
  });

  it('rejects a zip that is missing a required part', () => {
    const zip = new PizZip();
    zip.file('word/document.xml', '<a/>');
    const buffer = zip.generate({ type: 'nodebuffer' });
    expect(inspectDocument(buffer, 'docx')).toMatchObject({ ok: false, reason: /\[Content_Types\]\.xml/ });
  });

  it('rejects a zip whose XML part does not parse', () => {
    const zip = new PizZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document><w:body></w:document>');
    const buffer = zip.generate({ type: 'nodebuffer' });
    expect(inspectDocument(buffer, 'docx')).toMatchObject({ ok: false, reason: /Malformed XML/ });
  });

  it('throws with a usable code when asserted', () => {
    expect.assertions(2);
    try {
      assertDocumentOpens(Buffer.from('nope'), 'docx', 'statement of work');
    } catch (err) {
      expect(err.code).toBe('DOCUMENT_MALFORMED');
      expect(err.message).toMatch(/statement of work/);
    }
  });

  it('rejects an unknown kind rather than guessing', () => {
    expect(() => inspectDocument(Buffer.from('PK'), 'rtf')).toThrow(/Unknown document kind/);
  });
});

describe('statement of work', () => {
  let buffer;
  let text;

  beforeAll(async () => {
    buffer = await generateSowDocx(QUOTE, { preparedBy: 'Northwind Cloud Partners' });
    text = docxText(buffer);
  });

  it('produces a document that opens', () => {
    const result = inspectDocument(buffer, 'docx');
    expect(result.ok).toBe(true);
    expect(result.partsChecked).toBeGreaterThan(0);
  });

  it('prints the stored figures rather than recomputing them', () => {
    expect(text).toContain(`${ESTIMATE.totalManDays} man-days`);
    expect(text).toContain(String(ESTIMATE.projectDurationWeeks));
    expect(text).toContain(ESTIMATE.implementationBudget.toLocaleString('en-GB'));
  });

  it('identifies the client, the reference and the catalogue basis', () => {
    expect(text).toContain('Meridian Retail Group');
    expect(text).toContain('Q-7F3K9B2M');
    expect(text).toContain(QUOTE.catalogue_version);
  });

  it('states assumptions and exclusions, so it cannot be read as a fixed price', () => {
    expect(text).toMatch(/estimate based on the scope/i);
    expect(text).toMatch(/Exclusions/);
    expect(text).toMatch(/licence/i);
  });

  it('discloses unmapped scope instead of hiding the allowance', () => {
    expect(text).toMatch(/not matched to a catalogue entry/i);
    expect(text).toContain(String(ESTIMATE.unmapped.days));
  });

  it('survives client names containing XML-significant characters', async () => {
    const awkward = {
      ...QUOTE,
      client_company: 'Smith & Sons <Holdings> "Group"',
      project_name: "O'Brien & Co — phase 1"
    };
    const awkwardBuffer = await generateSowDocx(awkward);
    expect(inspectDocument(awkwardBuffer, 'docx').ok).toBe(true);
    expect(docxText(awkwardBuffer)).toContain('Smith &amp; Sons');
  });
});

describe('work breakdown workbook', () => {
  let buffer;

  beforeAll(async () => {
    buffer = await generateWbsXlsx(QUOTE, { preparedBy: 'Northwind' });
  });

  it('produces a workbook that opens', () => {
    expect(inspectDocument(buffer, 'xlsx').ok).toBe(true);
  });

  it('carries the sheets a reader expects', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Summary', 'WBS', 'Scope', 'Team & cost']);
  });

  it('reproduces the phase days and week ranges from the stored estimate', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('WBS');

    const firstPhase = ESTIMATE.phaseBreakdown[0];
    const firstSlot = ESTIMATE.timeline[0];
    const row = sheet.getRow(5);

    expect(row.getCell(1).value).toBe(firstPhase.name);
    expect(row.getCell(4).value).toBe(firstPhase.days);
    expect(row.getCell(5).value).toBe(firstSlot.startWeek);
    expect(row.getCell(6).value).toBe(firstSlot.endWeek);
  });

  it('uses live formulas for the cost column so the workbook is a usable model', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('Team & cost');
    const firstCost = sheet.getRow(5).getCell(5).value;
    expect(firstCost).toHaveProperty('formula');
    expect(firstCost.result).toBe(ESTIMATE.resourceAllocation[0].totalCost);
  });
});

describe('summary deck', () => {
  let buffer;

  beforeAll(async () => {
    buffer = await generateSummaryPptx(QUOTE, { preparedBy: 'Northwind' });
  });

  it('produces a deck that opens', () => {
    expect(inspectDocument(buffer, 'pptx').ok).toBe(true);
  });

  it('has one slide per message and no more', () => {
    const slides = Object.keys(new PizZip(buffer).files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    expect(slides).toHaveLength(7);
  });
});

describe('package assembly', () => {
  it('validates document kinds', () => {
    expect(isDocumentKind('sow')).toBe(true);
    expect(isDocumentKind('deck')).toBe(true);
    expect(isDocumentKind('invoice')).toBe(false);
  });

  it('rejects an unknown kind with a usable code', async () => {
    await expect(generateDocument(QUOTE, 'invoice')).rejects.toMatchObject({ code: 'UNKNOWN_DOCUMENT_KIND' });
  });

  it('slugifies filenames so they cannot inject a Content-Disposition header', () => {
    const name = filenameFor({ ...QUOTE, client_company: 'Evil"; drop\r\nX-Injected: 1', project_name: '../../etc/passwd' }, 'sow');
    expect(name).not.toMatch(/["\r\n/\\]/);
    expect(name.endsWith('.docx')).toBe(true);
  });

  it('gives each kind its own extension', () => {
    expect(filenameFor(QUOTE, 'sow')).toMatch(/\.docx$/);
    expect(filenameFor(QUOTE, 'wbs')).toMatch(/\.xlsx$/);
    expect(filenameFor(QUOTE, 'deck')).toMatch(/\.pptx$/);
    expect(filenameFor(QUOTE, 'package')).toMatch(/\.zip$/);
  });

  it('zips all three documents plus a basis note', async () => {
    const pkg = await generatePackage(QUOTE, { preparedBy: 'Northwind' });
    const zip = new PizZip(pkg.buffer);
    const names = Object.keys(zip.files);

    expect(pkg.contents).toHaveLength(3);
    expect(names).toContain('README.txt');
    expect(names.filter((n) => /\.(docx|xlsx|pptx)$/.test(n))).toHaveLength(3);

    const readme = zip.file('README.txt').asText();
    expect(readme).toContain(`${ESTIMATE.totalManDays} man-days`);
    expect(readme).toMatch(/not a fixed price/i);
  });

  it('produces documents that agree with each other on the headline figure', async () => {
    const pkg = await generatePackage(QUOTE);
    const zip = new PizZip(pkg.buffer);

    const docxName = Object.keys(zip.files).find((n) => n.endsWith('.docx'));
    const sowText = docxText(zip.file(docxName).asNodeBuffer());
    const readme = zip.file('README.txt').asText();

    expect(sowText).toContain(`${ESTIMATE.totalManDays} man-days`);
    expect(readme).toContain(`${ESTIMATE.totalManDays} man-days`);
  });
});
