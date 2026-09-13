'use strict';

const {
  parseHex,
  normaliseHex,
  contrastRatio,
  isReadableOnPaper,
  MIN_TEXT_RATIO
} = require('../../utils/contrast');
const {
  BRANDABLE_KEYS,
  CLAUSE_KINDS,
  MAX_CLAUSES_PER_KIND,
  LETTERHEAD_FIELDS,
  checkBrandColour,
  isClauseKind,
  assertCompanyTemplateIntegrity
} = require('../../config/companyTemplates');
const { HEX, paletteFor, letterheadLines } = require('../../utils/documents/brand');

/**
 * Company document branding.
 *
 * The feature is defined as much by what it refuses as by what it does: no uploaded file,
 * no body-text colour, no replacement of the standard assumptions. These tests pin all
 * three, plus the contrast rule that stops a company shipping a document its own client
 * cannot read.
 */
describe('contrast', () => {
  it('measures the figures DESIGN.md already claims', () => {
    // #0176D3 at 4.63:1 and #00A1E0 at 2.93:1 are written into DESIGN.md as measured
    // facts. Until now nothing checked them.
    expect(contrastRatio('#0176D3', 'FFFFFF')).toBeCloseTo(4.63, 2);
    expect(contrastRatio('#00A1E0', 'FFFFFF')).toBeCloseTo(2.93, 2);
  });

  it('reads a hex colour in every shape a person types one', () => {
    expect(parseHex('#0176D3')).toEqual({ r: 1, g: 118, b: 211 });
    expect(parseHex('0176d3')).toEqual({ r: 1, g: 118, b: 211 });
    expect(parseHex('  #0176D3  ')).toEqual({ r: 1, g: 118, b: 211 });
    // Three-digit shorthand expands the way CSS does.
    expect(parseHex('#07D')).toEqual({ r: 0, g: 119, b: 221 });
  });

  it('refuses anything that is not a colour rather than guessing', () => {
    for (const bad of ['', 'blue', '#12345', '#1234567', 'rgb(1,2,3)', null, undefined, 42, {}]) {
      expect(parseHex(bad)).toBeNull();
      expect(normaliseHex(bad)).toBeNull();
      expect(contrastRatio(bad, 'FFFFFF')).toBeNull();
    }
  });

  it('never reports a ratio outside the possible range', () => {
    expect(contrastRatio('000000', 'FFFFFF')).toBeCloseTo(21, 1);
    expect(contrastRatio('FFFFFF', 'FFFFFF')).toBeCloseTo(1, 5);
  });

  it('is symmetric — which colour is the background does not change the ratio', () => {
    expect(contrastRatio('#0176D3', 'FFFFFF')).toBeCloseTo(contrastRatio('FFFFFF', '#0176D3'), 10);
  });
});

describe('choosing a brand colour', () => {
  it('accepts a colour that reads on white', () => {
    const result = checkBrandColour('#0176D3');
    expect(result.ok).toBe(true);
    expect(result.hex).toBe('0176D3');
  });

  it('REFUSES Salesforce cyan, for the same reason the site never puts it behind white text', () => {
    const result = checkBrandColour('#00A1E0');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/2\.93:1/);
    expect(result.reason).toMatch(String(MIN_TEXT_RATIO));
  });

  it('reports the measurement rather than silently substituting a colour', () => {
    // A company that picked a colour and got a different one has been lied to about what
    // it configured.
    const result = checkBrandColour('#FFFF00');
    expect(result.ok).toBe(false);
    expect(result.ratio).toBeLessThan(MIN_TEXT_RATIO);
    expect(result.reason).toMatch(/darker shade/);
  });

  it('normalises what it accepts, so a generator never sees a hash or lower case', () => {
    expect(checkBrandColour('  #0176d3 ').hex).toBe('0176D3');
  });

  it('refuses a value that is not a colour at all', () => {
    expect(checkBrandColour('corporate blue').ok).toBe(false);
    expect(checkBrandColour('').ok).toBe(false);
    expect(checkBrandColour(null).ok).toBe(false);
  });

  it('holds the Hub to its own rule', () => {
    for (const key of BRANDABLE_KEYS) expect(isReadableOnPaper(HEX[key])).toBe(true);
    expect(assertCompanyTemplateIntegrity()).toBe(true);
  });
});

