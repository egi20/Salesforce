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
