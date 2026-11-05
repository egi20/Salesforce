'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ConsultantProfile = require('../../models/ConsultantProfile');
const AccountErasure = require('../../models/AccountErasure');
const { VIEW_HELPERS } = require('../../utils/viewHelpers');
const { consultantRate } = require('../../utils/jobDisplay');
const { shortCertificationName, certificationLabel, ALL_CERTIFICATIONS } = require('../../config/certifications');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('Browse Talent filters go through the one builder', () => {
  test('a checkbox group is "any of these", and groups combine with AND', () => {
    const { clause, params } = ConsultantProfile.buildFilter({ country: ['IT', 'DE'], seniority: ['senior'] });
    expect(clause).toContain('cp.country IN (?)');
    expect(clause).toContain('cp.seniority IN (?)');
    expect(params).toEqual(expect.arrayContaining([['IT', 'DE'], ['senior']]));
  });

  test('a scalar still works, for the hubs and the search page', () => {
    const { clause, params } = ConsultantProfile.buildFilter({ country: 'IT' });
    expect(clause).toContain('cp.country IN (?)');
    expect(params).toContainEqual(['IT']);
  });

  test('clouds, official certifications and minimum years each narrow the list', () => {
    const { clause, params } = ConsultantProfile.buildFilter({
      clouds: ['data-cloud', 'not-a-cloud'],
      certifications: ['Salesforce Certified Platform Developer I', 'Something I typed'],
      min_years: '5'
    });
    expect(clause).toContain('consultant_clouds fcl');
    expect(clause).toContain('consultant_certifications fcc');
    expect(clause).toContain('cp.years_experience >= ?');
    // Anything not in the catalogue is dropped, not matched.
    expect(params).toContainEqual(['data-cloud']);
    expect(params).toContainEqual(['Salesforce Certified Platform Developer I']);
    expect(params).toContain(5);
  });

  test('a shortlist narrows and never widens: the listing rules and the hidden-company block still apply', () => {
    const viewer = { companyUserId: 7, companyNameKey: 'northwind' };
    const { clause, params } = ConsultantProfile.buildFilter({ viewer, shortlisted_by: 7 });
    for (const c of ConsultantProfile.LISTED_CONDITIONS) expect(clause).toContain(c);
    expect(clause).toContain('consultant_hidden_companies');
    expect(clause).toContain('company_shortlists');
    expect(params).toContain(7);
  });

  test('the facet counts leave out their own group, like /jobs', () => {
    const model = read('models/ConsultantProfile.js');
    expect(model).toContain('buildFilter({ ...filters, [field]: undefined })');
    expect(model).toContain('buildFilter({ ...filters, min_years: undefined })');
  });

  test('the route adds no WHERE clause of its own', () => {
    const route = read('routes/consultants.js').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(route).not.toMatch(/\bWHERE\b|SELECT\s/);
    expect(route).not.toContain('buildFilter(');
  });
});

describe('the card says only what is stored', () => {
  test('a hidden rate is never printed, and a visible one reads "€763 / day"', () => {
    expect(consultantRate({ rate_visible: 0, day_rate: 763, currency: 'EUR' })).toBeNull();
    expect(consultantRate({ rate_visible: 1, day_rate: 763, currency: 'EUR' })).toBe('€763 / day');
    expect(consultantRate({ rate_visible: 1, day_rate: null, hourly_rate: 95, currency: 'GBP' })).toBe('£95 / hour');
    expect(consultantRate({ rate_visible: 1, currency: 'EUR' })).toBeNull();
  });

  test('every official certification has a short form and a label without the shared prefix', () => {
    for (const name of ALL_CERTIFICATIONS) {
      expect(shortCertificationName(name)).toBeTruthy();
      expect(certificationLabel(name)).not.toMatch(/^Salesforce Certified /);
    }
    expect(shortCertificationName('Salesforce Certified Platform Developer I')).toBe('PD1');
    expect(shortCertificationName('Salesforce Certified Sales Cloud Consultant')).toBe('Sales Cloud Consultant');
  });

  const render = (c, extra = {}) =>
    ejs.render(read('views/partials/consultant-card.ejs'), {
      ...VIEW_HELPERS,
      c,
      currentUser: null,
      currentPath: '/consultants',
      csrfToken: 't',
      ...extra
    });
  const base = {
    user_id: 3,
    name: 'Ana Pjetri',
    primary_role: 'cpq-consultant',
    seniority: 'senior',
    years_experience: 9,
    country: 'IT',
    rate_visible: 1,
    day_rate: 763,
    currency: 'EUR',
    availability: 'immediate',
    bio: '<p>Quote-to-cash on three continents.</p>',
    certifications: [
      'Salesforce Certified Sales Cloud Consultant',
      'Salesforce Certified Platform Developer I',
      'Salesforce Certified Administrator'
    ]
  };

  test('professional title, years, full country, rate, certifications and initials', () => {
    const html = render(base);
    expect(html).toContain('Senior CPQ &amp; Billing Consultant');
    expect(html).toContain('9 years experience · Italy');
    expect(html).toContain('€763 / day');
    expect(html).toContain('Sales Cloud Consultant · PD1');
    expect(html).toContain('+1');
    expect(html).toContain('>AP<');
    expect(html).not.toContain('&lt;p&gt;');
  });

  test('a private rate reads "Rate on request" and no figure reaches the markup', () => {
    const html = render({ ...base, rate_visible: 0, day_rate: null });
    expect(html).toContain('Rate on request');
    expect(html).not.toContain('/ day');
  });

  test('badges appear only when there is something behind them', () => {
    expect(render(base)).not.toContain('LinkedIn verified');
    expect(render(base)).not.toContain('Trailhead');
    const html = render({ ...base, linkedin_verified: 1, has_trailhead: 1, trailhead_rank: 'Ranger' });
    expect(html).toContain('LinkedIn verified');
    expect(html).toContain('Trailhead · Ranger');
  });

  test('Shortlist and Invite are offered only to an account that can use them', () => {
    const visitor = render(base);
    expect(visitor).not.toContain('data-shortlist');
    expect(visitor).not.toContain('Invite to apply');
    const company = render(base, { currentUser: { id: 9, isCompany: true }, shortlistedIds: new Set([3]), canInvite: true });
    expect(company).toContain('data-shortlist');
    expect(company).toContain('Shortlisted');
    expect(company).toContain('/consultants/3#approach');
  });
});