describe('the palette a document renders with', () => {
  it('applies only the two accent colours', () => {
    const palette = paletteFor({ colours: { navy: 'AA1122', blue: 'BB2233' } });
    expect(palette.navy).toBe('AA1122');
    expect(palette.blue).toBe('BB2233');
  });

  it('IGNORES any attempt to change body text, rules or shading', () => {
    /*
     * A company choosing its heading colour is branding. A company choosing its body-text
     * colour is a company shipping an unreadable document to a client under its own name,
     * and the person who chose it is the last to find out.
     */
    const palette = paletteFor({ colours: { ink: 'FFFFFF', inkMuted: 'FFFFFF', rule: 'FFFFFF', wash: '000000' } });
    expect(palette.ink).toBe(HEX.ink);
    expect(palette.inkMuted).toBe(HEX.inkMuted);
    expect(palette.rule).toBe(HEX.rule);
    expect(palette.wash).toBe(HEX.wash);
  });

  it('falls back to the Hub for a malformed value rather than passing it to docx', () => {
    // A malformed colour reaching the document library produces a file that opens to
    // garbage, which is worse than an unbranded one.
    for (const bad of ['#0176D3', 'nope', '', null, 12345, 'FFF']) {
      expect(paletteFor({ colours: { navy: bad } }).navy).toBe(HEX.navy);
    }
  });

  it('renders the Hub palette when nothing is configured', () => {
    expect(paletteFor(null)).toEqual(HEX);
    expect(paletteFor({})).toEqual(HEX);
    expect(paletteFor({ colours: {} })).toEqual(HEX);
  });
});

describe('the letterhead', () => {
  it('prints only the lines that were filled in', () => {
    expect(letterheadLines({ letterhead: { legal_name: 'Acme Ltd', vat_number: 'IE123' } })).toEqual([
      'Acme Ltd',
      'VAT IE123'
    ]);
  });

  it('is empty when nothing is configured, so a generator never branches on it', () => {
    expect(letterheadLines(null)).toEqual([]);
    expect(letterheadLines({})).toEqual([]);
    expect(letterheadLines({ letterhead: {} })).toEqual([]);
  });

  it('joins contact details onto one line rather than leaving a gap', () => {
    const lines = letterheadLines({ letterhead: { contact_email: 'a@b.c', contact_phone: '+353 1' } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/a@b\.c/);
    expect(lines[0]).toMatch(/\+353 1/);
  });

  it('declares every field it stores', () => {
    const keys = LETTERHEAD_FIELDS.map((f) => f.key);
    expect(keys).toContain('legal_name');
    expect(keys).toContain('vat_number');
    expect(keys).toContain('footer_note');
    for (const field of LETTERHEAD_FIELDS) expect(field.maxLength).toBeGreaterThan(0);
  });
});

describe('clauses', () => {
  it('knows only the kinds a document has a place for', () => {
    expect(isClauseKind('assumption')).toBe(true);
    expect(isClauseKind('exclusion')).toBe(true);
    expect(isClauseKind('term')).toBe(true);
    expect(isClauseKind('anything_else')).toBe(false);
    expect(isClauseKind('__proto__')).toBe(false);
  });

  it('caps how many a document can carry', () => {
    // A quote that grows a page of clauses stops being read at all.
    expect(MAX_CLAUSES_PER_KIND).toBeGreaterThan(0);
    expect(MAX_CLAUSES_PER_KIND).toBeLessThanOrEqual(20);
  });

  it('bounds every clause kind', () => {
    for (const kind of Object.values(CLAUSE_KINDS)) {
      expect(kind.maxLength).toBeGreaterThanOrEqual(50);
      expect(kind.help).toBeTruthy();
    }
  });
});

describe('what this feature refuses to do', () => {
  it('has no concept of an uploaded file anywhere in its surface', () => {
    /*
     * The reference implementation asks a company to upload a real person's CV as a
     * "sample", stores that person's name and up to forty thousand characters of their
     * document, writes the file to disk, and later serves it back. Three standing rules
     * at once: durable bytes never live on disk, a document nobody validated is never
     * served, and personal data kept without a purpose is personal data to explain later.
     */
    const surface = [
      ...Object.keys(require('../../config/companyTemplates')),
      ...Object.getOwnPropertyNames(require('../../models/CompanyTemplate'))
    ].join(' ');
    expect(surface).not.toMatch(/upload|parse|sample|extract|filePath|originalFilename/i);
  });
});
