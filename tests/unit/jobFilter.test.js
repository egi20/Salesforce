'use strict';

const Job = require('../../models/Job');
const ConsultantProfile = require('../../models/ConsultantProfile');

describe('the single job filter builder', () => {
  it('defaults to the public view: open and unexpired', () => {
    const { clause, params } = Job.buildFilter({});
    expect(clause).toContain("j.status = 'open'");
    expect(clause).toContain('j.expires_at IS NULL OR j.expires_at > NOW()');
    expect(params).toEqual([]);
  });

  it('honours an explicit status for owner and admin views', () => {
    const { clause, params } = Job.buildFilter({ status: 'draft', company_user_id: 7 });
    expect(clause).toContain('j.status = ?');
    expect(clause).toContain('j.company_user_id = ?');
    expect(clause).not.toContain('expires_at');
    expect(params).toEqual(['draft', 7]);
  });

  it('drops a role that is not in the taxonomy instead of querying for it', () => {
    const { clause, params } = Job.buildFilter({ role: 'x++-developer' });
    expect(clause).not.toContain('j.role = ?');
    expect(params).toEqual([]);
  });

  it('parameterises every user-supplied value', () => {
    const { clause, params } = Job.buildFilter({
      role: 'apex-developer',
      seniority: 'senior',
      country: 'DE',
      q: "'; DROP TABLE jobs; --"
    });
    expect(clause).not.toContain('DROP TABLE');
    expect(params).toContain("%'; DROP TABLE jobs; --%");
  });

  it('requires ALL of the selected skills, not any', () => {
    const { clause, params } = Job.buildFilter({ skill_ids: [1, 2, 3] });
    expect(clause).toContain('COUNT(DISTINCT js.skill_id) = ?');
    expect(params).toEqual([[1, 2, 3], 3]);
  });

  it('ignores a non-numeric rate filter', () => {
    const { clause } = Job.buildFilter({ rate_min: 'abc' });
    expect(clause).not.toContain('j.rate_max');
  });

  it('produces the same clause for the same filters, which is what makes the bulk interlock sound', () => {
    const filters = { role: 'apex-developer', country: 'DE', seniority: 'senior' };
    expect(Job.buildFilter(filters)).toEqual(Job.buildFilter({ ...filters }));
  });
});

describe('the single consultant filter builder', () => {
  it('always scopes to public profiles on active accounts', () => {
    const { clause } = ConsultantProfile.buildFilter({});
    expect(clause).toContain('cp.is_public = 1');
    expect(clause).toContain('u.is_active = 1');
  });

  it('cannot be persuaded to include hidden profiles', () => {
    const { clause } = ConsultantProfile.buildFilter({ is_public: 0, 'cp.is_public': 0 });
    expect(clause).toContain('cp.is_public = 1');
    expect(clause).not.toContain('cp.is_public = 0');
  });

  it('drops an invalid role', () => {
    const { clause } = ConsultantProfile.buildFilter({ role: 'nope' });
    expect(clause).not.toContain('cp.primary_role = ?');
  });
});

describe('the posted-within window', () => {
  it('filters on when a role APPEARED, not when it was typed', () => {
    // A draft written in March and published in September is a September role to everybody
    // reading the board. `created_at` would put it in March and nobody would ever see it
    // in a freshness filter.
    const { clause, params } = Job.buildFilter({ posted_within_days: 7 });
    expect(clause).toContain('j.published_at IS NOT NULL');
    expect(clause).toContain('j.published_at >= DATE_SUB(NOW(), INTERVAL ? DAY)');
    expect(clause).not.toContain('j.created_at');
    expect(params).toEqual([7]);
  });

  it('parameterises the window rather than building an interval expression', () => {
    const { clause } = Job.buildFilter({ posted_within_days: 30 });
    expect(clause).not.toContain('INTERVAL 30');
  });

  it('is absent entirely when not asked for', () => {
    expect(Job.buildFilter({}).clause).not.toContain('published_at >=');
  });

  it('the route validates the window against a declared list', () => {
    // So the number reaching `INTERVAL ? DAY` is always one of the four we chose, and the
    // form's selected state and the builder's value come from the SAME validated string —
    // the one object goes to `Job.browse` and to `Job.facetByRole`, so a list, its count
    // and its facets cannot end up filtered differently.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'jobs.js'), 'utf8');
    expect(source).toMatch(/const POSTED_WINDOWS = \[/);
    expect(source).toMatch(/POSTED_WINDOWS\.some\(\(w\) => w\.value && w\.value === query\.posted\)/);
    expect(source).toMatch(/posted_within_days: posted \? Number\(posted\) : null/);
  });
});
