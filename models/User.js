'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { promisePool, withTransaction } = require('../config/database');
const config = require('../config/config');
const { containsPattern } = require('../utils/likePattern');
const ConsultantProfile = require('./ConsultantProfile');

/**
 * Roles the public registration form is allowed to create.
 *
 * This is a security boundary, not a UI convenience. In the reference implementation,
 * before this filter existed, a hand-crafted `user_types[]` POST created a privileged
 * account with no approval step. The filter is an allowlist for that reason, and
 * `addSelfServiceRoles` unions rather than replaces, so nothing here can remove a role or
 * grant a privileged flag.
 *
 * `admin` is the whole of what this list withholds, and it is enough: an admin reads
 * private circumstances on `/admin/tax-advisory`, individual day rates beside the people
 * who gave them on `/admin/rates`, and the contact details of people who never asked to be
 * contacted on `/crm`.
 *
 * `recruiter` IS self-service, deliberately. A recruiter account can do what a company
 * account can already do — advertise roles and read the consultant directory — so gating it
 * behind support would make the role dead on arrival without protecting anything.
 *
 * This comment used to say the line was `partner`, "the role that carries a commission
 * rate". That was true of the reference and never true here: the referral rate comes from
 * `config/referrals.js` for every account that enrols, and `is_partner` was read by nothing
 * at all. Migration 027 removed it. Documentation that is wrong is more dangerous than
 * documentation that is missing, because a security argument standing on it looks
 * load-bearing.
 *
 * Anyone adding a role here: ask whether it grants access somebody else pays for.
 */
const PUBLIC_ROLES = Object.freeze(['consultant', 'company', 'recruiter']);
const ALL_ROLES = Object.freeze(['consultant', 'company', 'recruiter', 'admin']);

const ROLE_FLAG_COLUMN = Object.freeze({
  consultant: 'is_consultant',
  company: 'is_company',
  recruiter: 'is_recruiter'
});

/**
 * Canonical email form used by EVERY route that looks a user up.
 *
 * Deliberately conservative: trim and lowercase, nothing else. In particular Gmail dots
 * are PRESERVED. Any normalisation that differs between the registration route and the
 * login route forks accounts — a user registers as `a.b@gmail.com` and can then never
 * sign in because login looked up `ab@gmail.com`.
 */
function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Union the submitted roles with the roles the user already holds.
 *
 * The self-service roles form is ADD-ONLY by design: a form post can never remove a
 * role, and can never demote an admin. Removing a role is an admin-only operation
 * (`User.adminSetRoles`). Pure function so the rule is unit-testable.
 */
function unionRoles(currentRoles, submittedRoles, { allowed = PUBLIC_ROLES } = {}) {
  const current = new Set((currentRoles || []).filter((r) => ALL_ROLES.includes(r)));
  for (const role of submittedRoles || []) {
    if (allowed.includes(role)) current.add(role);
  }
  return ALL_ROLES.filter((r) => current.has(r));
}

/**
 * Pick the primary `user_type` for a role set.
 * An existing primary role is always kept: promotion is explicit, never a side effect
 * of ticking a checkbox.
 */
function resolvePrimaryRole(roles, existingPrimary = null) {
  if (existingPrimary && roles.includes(existingPrimary)) return existingPrimary;
  if (existingPrimary === 'admin') return 'admin';
  return roles[0] || 'consultant';
}

/**
 * The primary `user_type` for an ADMIN role change.
 *
 * `admin` exists only as a primary type — there is no `is_admin` flag — so a role set that
 * includes it must make it primary. Left to `resolvePrimaryRole`, ticking "consultant" and
 * "admin" together picked the first in taxonomy order, `consultant`, and the admin role a
 * superadmin had just granted was silently dropped.
 */
