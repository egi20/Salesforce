'use strict';

const fs = require('fs');

const crm = require('../../config/crm');
const CrmLead = require('../../models/CrmLead');
const CrmSuppression = require('../../models/CrmSuppression');
const outreach = require('../../utils/outreachDrafting');
const { readLeads, parseCsv } = require('../../utils/crmImport');

function sqlOf(modulePath) {
  return fs
    .readFileSync(require.resolve(modulePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function codeOf(modulePath) {
  return sqlOf(modulePath).replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");
}

const VALID = Object.freeze({
  company: 'Acme GmbH',
  contact_email: 'jane@acme.example',
  source: 'public_directory',
  source_detail: 'DACH partner directory'
});

describe('the pipeline', () => {
  test('passes its boot assertion', () => {
    expect(crm.assertCrmIntegrity()).toBe(true);
  });

  test('every non-terminal status can reach unsubscribed in ONE step', () => {
    // Somebody asking to be left alone must never depend on where the board happens to be.
    for (const status of crm.STATUSES) {
      if (crm.isTerminal(status)) continue;
      expect(crm.TRANSITIONS[status]).toContain('unsubscribed');
    }
  });

  test('unsubscribed is terminal', () => {
    expect(crm.TRANSITIONS.unsubscribed).toEqual([]);
    expect(crm.isTerminal('unsubscribed')).toBe(true);
  });

  test('every declared transition names a declared status', () => {
    for (const [, targets] of Object.entries(crm.TRANSITIONS)) {
      for (const to of targets) expect(crm.STATUSES).toContain(to);
    }
  });

  test('an undeclared move is refused', () => {
    expect(crm.canTransition('new', 'won')).toBe(false);
    expect(crm.canTransition('won', 'new')).toBe(false);
    expect(crm.canTransition('new', 'contacted')).toBe(true);
  });

  test('there is no free-text source option', () => {
    // A free-text source field fills up with "web" and tells nobody anything a year later,
    // which is exactly when somebody asks.
    expect(crm.SOURCE_VALUES).not.toContain('other');
    for (const source of crm.LEAD_SOURCES) expect(source.help.length).toBeGreaterThan(10);
  });
});

describe('a lead cannot exist without a source', () => {
  test('refuses a missing or unknown source', () => {
    const { source, ...noSource } = VALID;
    expect(source).toBe('public_directory');
    expect(() => CrmLead.normaliseLead(noSource)).toThrow(/where this contact came from/i);
    expect(() => CrmLead.normaliseLead({ ...VALID, source: 'scraped' })).toThrow(/where this contact came from/i);
    expect(() => CrmLead.normaliseLead({ ...VALID, source: '' })).toThrow(/where this contact came from/i);
  });

  test('refuses a source that needs detail without it', () => {
    expect(() => CrmLead.normaliseLead({ ...VALID, source_detail: '' })).toThrow(/specifically/i);
    expect(() => CrmLead.normaliseLead({ ...VALID, source_detail: 'x' })).toThrow(/specifically/i);
  });

  test('allows a source that needs no detail', () => {
    expect(CrmLead.normaliseLead({ ...VALID, source: 'existing_customer', source_detail: '' }).source)
      .toBe('existing_customer');
  });

  test('the column is NOT NULL in the schema, not merely validated in code', () => {
    const migration = fs.readFileSync(
      require.resolve('../../scripts/migrations/021_crm.sql'),
      'utf8'
    );
    expect(migration).toMatch(/source\s+VARCHAR\(32\)\s+NOT NULL/);
  });
});

describe('the suppression list', () => {
  test('stores a hash and no address', () => {
    const migration = fs.readFileSync(require.resolve('../../scripts/migrations/021_crm.sql'), 'utf8');
    const table = migration.slice(
      migration.indexOf('CREATE TABLE crm_suppressions'),
      migration.indexOf('CREATE TABLE crm_leads')
    );
    expect(table).toMatch(/email_hash\s+CHAR\(64\)/);
    // A suppression list holding plaintext addresses is a mailing list of people who
    // specifically asked not to be mailed.
    expect(table).not.toMatch(/email\s+VARCHAR|address\s+VARCHAR/);
  });

  test('has no foreign key to the leads it protects', () => {
    // THE POINT OF THE WHOLE TABLE. Deleting a lead is exactly how the reference would
    // lose the fact that its subject asked to be left alone, and the next import would
    // write them straight back in.
    const migration = fs.readFileSync(require.resolve('../../scripts/migrations/021_crm.sql'), 'utf8');
    const table = migration.slice(
      migration.indexOf('CREATE TABLE crm_suppressions'),
      migration.indexOf('CREATE TABLE crm_leads')
    );
    expect(table).not.toMatch(/REFERENCES crm_leads/);
  });

  test('nothing anywhere deletes from it', () => {
    for (const modulePath of ['../../models/CrmSuppression', '../../models/CrmLead', '../../routes/crm']) {
      expect(sqlOf(modulePath)).not.toMatch(/DELETE FROM crm_suppressions/i);
    }
    expect(typeof CrmSuppression.remove).toBe('undefined');
    expect(typeof CrmSuppression.delete).toBe('undefined');
  });

  test('normalises an address the same way User does, so a check cannot miss', () => {
    // Trim and lowercase, nothing else. Gmail dots are PRESERVED: any normalisation that
    // differs between the suppress path and the check path makes a suppression silently
    // fail.
    expect(CrmSuppression.normaliseEmail('  Jane@Acme.Example ')).toBe('jane@acme.example');
    expect(CrmSuppression.normaliseEmail('a.b@gmail.com')).toBe('a.b@gmail.com');
    expect(CrmSuppression.hashOf('JANE@acme.example')).toBe(CrmSuppression.hashOf('jane@acme.example'));
    expect(CrmSuppression.hashOf('a.b@gmail.com')).not.toBe(CrmSuppression.hashOf('ab@gmail.com'));
  });

  test('a hash is a sha-256 hex digest, and empty input hashes to nothing', () => {
    expect(CrmSuppression.hashOf('x@y.dev')).toMatch(/^[0-9a-f]{64}$/);
    expect(CrmSuppression.hashOf('')).toBeNull();
    expect(CrmSuppression.hashOf(null)).toBeNull();
  });

  test('unsubscribing writes the suppression in the SAME transaction as the status', () => {
    // Two calls would leave a window in which the status says "leave them alone" and the
    // list does not — and the list is the half that survives a deletion.
    const model = sqlOf('../../models/CrmLead');
    const fn = model.slice(model.indexOf('static async setStatus'), model.indexOf('static async addActivity'));
    expect(fn).toMatch(/INSERT IGNORE INTO crm_suppressions/);
    expect(fn).toMatch(/withTransaction/);
  });

  test('the model refuses a suppressed address rather than flagging it', () => {
    // A row that exists appears in an export, gets assigned, and eventually gets written
    // to by whoever did not read the flag.
    const model = codeOf('../../models/CrmLead');
    const fn = model.slice(model.indexOf('static async upsert'), model.indexOf('static async setStatus'));
    expect(fn).toMatch(/CrmSuppression\.has/);
    expect(fn).toMatch(/fail\(/);
  });
});

describe('normaliseLead', () => {
  test('refuses a nameless company', () => {
    expect(() => CrmLead.normaliseLead({ ...VALID, company: '' })).toThrow(/company/i);
  });

  test('refuses an address it could not write to', () => {
    expect(() => CrmLead.normaliseLead({ ...VALID, contact_email: 'nope' })).toThrow(/address/i);
  });

  test('allows a lead with no email at all', () => {
    const { contact_email, ...noEmail } = VALID;
    expect(contact_email).toBeTruthy();
    expect(CrmLead.normaliseLead({ ...noEmail, contact_phone: '+49 30 0000' }).contact_email).toBeNull();
  });

  test('refuses a country rather than truncating it', () => {
    expect(CrmLead.normaliseLead({ ...VALID, country: 'DEU' }).country).toBeNull();
    expect(CrmLead.normaliseLead({ ...VALID, country: 'de' }).country).toBe('DE');
  });

  test('drops a URL whose scheme could execute', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      expect(CrmLead.normaliseLead({ ...VALID, website: bad }).website).toBeNull();
    }
    expect(CrmLead.normaliseLead({ ...VALID, website: 'acme.example' }).website).toBe('https://acme.example/');
  });

  test('writes only the columns the table has', () => {
    const out = CrmLead.normaliseLead({ ...VALID, status: 'won', owner_user_id: 9, id: 3 });
    expect(out).not.toHaveProperty('status');
    expect(out).not.toHaveProperty('owner_user_id');
    expect(out).not.toHaveProperty('id');
  });
});

describe('the one filter builder', () => {
  test('feeds the list, the count, the export AND the bulk delete', () => {
    // That last one is why the rule exists: a bulk delete and the screen that showed what
    // it would delete must provably target the same rows.
    const model = codeOf('../../models/CrmLead');
    for (const fn of ['list', 'deleteFiltered', 'exportRows']) {
      const start = model.indexOf(`static async ${fn}`);
      const body = model.slice(start, start + 900);
      expect(body).toMatch(/CrmLead\.buildFilter/);
    }
  });

  test('escapes LIKE metacharacters', () => {
    const { params } = CrmLead.buildFilter({ q: '50%' });
    expect(params[0]).toBe('%50\\%%');
  });

  test('ignores an unknown status or source rather than matching it literally', () => {
    expect(CrmLead.buildFilter({ status: 'deleted' }).clause).toBe('1 = 1');
    expect(CrmLead.buildFilter({ source: 'scraped' }).clause).toBe('1 = 1');
  });

  test('is parameterised', () => {
    const { clause, params } = CrmLead.buildFilter({ q: "o'brien", country: "de' OR 1=1 --" });
    expect(clause).not.toMatch(/o'brien|1=1/);
    expect(params).toContain('DE');
  });
});

describe('the bulk interlock', () => {
  test('is ported from the reference deliberately', () => {
    // Most of what this codebase takes from there it takes as a correction. This one it
    // got right: bulk-delete takes an expectedCount and refuses on a mismatch.
    // sqlOf, not codeOf: the error code and the SQL are string literals, which codeOf
    // strips on purpose when it is scanning for identifiers.
    const model = sqlOf('../../models/CrmLead');
    const fn = model.slice(model.indexOf('static async deleteFiltered'), model.indexOf('static async exportRows'));
    expect(fn).toMatch(/expectedCount/);
    expect(fn).toMatch(/BULK_COUNT_MISMATCH/);
    // The count and the delete run inside one transaction, or the check is decorative.
    expect(fn).toMatch(/withTransaction/);
  });

  test('the route surfaces a mismatch as a 409 and changes nothing', () => {
    const route = sqlOf('../../routes/crm');
    expect(route).toMatch(/BULK_COUNT_MISMATCH/);
    expect(route).toMatch(/status\(409\)/);
  });
});

describe('nothing sends', () => {
  test('no route or model calls the mailer', () => {
    for (const modulePath of ['../../routes/crm', '../../models/CrmLead', '../../models/CrmDraft', '../../utils/outreachDrafting']) {
      const code = codeOf(modulePath);
      expect(code).not.toMatch(/utils\/email|email\.send|resend|sendMail|transporter/i);
    }
  });

  test('there is no queue and no scheduler', () => {
    const route = codeOf('../../routes/crm');
    expect(route).not.toMatch(/setInterval|setTimeout|cron|queue/i);
  });

  test('the sent marker is named for what it is', () => {
    // A note somebody made, not a delivery receipt.
    const migration = fs.readFileSync(require.resolve('../../scripts/migrations/021_crm.sql'), 'utf8');
    expect(migration).toMatch(/marked_sent_at/);
    expect(migration).not.toMatch(/delivered_at|sent_status/);
  });
});

describe('outreach drafting', () => {
  const GOOD =
    'We run Salesforce Hub, a marketplace where companies hiring Salesforce consultants meet '
    + 'people looking for contract work. Given the kind of work your team does, it may be worth '
    + 'knowing that posting a role costs nothing and the consultant directory is open to browse '
    + 'without an account. Would it be worth a short conversation about whether that fits how you hire?';

  test('the model is handed no personal detail', () => {
    // Not the name, not the address, not the phone number. None of it improves a first
    // paragraph, and all of it would be somebody's contact details leaving for a third party.
    const facts = outreach.factsFor({
      company: 'Acme GmbH',
      job_title: 'CTO',
      country: 'DE',
      contact_name: 'Jane Roe',
      contact_email: 'jane@acme.example',
      contact_phone: '+49 30 0000'
    });
    expect(facts).toContain('Acme GmbH');
    expect(facts).not.toMatch(/Jane|jane@|\+49/);
  });

  test('accepts a plain, honest draft', () => {
    expect(outreach.problemsWith(GOOD)).toEqual([]);
  });

  test('rejects a claimed familiarity', () => {
    // "I saw your recent post about..." is a lie in a first line, and the one that gets an
    // address blocked.
    for (const opener of [
      'I saw your recent work. ',
      'I noticed your team is growing. ',
      'Congratulations on the funding. ',
      'As a fellow Salesforce person, '
    ]) {
      expect(outreach.problemsWith(opener + GOOD).length).toBeGreaterThan(0);
    }
  });

  test('rejects any figure at all', () => {
    // It was handed none, so any it wrote are invented.
    expect(outreach.problemsWith(GOOD.replace('nothing', 'nothing for 30 days'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/figures it was never given/)])
    );
  });

  test('rejects a commitment, from the same list the quote verifier uses', () => {
    expect(outreach.problemsWith(GOOD.replace('costs nothing', 'is guaranteed free'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/commitment/)])
    );
  });

  test('rejects a placeholder and an unreadable length', () => {
    expect(outreach.problemsWith(GOOD.replace('your team', '[their team]')).length).toBeGreaterThan(0);
    expect(outreach.problemsWith('Hi.').length).toBeGreaterThan(0);
    expect(outreach.problemsWith(`${GOOD} ${GOOD} ${GOOD}`).length).toBeGreaterThan(0);
  });

  test('spend goes to the shared ledger and the shared cap', () => {
    const code = codeOf('../../utils/outreachDrafting');
    expect(code).toMatch(/ApiUsage\.record/);
    expect(code).toMatch(/assertWithinBudget/);
  });

  test('a refusal is checked before the content is read', () => {
    // A refusal comes back as an HTTP 200.
    const code = sqlOf('../../utils/outreachDrafting');
    expect(code.indexOf('stop_reason')).toBeLessThan(code.indexOf('response.content'));
  });
});

describe('the CSV import', () => {
  const CSV =
    'Company,Contact Name,Email,Job Title\n'
    + '"Acme, Inc",Jane Roe,JANE@acme.example,"Head of IT"\n'
    + 'Beta Ltd,John Doe,john@beta.dev,CTO\n'
    + ',Nobody,broken-email,Dev\n'
    + 'Gamma,Dup,jane@acme.example,Ops\n';

  const OPTIONS = { source: 'public_directory', sourceDetail: 'DACH partner directory' };

  test('handles quoted fields, embedded commas and embedded newlines', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']]);
    expect(parseCsv('a,"line1\nline2",c')).toEqual([['a', 'line1\nline2', 'c']]);
    expect(parseCsv('a,"say ""hi""",c')).toEqual([['a', 'say "hi"', 'c']]);
    expect(parseCsv('a,b\r\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
    // A trailing newline is not an empty row.
    expect(parseCsv('a,b\n')).toEqual([['a', 'b']]);
  });

  test('strips a byte-order mark, so the first header still matches', () => {
    expect(parseCsv('﻿Company,Email')[0][0]).toBe('Company');
  });

  test('refuses to read anything without a source', () => {
    expect(() => readLeads(CSV, {})).toThrow(/where this file came from/i);
    expect(() => readLeads(CSV, { source: 'public_directory' })).toThrow(/specifically/i);
  });

  test('stamps the source on every row from the screen, never from the file', () => {
    // A source column inside a spreadsheet is a source nobody checked.
    const withSourceColumn = 'Company,Email,Source\nAcme,a@b.dev,they-asked-us\n';
    const out = readLeads(withSourceColumn, OPTIONS);
    expect(out.candidates[0].lead.source).toBe('public_directory');
    expect(out.columns).not.toContain('source');
  });

  test('names each row\'s problems instead of reporting a total afterwards', () => {
    const out = readLeads(CSV, OPTIONS);
    const byLine = Object.fromEntries(out.candidates.map((c) => [c.line, c.problems]));
    expect(byLine[2]).toEqual([]);
    expect(byLine[3]).toEqual([]);
    expect(byLine[4]).toEqual(expect.arrayContaining(['no company name', 'the email is not an address']));
    expect(byLine[5]).toEqual(['duplicate of line 2 in this file']);
  });

  test('numbers lines as a spreadsheet does', () => {
    // Line 1 is the header, so the first data row is line 2 — the number somebody can
    // actually find in their file.
    expect(readLeads(CSV, OPTIONS).candidates[0].line).toBe(2);
  });

  test('lower-cases addresses so the unique key and the suppression check agree', () => {
    expect(readLeads(CSV, OPTIONS).candidates[0].lead.contact_email).toBe('jane@acme.example');
  });

  test('refuses a file whose columns it does not recognise, naming what it found', () => {
    expect(() => readLeads('Foo,Bar\n1,2\n', OPTIONS)).toThrow(/"Foo", "Bar"/);
  });

  test('refuses a file with no rows under the header', () => {
    expect(() => readLeads('Company,Email\n', OPTIONS)).toThrow(/no rows/i);
  });

  test('caps how much is read, and says so', () => {
    const many = ['Company,Email', ...Array.from({ length: 900 }, (_, i) => `Co${i},a${i}@b.dev`)].join('\n');
    const out = readLeads(many, OPTIONS);
    expect(out.candidates).toHaveLength(crm.LIMITS.importRows);
    expect(out.truncated).toBe(true);
    expect(out.totalInFile).toBe(900);
  });

  test('writes nothing — it only reads', () => {
    const code = codeOf('../../utils/crmImport');
    expect(code).not.toMatch(/INSERT|UPDATE|promisePool|database/i);
  });

  test('the write step re-parses rather than trusting a posted row set', () => {
    // Otherwise the browser would be choosing what gets written, including the source.
    const route = sqlOf('../../routes/crm');
    const fn = route.slice(route.indexOf("'/import',"), route.indexOf("'/export.csv'"));
    expect(fn).toMatch(/readLeads\(csv/);
  });
});

describe('the CSV export', () => {
  test('neutralises a cell that a spreadsheet would execute', () => {
    // =HYPERLINK(...) in a company name is a real injection path out of an export, and the
    // reference does not guard it.
    const route = sqlOf('../../routes/crm');
    expect(route).toMatch(/\^\[=\+\\-@/);
  });

  test('goes through the same builder the screen used', () => {
    const route = sqlOf('../../routes/crm');
    const fn = route.slice(route.indexOf("'/export.csv'"), route.indexOf("'/suppressions'"));
    expect(fn).toMatch(/CrmLead\.exportRows\(filtersFrom/);
  });
});

describe('access', () => {
  test('the whole area is superadmin-gated', () => {
    const route = codeOf('../../routes/crm');
    expect(route).toMatch(/router\.use\(isAuthenticated, isSuperadmin\)/);
  });

  test('every :id is validated', () => {
    // parseInt('44.map') is 44.
    const route = sqlOf('../../routes/crm');
    const idRoutes = route.match(/router\.(get|post)\(\s*'\/:id[^']*'/g) || [];
    expect(idRoutes.length).toBeGreaterThan(3);
    expect((route.match(/requireIdParam\('id'\)/g) || []).length).toBeGreaterThanOrEqual(idRoutes.length);
  });
});
