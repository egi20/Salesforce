'use strict';

const { promisePool } = require('../config/database');
const User = require('./User');
const ConsultantProfile = require('./ConsultantProfile');
const { QA_ROLES, QA_EMAIL_LIKE, qaEmail } = require('../utils/qaAccounts');

/*
 * The exact flags each QA account holds. Written in full on every repair rather than
 * unioned, so a role somebody granted one of them by hand on /admin/users is taken back
 * on the next run: a QA account is a fixture, and a fixture that drifts tests something
 * nobody chose.
 *
 * The admin is a PLAIN admin and `is_superadmin` is forced to 0 every time. Superadmin is
 * granted from the shell to named people; an account whose password sits in an environment
 * variable must never be one, and a QA admin that could open /admin/finance or /crm would
 * also make every "a plain admin is refused" case pass for the wrong reason.
 */
const FLAGS = Object.freeze({
  consultant: { user_type: 'consultant', is_consultant: 1, is_company: 0, is_recruiter: 0 },
  company: { user_type: 'company', is_consultant: 0, is_company: 1, is_recruiter: 0 },
  recruiter: { user_type: 'recruiter', is_consultant: 0, is_company: 0, is_recruiter: 1 },
  admin: { user_type: 'admin', is_consultant: 0, is_company: 0, is_recruiter: 0 }
});

const DISPLAY_NAME = Object.freeze({
  consultant: 'QA Consultant',
  company: 'QA Company',
  recruiter: 'QA Recruiter',
  admin: 'QA Admin'
});

class QaAccount {
  /**
   * Create or repair the QA account for `role`, idempotently: verified, active, onboarded,
   * the current QA password, the exact flags above and never a superadmin.
   *
   * Every profile row it holds is set NON-PUBLIC on every repair. The company's is created
   * here, hidden, before any page is opened, and that order is load-bearing: GET /jobs/new
   * and GET /profile/company create a company profile on first use, and `company_profiles`
   * defaults to public — so the first run, before this, listed "QA Company" in the public
   * directory. The suite's directory case is what caught it.
   */
  static async ensure(role, password) {
    if (!QA_ROLES.includes(role)) throw new Error(`No QA account for role "${role}".`);
    const email = qaEmail(role);
    let user = await User.findByEmail(email);
    if (!user) {
      // `consent` is not passed, on purpose: nobody accepted the terms on this account's
      // behalf, and CLAUDE.md is explicit that tests and seeds never fabricate it.
      user = await User.create({ email, password, name: DISPLAY_NAME[role], roles: role === 'admin' ? ['admin'] : [role] });
    } else if (!(await User.verifyPassword(user, password))) {
      // Only re-hashed when the variable changed, so a run does not pay for four bcrypt
      // hashes it does not need.
      await User.updatePassword(user.id, password);
    }

    const flags = FLAGS[role];
    await promisePool.query(
      `UPDATE users
          SET user_type = ?, is_consultant = ?, is_company = ?, is_recruiter = ?,
              is_superadmin = 0, is_active = 1, email_verified = 1,
              onboarded_at = COALESCE(onboarded_at, NOW())
        WHERE id = ?`,
      [flags.user_type, flags.is_consultant, flags.is_company, flags.is_recruiter, user.id]
    );

    if (role === 'consultant') {
      await ConsultantProfile.ensureExists(user.id);
      await promisePool.query('UPDATE consultant_profiles SET is_public = 0 WHERE user_id = ?', [user.id]);
    }
    if (role === 'company') {
      // Update first and insert only when there was nothing to update. Never an upsert: the
      // slug is unique too, and an ON DUPLICATE KEY on a slug a real company happened to hold
      // would hide THAT company. A collision here throws, and the run reports it.
      const [hidden] = await promisePool.query('UPDATE company_profiles SET is_public = 0 WHERE user_id = ?', [user.id]);
      if (hidden.affectedRows === 0) {
        await promisePool.query(
          'INSERT INTO company_profiles (user_id, company_name, slug, is_public) VALUES (?, ?, ?, 0)',
          [user.id, DISPLAY_NAME.company, `qa-company-${user.id}`]
        );
      }
    }
    if (role === 'recruiter') {
      await promisePool.query('UPDATE recruiter_profiles SET is_public = 0 WHERE user_id = ?', [user.id]);
    }
    return User.findById(user.id);
  }

  /**
   * Switch every QA account off. Called when a run finds no usable QA password: removing
   * the variable must close the door, not leave four accounts behind holding a password
   * nobody is rotating any more. `ensure` switches them back on when it returns.
   */
  static async deactivateAll() {
    const [result] = await promisePool.query(
      'UPDATE users SET is_active = 0 WHERE email LIKE ? AND is_active = 1',
      [QA_EMAIL_LIKE]
    );
    return result.affectedRows;
  }
}

module.exports = QaAccount;
module.exports.FLAGS = FLAGS;