function adminPrimaryRole(roles, requested = null) {
  if (requested && roles.includes(requested)) return requested;
  if (roles.includes('admin')) return 'admin';
  return resolvePrimaryRole(roles);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

class User {
  static get PUBLIC_ROLES() {
    return PUBLIC_ROLES;
  }

  static get ALL_ROLES() {
    return ALL_ROLES;
  }

  static normaliseEmail = normaliseEmail;

  static unionRoles = unionRoles;

  static resolvePrimaryRole = resolvePrimaryRole;

  static adminPrimaryRole = adminPrimaryRole;

  static hashToken = hashToken;

  /**
   * Create a user.
   *
   * `consent` is intentionally optional and intentionally NOT defaulted. Only the
   * public registration route passes it, carrying the exact policy versions the person
   * actually accepted. Admin creation, seeds and tests pass nothing, because consent
   * must never be fabricated on someone's behalf.
   */
  static async create({ email, password, name, roles, consent = null, gender = null, dateOfBirth = null, signupIp = null, signupCountry = null }) {
    const normalisedEmail = normaliseEmail(email);
    const requestedRoles = unionRoles([], roles, { allowed: ALL_ROLES });
    const finalRoles = requestedRoles.length ? requestedRoles : ['consultant'];
    const primary = resolvePrimaryRole(finalRoles);
    const passwordHash = await bcrypt.hash(password, config.security.bcryptRounds);

    const flags = {
      is_consultant: finalRoles.includes('consultant') ? 1 : 0,
      is_company: finalRoles.includes('company') ? 1 : 0,
      is_recruiter: finalRoles.includes('recruiter') ? 1 : 0
    };

    const [result] = await promisePool.query(
      `INSERT INTO users
         (email, password_hash, name, user_type,
          is_consultant, is_company, is_recruiter,
          terms_accepted_at, terms_version, privacy_policy_version,
          gender, date_of_birth, signup_ip, signup_country)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalisedEmail,
        passwordHash,
        String(name).trim(),
        primary,
        flags.is_consultant,
        flags.is_company,
        flags.is_recruiter,
        consent ? new Date() : null,
        consent ? consent.termsVersion : null,
        consent ? consent.privacyVersion : null,
        gender,
        dateOfBirth,
        signupIp,
        signupCountry
      ]
    );

    return User.findById(result.insertId);
  }

  static async findById(id) {
    const [rows] = await promisePool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  static async findByEmail(email) {
    const [rows] = await promisePool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [normaliseEmail(email)]);
    return rows[0] || null;
  }

  static async emailExists(email) {
    const [rows] = await promisePool.query('SELECT 1 FROM users WHERE email = ? LIMIT 1', [normaliseEmail(email)]);
    return rows.length > 0;
  }

  static async verifyPassword(user, password) {
    if (!user || !user.password_hash) return false;
    return bcrypt.compare(String(password), user.password_hash);
  }

  static async updatePassword(userId, password) {
    const hash = await bcrypt.hash(password, config.security.bcryptRounds);
    await promisePool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
  }

  static async recordLogin(userId) {
    await promisePool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [userId]);
  }

  static async markOnboarded(userId) {
    await promisePool.query('UPDATE users SET onboarded_at = NOW() WHERE id = ? AND onboarded_at IS NULL', [userId]);
  }

  static async setEmailVerified(userId) {
    await promisePool.query('UPDATE users SET email_verified = 1 WHERE id = ?', [userId]);
  }

  /** Roles derived from the boolean flags plus the primary type. */
  static rolesOf(userRow) {
    if (!userRow) return [];
    const roles = new Set();
    if (userRow.is_consultant) roles.add('consultant');
    if (userRow.is_company) roles.add('company');
    if (userRow.is_recruiter) roles.add('recruiter');
    if (userRow.user_type === 'admin') roles.add('admin');
    roles.add(userRow.user_type);
    return ALL_ROLES.filter((r) => roles.has(r));
  }

  /**
   * Self-service role update. Add-only, restricted to the public roles.
   * Returns the resulting role list.
   */
  static async addSelfServiceRoles(userId, submittedRoles) {
    return withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
      const user = rows[0];
      if (!user) throw new Error(`No such user: ${userId}`);

      const roles = unionRoles(User.rolesOf(user), submittedRoles, { allowed: PUBLIC_ROLES });
      const primary = resolvePrimaryRole(roles, user.user_type);

      await conn.query(
        `UPDATE users
            SET user_type = ?, is_consultant = ?, is_company = ?, is_recruiter = ?
          WHERE id = ?`,
        [
          primary,
          roles.includes('consultant') ? 1 : 0,
          roles.includes('company') ? 1 : 0,
          // Privileged flags are preserved exactly as they were; a self-service form
          // can neither grant nor revoke them.
          user.is_recruiter,
          userId
        ]
      );
      return roles;
    });
  }

  /** Admin-only: set the exact role set, including removal and privileged roles. */
  static async adminSetRoles(userId, roles, { primary = null } = {}) {
    const finalRoles = ALL_ROLES.filter((r) => (roles || []).includes(r));
    const primaryRole = adminPrimaryRole(finalRoles, primary);

    await promisePool.query(
      `UPDATE users
          SET user_type = ?, is_consultant = ?, is_company = ?, is_recruiter = ?
        WHERE id = ?`,
      [
        primaryRole,
        finalRoles.includes('consultant') ? 1 : 0,
        finalRoles.includes('company') ? 1 : 0,
        finalRoles.includes('recruiter') ? 1 : 0,
        userId
      ]
    );
    return finalRoles;
  }

  static async setActive(userId, isActive) {
    await promisePool.query('UPDATE users SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, userId]);
  }

  static async setSuperadmin(userId, isSuperadmin) {
    await promisePool.query('UPDATE users SET is_superadmin = ? WHERE id = ?', [isSuperadmin ? 1 : 0, userId]);
  }

  /**
   * The session user contract.
   *
   * Rebuilt from the database on EVERY request by `validateActiveAccount`, so a role
   * revoked by an admin takes effect on the very next request rather than whenever the
   * person next signs in.
   */
  static buildSessionUser(userRow, { displayName = null, profilePicture = null } = {}) {
    const roles = User.rolesOf(userRow);
    return {
      id: userRow.id,
      email: userRow.email,
      userType: userRow.user_type,
      roles,
      isConsultant: Boolean(userRow.is_consultant) || userRow.user_type === 'consultant',
      isCompany: Boolean(userRow.is_company) || userRow.user_type === 'company',
      isRecruiter: Boolean(userRow.is_recruiter) || userRow.user_type === 'recruiter',
      isAdmin: userRow.user_type === 'admin' || Boolean(userRow.is_superadmin),
      isSuperadmin: Boolean(userRow.is_superadmin),
      emailVerified: Boolean(userRow.email_verified),
      needsOnboarding: !userRow.onboarded_at,
      name: displayName || userRow.name || String(userRow.email).split('@')[0],
      profilePicture: profilePicture || null
    };
  }

  /*
   * The admin user screen's filter, and the ONLY one: the list and its count both come from
   * it, and so do the ids the bulk erase acts on — a count assembled separately is how a
   * "Showing 20 of 43" footer ends up describing rows the table is not showing.
   *
   * Every value is checked against a fixed vocabulary in the route before it gets here, and
   * re-checked here, so `?status=anything` narrows to nothing surprising.
   */
  static buildAdminFilter({ search = '', role = '', status = '', talent = '' } = {}) {
    const where = [];
    const params = [];

    /*
     * Through likePattern, like every other LIKE here: this one predates it, and a search
     * for `%` was matching every account. A search that is all digits ALSO matches the
     * account id exactly — the id is what an error log, a payment row and an erased
     * account's placeholder address quote, and "47" should find account 47 rather than
     * every address with a 47 in it.
     */
    const term = String(search || '').trim();
    if (term) {
      const like = containsPattern(term);
      if (/^\d{1,10}$/.test(term)) {
        where.push('(u.id = ? OR u.email LIKE ? OR u.name LIKE ?)');
        params.push(Number(term), like, like);
      } else {
        where.push('(u.email LIKE ? OR u.name LIKE ?)');
        params.push(like, like);
      }
    }
    if (role && ALL_ROLES.includes(role)) {
      const column = ROLE_FLAG_COLUMN[role];
      where.push(column ? `(u.user_type = ? OR u.${column} = 1)` : 'u.user_type = ?');
      params.push(role);
    }
    /*
     * "Deleted" is an account `models/AccountErasure.js` has erased: `anonymised_at` is set
     * in the same transaction that destroys the data (migration 023). Such an account is
     * also inactive, but it is a tombstone rather than a person, so Active and Inactive
     * leave it out and only Deleted shows it. With no status chosen every row is listed,
     * as it always was here.
     */
    if (status === 'deleted') where.push('u.anonymised_at IS NOT NULL');
    if (status === 'active') where.push('u.anonymised_at IS NULL AND u.is_active = 1');
    if (status === 'inactive') where.push('u.anonymised_at IS NULL AND u.is_active = 0');
    /*
     * "Listed" is the directory's own rule, imported rather than restated, so it means
     * exactly "a reader of /consultants can find this person". "Hidden" is every consultant
     * account that is not — taken down by us, unpublished by them, or deactivated. A
     * company is neither.
     */
    const listed = `(cp.user_id IS NOT NULL AND ${ConsultantProfile.LISTED_CONDITIONS.join(' AND ')})`;
    if (talent === 'listed') where.push(listed);
    if (talent === 'hidden') where.push(`((u.user_type = 'consultant' OR u.is_consultant = 1) AND NOT ${listed})`);

    return { clause: where.length ? where.join(' AND ') : '1 = 1', params, listed };
  }

  static async list({ search = '', role = '', status = '', talent = '', limit = 20, offset = 0 } = {}) {
    const { clause, params, listed } = User.buildAdminFilter({ search, role, status, talent });
    const joins = `FROM users u
         LEFT JOIN consultant_profiles cp ON cp.user_id = u.id
         LEFT JOIN company_profiles comp ON comp.user_id = u.id`;
    /*
     * The country is the one the member STATED on a profile, never `users.signup_country`.
     * That column is derived from the address a request arrived from and the member has
     * never seen it; showing it under a heading that says "Country" would present a guess
     * as a fact about somebody. A VPN, a holiday and an office abroad all produce the wrong
     * answer, and nobody looking at the screen could tell.
     *
     * `talent_hidden_at` is the moderator's takedown (migration 033), returned so the button
     * reads "put it back" when it should. `anonymised_at` marks an erased account, which is
     * offered no actions at all.
     */
    const [rows] = await promisePool.query(
      `SELECT u.id, u.email, u.name, u.user_type, u.is_consultant, u.is_company, u.is_recruiter,
              u.is_superadmin, u.is_active, u.email_verified, u.created_at, u.last_login_at,
              u.anonymised_at,
              comp.company_name,
              COALESCE(cp.country, comp.country) AS stated_country,
              cp.user_id IS NOT NULL AS has_consultant_profile,
              ${listed} AS talent_listed,
              cp.admin_hidden_at AS talent_hidden_at
         ${joins}
        WHERE ${clause}
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(`SELECT COUNT(*) AS total ${joins} WHERE ${clause}`, params);
    return { rows, total: Number(total) };
  }
}

module.exports = User;
