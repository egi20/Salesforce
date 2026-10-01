'use strict';

const User = require('../../models/User');

describe('role escalation boundary', () => {
  it('public registration can only ever produce the marketplace roles', () => {
    // The hand-crafted POST that created a working privileged account before this
    // filter existed.
    //
    // `recruiter` joined the allowed set when the agency directory was built: a recruiter
    // account can do what a company account can already do, so withholding it would have
    // protected nothing. `admin` is what the list withholds, and it is enough — an admin
    // reads private circumstances on /admin/tax-advisory, individual day rates beside the
    // people who gave them on /admin/rates, and strangers' contact details on /crm.
    //
    // A submitted role that is not in the taxonomy at all is dropped the same way, which is
    // what `partner` became once migration 027 removed it.
    const roles = User.unionRoles([], ['consultant', 'admin', 'recruiter', 'partner'], {
      allowed: User.PUBLIC_ROLES
    });
    expect(roles).toEqual(['consultant', 'recruiter']);
    expect(roles).not.toContain('admin');
    expect(roles).not.toContain('partner');
  });

  it('the self-service form is add-only: an existing role survives an omitted checkbox', () => {
    const roles = User.unionRoles(['consultant', 'company'], ['consultant'], { allowed: User.PUBLIC_ROLES });
    expect(roles).toContain('company');
  });

  it('a self-service post cannot demote an admin', () => {
    const roles = User.unionRoles(['consultant', 'admin'], ['company'], { allowed: User.PUBLIC_ROLES });
    expect(roles).toContain('admin');
    expect(roles).toContain('consultant');
    expect(roles).toContain('company');
  });

  it('ignores unknown role names entirely', () => {
    expect(User.unionRoles([], ['superuser', 'root'], { allowed: User.ALL_ROLES })).toEqual([]);
  });

  it('returns roles in a stable canonical order', () => {
    const a = User.unionRoles([], ['company', 'consultant'], { allowed: User.ALL_ROLES });
    const b = User.unionRoles([], ['consultant', 'company'], { allowed: User.ALL_ROLES });
    expect(a).toEqual(b);
  });
});

describe('resolvePrimaryRole', () => {
  it('keeps an existing primary role rather than reordering it', () => {
    expect(User.resolvePrimaryRole(['consultant', 'company'], 'company')).toBe('company');
  });

  it('keeps admin as primary even when it is not in the new list', () => {
    expect(User.resolvePrimaryRole(['consultant'], 'admin')).toBe('admin');
  });

  it('falls back to the first role, then to consultant', () => {
    expect(User.resolvePrimaryRole(['company'])).toBe('company');
    expect(User.resolvePrimaryRole([])).toBe('consultant');
  });
});

describe('normaliseEmail', () => {
  it('trims and lowercases', () => {
    expect(User.normaliseEmail('  Ana.Berisha@Example.COM ')).toBe('ana.berisha@example.com');
  });

  it('preserves Gmail dots, so registration and login cannot disagree', () => {
    expect(User.normaliseEmail('a.b.c@gmail.com')).toBe('a.b.c@gmail.com');
  });

  it('handles nullish input', () => {
    expect(User.normaliseEmail(null)).toBe('');
    expect(User.normaliseEmail(undefined)).toBe('');
  });
});

describe('rolesOf and buildSessionUser', () => {
  const row = {
    id: 5,
    email: 'x@example.com',
    name: 'Ana Berisha',
    user_type: 'admin',
    is_consultant: 1,
    is_company: 0,
    is_recruiter: 0,
    is_superadmin: 0,
    email_verified: 1,
    onboarded_at: null
  };

  it('derives roles from the flags plus the primary type', () => {
    expect(User.rolesOf(row)).toEqual(['consultant', 'admin']);
  });

  it('sets isConsultant for a dual-role admin, so consultant guards do not refuse them', () => {
    const session = User.buildSessionUser(row);
    expect(session.isConsultant).toBe(true);
    expect(session.isAdmin).toBe(true);
    expect(session.needsOnboarding).toBe(true);
  });

  it('falls back to the email local part when there is no name', () => {
    const session = User.buildSessionUser({ ...row, name: null });
    expect(session.name).toBe('x');
  });
});

describe('the partner role is gone, and nothing still writes to it', () => {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..', '..');

  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.(js|ejs)$/.test(e.name) ? [full] : [];
    });
  }

  const sources = ['models', 'routes', 'views', 'services', 'middleware', 'config']
    .flatMap((d) => walk(path.join(ROOT, d)));

  /*
   * Comments are stripped first. Twice before, a test in this repo matched the prose
   * explaining a rule rather than any code breaking it — and the fix is not to stop
   * explaining, it is to scan what runs. The comment in `models/User.js` saying why the
   * column went is exactly the thing worth keeping.
   */
  function codeOf(file) {
    return fs.readFileSync(file, 'utf8')
      .replace(/<%#[\s\S]*?%>/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('no query names the column migration 027 dropped', () => {
    /*
     * This is the `billingDetailsFor` failure made impossible rather than remembered.
     *
     * That method selected `u.first_name, u.last_name` — columns that had never existed —
     * from inside the transaction every invoice is raised in, and nothing caught it because
     * the suite mocked the database so the query never ran. A dropped column is the same
     * shape of mistake arriving from the other direction: the name reads fine, and MySQL
     * answers ER_BAD_FIELD_ERROR the first time somebody exports their data or closes their
     * account.
     */
    const offenders = sources
      .filter((f) => /is_partner|isPartner/.test(codeOf(f)))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('is not a role the taxonomy knows', () => {
    expect(User.ALL_ROLES).not.toContain('partner');
    expect(User.PUBLIC_ROLES).not.toContain('partner');
  });

  it('and a submitted `partner` is dropped like any other unknown role', () => {
    expect(User.unionRoles([], ['partner'], { allowed: User.PUBLIC_ROLES })).toEqual([]);
  });
});
