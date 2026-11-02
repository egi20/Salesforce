'use strict';

const fs = require('fs');
const path = require('path');

const HiddenCompany = require('../../models/ConsultantHiddenCompany');
const IssueReport = require('../../models/IssueReport');
const issues = require('../../config/issues');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sqlOf = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('hiding a profile from named companies', () => {
  it('the exclusion lives in the filter builder and nowhere else', () => {
    /*
     * THE WHOLE POINT. The reference implementation put its equivalent clause inline in ONE
     * query out of the fourteen that read `consultant_profiles`: its browse list honoured the
     * block and its search, its featured panel and its profile page did not. A privacy
     * promise that holds on one page is the most expensive shape this failure takes.
     *
     * Here the clause is inside `buildFilter`, so every list, count and search gets it by
     * construction — including one somebody adds next year without knowing this exists.
     */
    const model = sqlOf('models/ConsultantProfile.js');
    const occurrences = (model.match(/consultant_hidden_companies/g) || []).length;
    expect(occurrences).toBe(1);

    const builder = model.slice(model.indexOf('function buildFilter'), model.indexOf('class ConsultantProfile'));
    expect(builder).toMatch(/consultant_hidden_companies/);
  });

  it('is expressed exactly twice in the whole codebase, and the second place is named', () => {
    // A list is SQL; a single profile page is a row already fetched and cannot use a WHERE
    // clause. So the rule is stated twice — in the builder, and in `blocks()`. Anywhere else
    // is a third copy nobody will remember to update.
    const files = [];
    for (const dir of ['models', 'routes', 'services']) {
      for (const f of fs.readdirSync(path.join(ROOT, dir))) {
        if (sqlOf(path.join(dir, f)).includes('consultant_hidden_companies')) files.push(`${dir}/${f}`);
      }
    }
    expect(files.sort()).toEqual(['models/ConsultantHiddenCompany.js', 'models/ConsultantProfile.js']);
  });

  it('the detail page applies the block too', () => {
    // Without this a blocked company still opens the profile by URL — which is exactly where
    // a link from a colleague or a search result puts them, so filtering only the lists
    // protects the consultant from browsing and from nothing else.
    const route = sqlOf('routes/consultants.js');
    expect(route).toMatch(/ConsultantHiddenCompany\.blocks/);
    // 404, never 403: "you may not see this consultant" tells the company that a consultant
    // they can name has blocked them, which is what the consultant was hiding.
    const guard = route.slice(route.indexOf('ConsultantHiddenCompany.blocks'));
    expect(guard.slice(0, 200)).toMatch(/404/);
    expect(guard.slice(0, 200)).not.toMatch(/403/);
  });

  it('every consultant list passes a viewer, or says why it does not', () => {
    for (const file of ['routes/consultants.js', 'routes/search.js']) {
      expect(sqlOf(file)).toMatch(/viewerFor/);
    }
    // The homepage used to carry a signed-out consultant panel with no viewer to pass. It
    // is the community feed now and lists no consultants; one added back must pass a viewer.
    const home = read('routes/index.js');
    if (/ConsultantProfile\.browse/.test(home)) expect(home).toMatch(/viewerFor/);
  });

  it('normalises a typed company name so one block is one row', () => {
    const forms = ['Acme Ltd', 'acme ltd', '  ACME   Ltd  ', 'Acme Ltd.'];
    const keys = new Set(forms.map((f) => HiddenCompany.nameKey(f)));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('acme ltd');
  });

  it('a viewer who is not a company filters nothing', () => {
    // A consultant browsing other consultants, or an anonymous visitor, has no company
    // identity — and no clause can ask who an anonymous browser works for.
    expect(HiddenCompany.viewerFor(null)).resolves.toBeNull();
    expect(HiddenCompany.viewerFor({ id: 1, isCompany: false })).resolves.toBeNull();
  });

  it('the schema refuses a row that blocks nothing or blocks two things', () => {
    // Enforced by a CHECK rather than by a comment asking nicely: a row with neither column
    // set blocks nobody, and one with both is two rules pretending to be one.
    const migration = read('scripts/migrations/024_hidden_companies.sql');
    expect(migration).toMatch(/CHECK\s*\(/);
    expect(migration).toMatch(/UNIQUE KEY uq_hidden_registered/);
    expect(migration).toMatch(/UNIQUE KEY uq_hidden_named/);
  });
});

describe('reporting that something is wrong', () => {
  it('passes its boot assertion', () => {
    expect(issues.assertIssueIntegrity()).toBe(true);
  });

  it('every open status can be closed in one step', () => {
    // The same rule config/crm.js asserts for `unsubscribed`: the step somebody skips is the
    // one that closes it.
    for (const status of issues.ISSUE_STATUSES) {
      if (status === 'closed') continue;
      expect(issues.ISSUE_TRANSITIONS[status]).toContain('closed');
    }
    expect(issues.ISSUE_TRANSITIONS.closed).toEqual([]);
  });

  it('refuses a page path that is not a path on this site', () => {
    /*
     * The path is typed by a stranger and lands on an administrator's screen. A full URL here
     * would be an off-site link on an admin page, and an administrator clicking a link
     * somebody else supplied is the oldest trick there is. Rendered as text too — this is the
     * second guard, not the only one.
     */
    expect(IssueReport.pagePath('/jobs/5')).toBe('/jobs/5');
    expect(IssueReport.pagePath('/ok?q=1')).toBe('/ok?q=1');
    for (const bad of ['https://evil.example', '//evil.example', 'javascript:alert(1)', 'not-a-path', 'HTTP://x']) {
      expect(IssueReport.pagePath(bad)).toBeNull();
    }
  });

  it('captures nothing automatically', () => {
    /*
     * No IP, no user agent, no referrer. A bug report is not a reason to start logging
     * visitors, and each of those would need a retention rule and a line in the privacy
     * policy. The reporter types what they want us to have.
     */
    // Comments stripped first: the migration's own prose says "no referrer", and matching
    // that would be the test failing on the sentence that promises the thing it checks.
    const migration = read('scripts/migrations/025_issue_reports.sql').replace(/^\s*--.*$/gm, '');
    for (const column of ['ip_address', 'signup_ip', 'user_agent', 'referrer', 'referer']) {
      expect(migration).not.toMatch(new RegExp(`\\b${column}\\b`, 'i'));
    }
    const model = sqlOf('models/IssueReport.js');
    expect(model).not.toMatch(/req\.(ip|headers)/);
  });

  it('accepts an anonymous report', () => {
    // The most valuable report a marketplace can get comes from somebody who could not finish
    // signing up. Requiring an account to say "registration is broken" loses exactly that.
    expect(read('scripts/migrations/025_issue_reports.sql')).toMatch(/user_id\s+INT UNSIGNED NULL/);
    const route = sqlOf('routes/index.js');
    const handler = route.slice(route.indexOf("router.post(\n  '/report-issue'"), route.indexOf('/my-issues'));
    expect(handler).not.toMatch(/isAuthenticated/);
  });

  it('has no delete, and one filter builder', () => {
    const model = sqlOf('models/IssueReport.js');
    // A dismissed report is evidence somebody complained and nothing happened — the most
    // useful row here the fourth time the same thing arrives.
    expect(model).not.toMatch(/DELETE FROM issue_reports/);
    expect((model.match(/static buildFilter/g) || []).length).toBe(1);
    // And every query is parameterised: the only interpolation permitted is the prebuilt
    // clause of fixed fragments.
    const templates = (model.match(/`[^`]*`/g) || []).filter((t) => /\b(SELECT|INSERT INTO|UPDATE)\b/.test(t));
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) {
      expect((t.match(/\$\{([^}]+)\}/g) || []).filter((i) => i !== '${clause}')).toEqual([]);
    }
  });
});
