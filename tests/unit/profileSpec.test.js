'use strict';

/*
 * Build-your-profile: uploaded documents, entry ordering and the CV import's entries.
 * The database module is replaced BEFORE any model loads (see profileDetails.test.js for
 * why that order matters).
 */
const mockQueries = [];
const mockState = { rows: [] };
jest.mock('../../config/database', () => ({
  pool: {},
  promisePool: { query: jest.fn(async () => [[]]) },
  withTransaction: jest.fn(async (fn) => fn({
    query: async (sql, params) => {
      mockQueries.push({ sql, params });
      if (/^SELECT id FROM/.test(sql)) return [mockState.rows.map((id) => ({ id }))];
      return [[]];
    }
  }))
}));

const PizZip = require('pizzip');
const { validateDocument, safeFilename, PDF_TYPE, DOCX_TYPE } = require('../../utils/documentUpload');
const ConsultantProfile = require('../../models/ConsultantProfile');
const { sanitizeResult, monthOrNull } = require('../../utils/cvImport');

function docx(extra = {}) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', extra.contentTypes || '<Types/>');
  zip.file('word/document.xml', '<w:document/>');
  zip.file('word/_rels/document.xml.rels', extra.rels || '<Relationships/>');
  for (const [name, body] of Object.entries(extra.files || {})) zip.file(name, body);
  return zip.generate({ type: 'nodebuffer' });
}

describe('an uploaded CV or cover letter', () => {
  it('accepts a plain PDF and a plain .docx', () => {
    expect(validateDocument({ buffer: Buffer.from('%PDF-1.7\n1 0 obj\n'), originalname: 'cv.pdf', mimetype: PDF_TYPE }))
      .toEqual({ ok: true, contentType: PDF_TYPE });
    expect(validateDocument({ buffer: docx(), originalname: 'cv.docx', mimetype: DOCX_TYPE }))
      .toEqual({ ok: true, contentType: DOCX_TYPE });
  });

  it('refuses a legacy .doc with a way forward, and anything that is not PDF or .docx', () => {
    expect(validateDocument({ buffer: Buffer.from('x'), originalname: 'cv.doc' }).reason).toMatch(/\.docx or PDF/);
    expect(validateDocument({ buffer: Buffer.from('x'), originalname: 'cv.exe' }).ok).toBe(false);
  });

  it('refuses a PDF that is not one, or that carries scripts', () => {
    expect(validateDocument({ buffer: Buffer.from('MZ...'), originalname: 'cv.pdf' }).ok).toBe(false);
    expect(validateDocument({ buffer: Buffer.from('%PDF-1.7 /OpenAction << /JavaScript (x) >>'), originalname: 'cv.pdf' }).ok).toBe(false);
    expect(validateDocument({ buffer: Buffer.from('%PDF-1.7 /Launch'), originalname: 'cv.pdf' }).ok).toBe(false);
  });

  it('refuses a .docx with macros, embedded objects or a remote template, and allows a hyperlink', () => {
    expect(validateDocument({ buffer: docx({ files: { 'word/vbaProject.bin': 'x' } }), originalname: 'a.docx' }).ok).toBe(false);
    expect(validateDocument({ buffer: docx({ files: { 'word/embeddings/oleObject1.bin': 'x' } }), originalname: 'a.docx' }).ok).toBe(false);
    const remote = '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="http://evil/t.dotm" TargetMode="External"/></Relationships>';
    expect(validateDocument({ buffer: docx({ rels: remote }), originalname: 'a.docx' }).ok).toBe(false);
    const link = '<Relationships><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>';
    expect(validateDocument({ buffer: docx({ rels: link }), originalname: 'a.docx' }).ok).toBe(true);
  });

  it('refuses a zip that is not a Word document, and a declared type that disagrees', () => {
    const zip = new PizZip();
    zip.file('hello.txt', 'hi');
    expect(validateDocument({ buffer: zip.generate({ type: 'nodebuffer' }), originalname: 'a.docx' }).ok).toBe(false);
    expect(validateDocument({ buffer: docx(), originalname: 'a.docx', mimetype: 'text/html' }).ok).toBe(false);
  });

  it('downloads under a filename that is safe in a header', () => {
    expect(safeFilename('Anna "CV"\r\nX: y.pdf', PDF_TYPE)).toBe('Anna-CV-X-y.pdf');
    expect(safeFilename('', DOCX_TYPE)).toBe('document.docx');
  });
});