describe('a shortlist is private and goes with either account', () => {
  test('migration 041 keys it on the company and cascades from both users', () => {
    const sql = read('scripts/migrations/041_company_shortlists.sql');
    expect(sql).toMatch(/PRIMARY KEY \(user_id, consultant_user_id\)/);
    expect((sql.match(/ON DELETE CASCADE/g) || []).length).toBe(2);
    expect(sql).not.toMatch(/\bTIMESTAMP\b/);
  });

  test('erasure removes the company list and every entry naming the erased consultant', () => {
    expect(AccountErasure.PURGE).toContain('company_shortlists');
    expect(AccountErasure.PURGE_AS_SUBJECT).toContainEqual(['company_shortlists', 'consultant_user_id']);
  });

  test('the company can export its own list; nothing else reads the table', () => {
    expect(read('services/dataExport.js')).toContain("company_shortlists: 'user_id'");
    const readers = ['routes', 'services', 'models']
      .flatMap((dir) => fs.readdirSync(path.join(ROOT, dir)).map((f) => `${dir}/${f}`))
      .filter((f) => f.endsWith('.js') && read(f).includes('company_shortlists'));
    expect(readers.sort()).toEqual(
      ['models/AccountErasure.js', 'models/CompanyShortlist.js', 'models/ConsultantProfile.js', 'services/dataExport.js'].sort()
    );
  });

  test('adding is refused for a profile this account cannot see in the directory', () => {
    const route = read('routes/consultants.js');
    expect(route).toMatch(/ConsultantProfile\.count\(\{ viewer, user_ids: \[consultantId\] \}\)\) === 1/);
    expect(route).toMatch(/'\/:id\/shortlist',\s*requireIdParam\('id'\),\s*isHiring,\s*writeLimiter/);
  });
});

describe('the level and the years cannot contradict each other', () => {
  const { seniorityForYears, seniorityFitsYears, SENIORITY_LEVELS } = require('../../config/roleTaxonomy');

  test('the bands are the ones the labels state, with no gap and no overlap', () => {
    for (const level of SENIORITY_LEVELS) {
      const [, min, max] = level.label.match(/\((\d+)-?(\d+)?\+? yrs\)/);
      expect(level.minYears).toBe(Number(min));
      expect(level.maxYears).toBe(max ? Number(max) : Infinity);
    }
    for (let y = 0; y <= 60; y += 1) expect(seniorityForYears(y)).not.toBeNull();
    expect(seniorityForYears(2)).toBe('junior');
    expect(seniorityForYears(3)).toBe('mid');
    expect(seniorityForYears(9)).toBe('senior');
    expect(seniorityForYears(18)).toBe('lead');
  });

  test('"Junior · 18 years" is refused; either one alone is fine', () => {
    expect(seniorityFitsYears('junior', '18')).toBe(false);
    expect(seniorityFitsYears('mid', 10)).toBe(false);
    expect(seniorityFitsYears('senior', 7)).toBe(true);
    expect(seniorityFitsYears('', 18)).toBe(true);
    expect(seniorityFitsYears('lead', '')).toBe(true);
  });

  test('the profile save refuses a mismatched pair, and the seed derives the level from the years', () => {
    expect(read('routes/profile.js')).toMatch(/if \(!seniorityFitsYears\(req\.body\.seniority, req\.body\.years_experience\)\)/);
    const seed = read('scripts/seed-data.js');
    expect(seed).toContain('const seniority = seniorityForYears(years);');
    expect(seed).not.toMatch(/delivering Salesforce projects across Europe/);
  });
});

describe('a visitor is told what the shortlist button does', () => {
  test('signed out, it reads "Sign in to shortlist" and goes to sign-in, coming back to the list', () => {
    const html = ejs.render(read('views/partials/consultant-card.ejs'), {
      ...VIEW_HELPERS,
      c: { user_id: 3, name: 'Ana Pjetri', rate_visible: 1, certifications: [] },
      currentUser: null,
      currentPath: '/consultants?clouds=data-cloud',
      csrfToken: 't'
    });
    expect(html).toContain('Sign in to shortlist');
    expect(html).toContain('/auth/login?redirect=%2Fconsultants%3Fclouds%3Ddata-cloud');
  });

  test('a company with no open role is offered the step before an invitation', () => {
    const html = ejs.render(read('views/partials/consultant-card.ejs'), {
      ...VIEW_HELPERS,
      c: { user_id: 3, name: 'Ana Pjetri', rate_visible: 1, certifications: [] },
      currentUser: { id: 9, isCompany: true },
      currentPath: '/consultants',
      csrfToken: 't',
      shortlistedIds: new Set(),
      canInvite: false
    });
    expect(html).not.toContain('Invite to apply');
    expect(html).toContain('Post a role to invite');
  });

  test('"create a company account" pre-ticks only a public role', () => {
    const route = read('routes/auth.js');
    expect(route).toMatch(/const as = User\.PUBLIC_ROLES\.includes\(req\.query\.as\) \? req\.query\.as : null;/);
  });
});
