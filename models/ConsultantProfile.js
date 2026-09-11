'use strict';

const { promisePool, withTransaction } = require('../config/database');
const { isValidRole } = require('../config/roleTaxonomy');

/**
 * Fields that count towards profile completeness, with their weights.
 * A profile must reach MIN_COMPLETENESS_TO_PUBLISH before it can be listed publicly:
 * an empty profile in the talent directory wastes an employer's time and makes the
 * whole directory look thin.
 */
const COMPLETENESS_FIELDS = [
  { key: 'headline', weight: 10 },
  { key: 'bio', weight: 15 },
  { key: 'primary_role', weight: 15 },
  { key: 'seniority', weight: 10 },
  { key: 'country', weight: 10 },
  { key: 'day_rate', weight: 10 },
  { key: 'availability', weight: 5, satisfied: (v) => v && v !== 'not_available' },
  { key: 'profile_picture', weight: 5 }
];

const MIN_COMPLETENESS_TO_PUBLISH = 60;

/** Pure function: 0..100 completeness for a profile row plus its child-record counts. */
function completenessOf(profile, { skillCount = 0, certificationCount = 0, experienceCount = 0 } = {}) {
  let score = 0;
  for (const field of COMPLETENESS_FIELDS) {
    const value = profile ? profile[field.key] : null;
    const ok = field.satisfied ? field.satisfied(value) : value !== null && value !== undefined && String(value).trim() !== '';
    if (ok) score += field.weight;
  }
  if (skillCount >= 3) score += 10;
  if (certificationCount >= 1) score += 5;
  if (experienceCount >= 1) score += 5;
  return Math.min(100, score);
}

/**
 * THE single WHERE builder for consultant browsing.
 *
 * Every list view, count and export goes through this one function. The reference
 * implementation's incident was a list view and a bulk mutation each building their own
 * WHERE clause: they drifted, and an operation reported on one set of rows while acting
 * on another. One builder makes that impossible by construction.
 *
 * @returns {{clause:string, params:Array}}
 */
function buildFilter(filters = {}) {
  const where = ['cp.is_public = 1', 'u.is_active = 1'];
  const params = [];

  if (filters.role && isValidRole(filters.role)) {
    where.push('cp.primary_role = ?');
    params.push(filters.role);
  }
  if (filters.seniority) {
    where.push('cp.seniority = ?');
    params.push(filters.seniority);
  }
  if (filters.country) {
    where.push('cp.country = ?');
    params.push(filters.country);
  }
  if (filters.work_mode) {
    where.push('cp.work_mode = ?');
    params.push(filters.work_mode);
  }
  if (filters.availability) {
    where.push('cp.availability = ?');
    params.push(filters.availability);
  }
  if (filters.certified === '1') {
    where.push('EXISTS (SELECT 1 FROM consultant_certifications cc WHERE cc.user_id = cp.user_id)');
  }
  if (filters.rate_max) {
    const max = Number(filters.rate_max);
    if (Number.isFinite(max) && max > 0) {
      where.push('(cp.day_rate IS NULL OR cp.day_rate <= ?)');
      params.push(max);
    }
  }
  if (filters.skill_ids && filters.skill_ids.length) {
    where.push(
      `cp.user_id IN (SELECT cs.user_id FROM consultant_skills cs WHERE cs.skill_id IN (?)
                       GROUP BY cs.user_id HAVING COUNT(DISTINCT cs.skill_id) = ?)`
    );
    params.push(filters.skill_ids, filters.skill_ids.length);
  }
  if (filters.q) {
    where.push('(cp.headline LIKE ? OR cp.bio LIKE ? OR u.name LIKE ?)');
    const like = `%${String(filters.q).trim()}%`;
    params.push(like, like, like);
  }

  return { clause: where.join(' AND '), params };
}

/**
 * Ranking for the talent directory. Deliberately explicit rather than a magic ORDER BY
 * scattered across call sites: a verified LinkedIn, a certification and an immediate
 * availability each nudge a profile up, and completeness breaks ties.
 */
const RANK_EXPRESSION = `(
  cp.completeness
  + (cp.linkedin_verified * 3)
  + (CASE cp.availability WHEN 'immediate' THEN 6 WHEN 'two_weeks' THEN 4 WHEN 'one_month' THEN 2 ELSE 0 END)
  + LEAST(10, (SELECT COUNT(*) * 2 FROM consultant_certifications cc WHERE cc.user_id = cp.user_id))
)`;

