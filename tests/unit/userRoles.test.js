'use strict';

const User = require('../../models/User');

describe('role escalation boundary', () => {
  it('public registration can only ever produce the two marketplace roles', () => {
    // The hand-crafted POST that created a working privileged account before this
    // filter existed.
    const roles = User.unionRoles([], ['consultant', 'partner', 'admin', 'recruiter'], {
      allowed: User.PUBLIC_ROLES
    });
    expect(roles).toEqual(['consultant']);
    expect(roles).not.toContain('partner');
    expect(roles).not.toContain('admin');
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
    is_partner: 0,
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