describe('reordering projects and experience', () => {
  beforeEach(() => { mockQueries.length = 0; mockState.rows = [11, 12, 13]; });

  it('accepts exactly the owner\'s ids, rearranged, and writes them in that order', async () => {
    await expect(ConsultantProfile.setEntryOrder('projects', 7, ['13', '11', '12'])).resolves.toBe(true);
    const updates = mockQueries.filter((q) => /^UPDATE/.test(q.sql)).map((q) => q.params);
    expect(updates).toEqual([[1, 13, 7], [2, 11, 7], [3, 12, 7]]);
  });

  it('refuses a foreign id, a missing id or a duplicate, and writes nothing', async () => {
    for (const bad of [['11', '12', '99'], ['11', '12'], ['11', '11', '12']]) {
      mockQueries.length = 0;
      // eslint-disable-next-line no-await-in-loop -- each case must run alone against a fresh query log
      await expect(ConsultantProfile.setEntryOrder('experience', 7, bad)).resolves.toBe(false);
      expect(mockQueries.some((q) => /^UPDATE/.test(q.sql))).toBe(false);
    }
  });

  it('moves one entry a step and refuses to move past either end', async () => {
    await expect(ConsultantProfile.moveEntry('projects', 7, 12, 'up')).resolves.toBe(true);
    await expect(ConsultantProfile.moveEntry('projects', 7, 11, 'up')).resolves.toBe(false);
    await expect(ConsultantProfile.moveEntry('projects', 7, 13, 'down')).resolves.toBe(false);
  });

  it('knows only its two lists', async () => {
    await expect(ConsultantProfile.setEntryOrder('users', 7, [])).rejects.toThrow(/No entry list/);
  });
});

describe('what the CV import offers for confirmation', () => {
  it('turns a month into a date and anything else into nothing', () => {
    expect(monthOrNull('2021-03')).toBe('2021-03-01');
    expect(monthOrNull('2021')).toBeNull();
    expect(monthOrNull('2021-13')).toBeNull();
    expect(monthOrNull('March 2021')).toBeNull();
  });

  it('keeps entries it can store and drops the rest, without inventing a field', () => {
    const out = sanitizeResult({
      experience: [
        { company: 'Acme', title: 'Architect', start: '2020-01', end: '2022-06', current: false, description: 'Led a migration.' },
        { company: 'NoStart', title: 'Dev', start: '', end: '' },
        { company: 'Now Ltd', title: 'Lead', start: '2023-02', end: '2024-01', current: true, extra: 'ignored' }
      ],
      projects: [{ name: 'Service Cloud rollout', client: 'Bank', start: '2021', current: false }, { client: 'no name' }, 'junk'],
      unexpected: 'dropped'
    });
    expect(out.experience).toHaveLength(2);
    expect(out.experience[1]).toEqual({ started_on: '2023-02-01', ended_on: null, is_current: true, description: '', company: 'Now Ltd', title: 'Lead', location: '' });
    expect(out.projects).toEqual([{ started_on: null, ended_on: null, is_current: false, description: '', name: 'Service Cloud rollout', client: 'Bank' }]);
    expect(out).not.toHaveProperty('unexpected');
  });

  it('caps a long list', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `P${i}` }));
    expect(sanitizeResult({ projects: many }).projects).toHaveLength(12);
  });
});