const SORTS = {
  relevance: `${RANK_EXPRESSION} DESC, cp.updated_at DESC`,
  newest: 'cp.created_at DESC',
  rate_asc: 'cp.day_rate IS NULL, cp.day_rate ASC',
  rate_desc: 'cp.day_rate DESC'
};

class ConsultantProfile {
  static get MIN_COMPLETENESS_TO_PUBLISH() {
    return MIN_COMPLETENESS_TO_PUBLISH;
  }

  static completenessOf = completenessOf;

  static buildFilter = buildFilter;

  static async findByUserId(userId) {
    const [rows] = await promisePool.query(
      `SELECT cp.*, u.name, u.email, u.email_verified
         FROM consultant_profiles cp JOIN users u ON u.id = cp.user_id
        WHERE cp.user_id = ? LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  }

  static async ensureExists(userId) {
    await promisePool.query('INSERT IGNORE INTO consultant_profiles (user_id) VALUES (?)', [userId]);
    return ConsultantProfile.findByUserId(userId);
  }

  static async update(userId, fields) {
    const allowed = [
      'headline', 'bio', 'primary_role', 'seniority', 'years_experience',
      'country', 'city', 'timezone', 'work_mode', 'willing_to_travel',
      'day_rate', 'currency', 'availability', 'available_from',
      'linkedin_url', 'website_url', 'trailblazer_url'
    ];

    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        sets.push(`${key} = ?`);
        params.push(fields[key]);
      }
    }
    if (sets.length === 0) return ConsultantProfile.findByUserId(userId);

    params.push(userId);
    await promisePool.query(`UPDATE consultant_profiles SET ${sets.join(', ')} WHERE user_id = ?`, params);
    await ConsultantProfile.recomputeCompleteness(userId);
    return ConsultantProfile.findByUserId(userId);
  }

  static async setProfilePicture(userId, pointerUrl) {
    await promisePool.query('UPDATE consultant_profiles SET profile_picture = ? WHERE user_id = ?', [pointerUrl, userId]);
    await ConsultantProfile.recomputeCompleteness(userId);
  }

  /**
   * Publishing is gated on completeness, and un-publishing is always allowed.
   * @returns {{published:boolean, completeness:number}}
   */
  static async setPublic(userId, isPublic) {
    return withTransaction(async (conn) => {
      const [[row]] = await conn.query('SELECT completeness FROM consultant_profiles WHERE user_id = ? FOR UPDATE', [userId]);
      if (!row) throw new Error(`No consultant profile for user ${userId}`);

      if (isPublic && row.completeness < MIN_COMPLETENESS_TO_PUBLISH) {
        return { published: false, completeness: row.completeness };
      }
      await conn.query('UPDATE consultant_profiles SET is_public = ? WHERE user_id = ?', [isPublic ? 1 : 0, userId]);
      return { published: Boolean(isPublic), completeness: row.completeness };
    });
  }

  static async recomputeCompleteness(userId) {
    const [[profile]] = await promisePool.query('SELECT * FROM consultant_profiles WHERE user_id = ?', [userId]);
    if (!profile) return 0;

    const [[counts]] = await promisePool.query(
      `SELECT
         (SELECT COUNT(*) FROM consultant_skills WHERE user_id = ?) AS skill_count,
         (SELECT COUNT(*) FROM consultant_certifications WHERE user_id = ?) AS certification_count,
         (SELECT COUNT(*) FROM consultant_work_experiences WHERE user_id = ?) AS experience_count`,
      [userId, userId, userId]
    );

    const completeness = completenessOf(profile, {
      skillCount: counts.skill_count,
      certificationCount: counts.certification_count,
      experienceCount: counts.experience_count
    });

    // Falling below the publishing floor un-publishes the profile rather than leaving a
    // hollow entry in the directory.
    const stayPublic = profile.is_public && completeness >= MIN_COMPLETENESS_TO_PUBLISH ? 1 : 0;
    await promisePool.query('UPDATE consultant_profiles SET completeness = ?, is_public = ? WHERE user_id = ?', [
      completeness,
      stayPublic,
      userId
    ]);
    return completeness;
  }

  static async browse(filters = {}, { limit = 20, offset = 0, sort = 'relevance' } = {}) {
    const { clause, params } = buildFilter(filters);
    const orderBy = SORTS[sort] || SORTS.relevance;

    const [rows] = await promisePool.query(
      `SELECT cp.user_id, cp.headline, cp.primary_role, cp.seniority, cp.country, cp.city,
              cp.work_mode, cp.day_rate, cp.currency, cp.availability, cp.profile_picture,
              cp.linkedin_verified, cp.completeness, u.name,
              (SELECT COUNT(*) FROM consultant_certifications cc WHERE cc.user_id = cp.user_id) AS certification_count
         FROM consultant_profiles cp JOIN users u ON u.id = cp.user_id
        WHERE ${clause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM consultant_profiles cp JOIN users u ON u.id = cp.user_id WHERE ${clause}`,
      params
    );

    return { rows, total };
  }

  static async listCertifications(userId) {
    const [rows] = await promisePool.query(
      'SELECT * FROM consultant_certifications WHERE user_id = ? ORDER BY earned_on DESC, name ASC',
      [userId]
    );
    return rows;
  }

  static async addCertification(userId, { name, credentialId = null, earnedOn = null, expiresOn = null }) {
    await promisePool.query(
      `INSERT INTO consultant_certifications (user_id, name, credential_id, earned_on, expires_on)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE credential_id = VALUES(credential_id), earned_on = VALUES(earned_on),
                               expires_on = VALUES(expires_on)`,
      [userId, name, credentialId, earnedOn, expiresOn]
    );
    await ConsultantProfile.recomputeCompleteness(userId);
  }

  static async removeCertification(userId, certificationId) {
    await promisePool.query('DELETE FROM consultant_certifications WHERE id = ? AND user_id = ?', [certificationId, userId]);
    await ConsultantProfile.recomputeCompleteness(userId);
  }

  static async listExperiences(userId) {
    const [rows] = await promisePool.query(
      'SELECT * FROM consultant_work_experiences WHERE user_id = ? ORDER BY is_current DESC, started_on DESC',
      [userId]
    );
    return rows;
  }

  static async addExperience(userId, exp) {
    await promisePool.query(
      `INSERT INTO consultant_work_experiences (user_id, company, title, started_on, ended_on, is_current, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, exp.company, exp.title, exp.startedOn, exp.endedOn || null, exp.isCurrent ? 1 : 0, exp.description || null]
    );
    await ConsultantProfile.recomputeCompleteness(userId);
  }

  static async removeExperience(userId, experienceId) {
    await promisePool.query('DELETE FROM consultant_work_experiences WHERE id = ? AND user_id = ?', [experienceId, userId]);
    await ConsultantProfile.recomputeCompleteness(userId);
  }

  /**
   * Delivery history: the engagements themselves, as distinct from employment.
   *
   * `consultant_projects` has existed since migration 002 with nothing reading or writing
   * it, which meant the CV's most useful section was always empty. A contractor's CV is
   * mostly "which orgs, which clouds, what did you actually ship" — the employer column
   * matters far less than it does for a permanent role, and for someone through an agency
   * it may be the same company for every line.
   *
   * Ordered by end date with anything still running first: a current engagement is the one
   * a reader wants at the top.
   */
  static async listProjects(userId) {
    const [rows] = await promisePool.query(
      `SELECT * FROM consultant_projects WHERE user_id = ?
        ORDER BY ended_on IS NULL DESC, ended_on DESC, started_on DESC`,
      [userId]
    );
    return rows;
  }

  static async addProject(userId, project) {
    await promisePool.query(
      `INSERT INTO consultant_projects (user_id, name, client, cloud, role, started_on, ended_on, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        project.name,
        project.client || null,
        project.cloud || null,
        project.role || null,
        project.startedOn || null,
        project.endedOn || null,
        project.description || null
      ]
    );
    await ConsultantProfile.recomputeCompleteness(userId);
  }

  static async removeProject(userId, projectId) {
    await promisePool.query('DELETE FROM consultant_projects WHERE id = ? AND user_id = ?', [projectId, userId]);
    await ConsultantProfile.recomputeCompleteness(userId);
  }
}

module.exports = ConsultantProfile;
