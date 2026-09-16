'use strict';

const fs = require('fs');

const RecruiterProfile = require('../../models/RecruiterProfile');
const User = require('../../models/User');
const auth = require('../../middleware/auth');
const { isValidFamily } = require('../../config/cloudFamilies');

function codeOf(modulePath) {
  return fs
    .readFileSync(require.resolve(modulePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const COMPLETE = Object.freeze({
  agency_name: 'Cloud Talent',
  about: 'We place Salesforce consultants across the DACH region.',
  country: 'DE'
});

describe('the recruiter role', () => {
  test('is self-service, and partner still is not', () => {
    // The line is money. A recruiter account can do what a company account can already
    // do; a partner account carries a commission rate, which is what made the reference's
    // `user_types[]=partner` POST a real escalation.
    expect(User.PUBLIC_ROLES).toContain('recruiter');
    expect(User.PUBLIC_ROLES).not.toContain('partner');
    expect(User.PUBLIC_ROLES).not.toContain('admin');
  });

  test('self-service roles can never add a privileged one', () => {
    const roles = User.unionRoles([], ['recruiter', 'partner', 'admin'], { allowed: User.PUBLIC_ROLES });
    expect(roles).toEqual(['recruiter']);
  });

  test('adding a role never removes one', () => {
    const roles = User.unionRoles(['consultant'], ['recruiter'], { allowed: User.PUBLIC_ROLES });
    expect(roles).toEqual(expect.arrayContaining(['consultant', 'recruiter']));
  });

  test('the guard is the shared one, not a copy inside the route', () => {
    // The reference defines its own `isRecruiter` in routes/recruiters.js, so it redirects
    // a background fetch to a login page instead of answering JSON — it does not know
    // about Sec-Fetch-Dest. One copy, one behaviour.
    expect(typeof auth.isRecruiter).toBe('function');
    const code = codeOf('../../routes/recruiters');
    expect(code).toMatch(/require\('\.\.\/middleware\/auth'\)/);
    expect(code).not.toMatch(/const isRecruiter\s*=|function isRecruiter/);
  });

  test('the guard reads the flag, not the primary user type', () => {
    // An admin who is also a recruiter must not be refused a recruiter feature.
    const code = codeOf('../../middleware/auth');
    const guard = code.slice(code.indexOf('function isRecruiter'), code.indexOf('function isAdmin'));
    expect(guard).toMatch(/user\.isRecruiter/);
    expect(guard).not.toMatch(/user_type|userType/);
  });
});

describe('RecruiterProfile.normaliseProfile', () => {
  test('trims and normalises what it keeps', () => {
    const out = RecruiterProfile.normaliseProfile({ ...COMPLETE, agency_name: '  Cloud   Talent  ', country: 'de' });
    expect(out.agency_name).toBe('Cloud Talent');
    expect(out.country).toBe('DE');
  });

  test('refuses a nameless agency', () => {
    expect(() => RecruiterProfile.normaliseProfile({ ...COMPLETE, agency_name: '' })).toThrow(/name/i);
    expect(() => RecruiterProfile.normaliseProfile({ ...COMPLETE, agency_name: 'A' })).toThrow(/name/i);
  });

  test('bounds every field rather than trusting the form', () => {
    // The reference declares express-validator rules on this route and never calls
    // validationResult, so none of them do anything.
    const out = RecruiterProfile.normaliseProfile({
      ...COMPLETE,
      agency_name: 'A'.repeat(5000),
      about: 'b'.repeat(50_000),
      phone: 'c'.repeat(500),
      city: 'd'.repeat(500)
    });
    expect(out.agency_name).toHaveLength(RecruiterProfile.LIMITS.agencyName);
    expect(out.about).toHaveLength(RecruiterProfile.LIMITS.about);
    expect(out.phone).toHaveLength(RecruiterProfile.LIMITS.phone);
    expect(out.city).toHaveLength(RecruiterProfile.LIMITS.city);
  });

  test('accepts a bare domain only by making it absolute', () => {
    // A relative href would send the visitor to /recruiters/example.com on this site
    // rather than to the agency.
    expect(RecruiterProfile.normaliseProfile({ ...COMPLETE, website: 'example.com' }).website)
      .toBe('https://example.com/');
    expect(RecruiterProfile.normaliseProfile({ ...COMPLETE, website: 'https://x.dev/a' }).website)
      .toBe('https://x.dev/a');
  });

  test('drops a URL whose scheme could execute', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:x', 'file:///etc/passwd']) {
      expect(RecruiterProfile.normaliseProfile({ ...COMPLETE, website: bad }).website).toBeNull();
      expect(RecruiterProfile.normaliseProfile({ ...COMPLETE, linkedin_url: bad }).linkedin_url).toBeNull();
    }
  });

  test('keeps only real cloud families as specialisms, de-duplicated and capped', () => {
    const out = RecruiterProfile.normaliseProfile({
      ...COMPLETE,
      specialisms: ['sales-cloud', 'sales-cloud', 'lead-management', 'not-a-cloud', 'agentforce']
    });
    // `lead-management` is a MODULE, not a family — an agency recruits for Service Cloud,
    // not for Omni-Channel Routing.
    expect(out.specialisms).toEqual(['sales-cloud', 'agentforce']);
    for (const value of out.specialisms) expect(isValidFamily(value)).toBe(true);
  });

  test('accepts a single specialism posted as a bare string', () => {
    // One ticked checkbox posts a string, not an array.
    expect(RecruiterProfile.normaliseProfile({ ...COMPLETE, specialisms: 'data-cloud' }).specialisms)
      .toEqual(['data-cloud']);
  });

  test('caps the specialism list', () => {
    const many = RecruiterProfile.SPECIALISM_OPTIONS.map((s) => s.value);
    const out = RecruiterProfile.normaliseProfile({ ...COMPLETE, specialisms: many });
    expect(out.specialisms.length).toBeLessThanOrEqual(RecruiterProfile.LIMITS.specialisms);
  });

  test('rejects a country that is not two letters, rather than truncating one', () => {
    for (const country of ['', 'D', 'DEU', '12']) {
      expect(RecruiterProfile.normaliseProfile({ ...COMPLETE, country }).country).toBeNull();
    }
  });

  test('writes only the columns the table has', () => {
    const out = RecruiterProfile.normaliseProfile({ ...COMPLETE, is_public: 1, user_id: 99, slug: 'mine' });
    expect(out).not.toHaveProperty('is_public');
    expect(out).not.toHaveProperty('user_id');
    expect(out).not.toHaveProperty('slug');
  });
});

describe('the publish gate', () => {
  test('names what is still missing', () => {
    expect(RecruiterProfile.missingForPublish({ agency_name: 'A' })).toEqual(['about', 'country']);
    expect(RecruiterProfile.missingForPublish(null)).toEqual([...RecruiterProfile.REQUIRED_TO_PUBLISH]);
  });

  test('treats whitespace as empty', () => {
    expect(RecruiterProfile.missingForPublish({ agency_name: 'A', about: '   ', country: 'DE' })).toEqual(['about']);
  });

  test('passes a complete profile', () => {
    expect(RecruiterProfile.missingForPublish(RecruiterProfile.normaliseProfile(COMPLETE))).toEqual([]);
  });
});

describe('specialisms coming back from the database', () => {
  test('tolerate an array, a JSON string, and rubbish', () => {
    expect(RecruiterProfile.parseSpecialisms(['sales-cloud'])).toEqual(['sales-cloud']);
    expect(RecruiterProfile.parseSpecialisms('["sales-cloud"]')).toEqual(['sales-cloud']);
    expect(RecruiterProfile.parseSpecialisms('{"a":1}')).toEqual([]);
    expect(RecruiterProfile.parseSpecialisms('not json')).toEqual([]);
    expect(RecruiterProfile.parseSpecialisms(null)).toEqual([]);
  });
});

describe('the routes', () => {
  test('never write from a GET handler', () => {
    // The reference self-heals on both its GETs: `if (!recruiter) createForUser(...)`.
    // A read that inserts cannot be retried safely and creates rows for anyone who looked.
    const code = codeOf('../../routes/recruiters');
    const getBlocks = code.split(/router\.(?=get|post)/).filter((b) => b.startsWith('get'));
    expect(getBlocks.length).toBeGreaterThan(2);
    for (const block of getBlocks) {
      expect(block).not.toMatch(/RecruiterProfile\.(save|setPublic|setLogo|create)/);
    }
  });

  test('the public page re-checks visibility rather than trusting the link', () => {
    const model = codeOf('../../models/RecruiterProfile');
    const findBySlug = model.slice(model.indexOf('static async findBySlug'), model.indexOf('static parseSpecialisms'));
    expect(findBySlug).toMatch(/rp\.is_public = 1/);
    expect(findBySlug).toMatch(/u\.is_active = 1/);
  });

  test('the directory has one builder, and the visibility rule is inside it', () => {
    const model = codeOf('../../models/RecruiterProfile');
    const browse = model.slice(model.indexOf('static async browse'), model.indexOf('static async statsFor'));
    expect(browse).toMatch(/rp\.is_public = 1/);
    expect(browse).toMatch(/u\.is_active = 1/);
    // The same clause feeds the list and the count, so the two cannot disagree.
    expect(browse.match(/\$\{clause\}/g)).toHaveLength(2);
  });

  test('a specialism filter matches the whole value, not a prefix', () => {
    // `LIKE '%sales-cloud%'` would also match a future "sales-cloud-einstein".
    const model = codeOf('../../models/RecruiterProfile');
    expect(model).toMatch(/JSON_CONTAINS\(rp\.specialisms, JSON_QUOTE\(\?\)\)/);
  });

  test('the :slug route is declared last so it cannot shadow the named ones', () => {
    const code = codeOf('../../routes/recruiters');
    expect(code.indexOf("'/:slug'")).toBeGreaterThan(code.indexOf("'/dashboard'"));
    expect(code.indexOf("'/:slug'")).toBeGreaterThan(code.indexOf("'/profile'"));
  });
});
