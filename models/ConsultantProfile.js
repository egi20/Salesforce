'use strict';

const { promisePool, withTransaction } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');
const { isValidRole } = require('../config/roleTaxonomy');
const { isValidFamily } = require('../config/cloudFamilies');

const COUNTRY_CODES = new Set(require('../config/all-countries.json').map((c) => c.code));
// Basic / Fluent / Native, the levels the spec names (migration 037 maps the older four).
const LANGUAGE_LEVELS = Object.freeze(['basic', 'fluent', 'native']);
const SKILL_LEVELS = Object.freeze(['familiar', 'proficient', 'expert']);

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

/*
 * Where a newly added project or experience goes: after the last one the owner arranged, or
 * at 0 (date order) while nothing has been arranged yet. `table` is one of two fixed names.
 */
async function nextSortOrder(table, userId) {
  const [[{ top }]] = await promisePool.query(`SELECT COALESCE(MAX(sort_order), 0) AS top FROM ${table} WHERE user_id = ?`, [userId]);
  // Number(): MariaDB hands COALESCE(MAX(..)) back as a string, and "5" + 1 is "51".
  const n = Number(top) || 0;
  return n === 0 ? 0 : n + 1;
}

/*
 * What a profile must state before it can be LISTED, beyond the completeness floor: a role
 * and at least one cloud. Browse Talent filters by both, so a profile without them is one no
 * company search can ever return — publishing it only adds a card nobody can find by asking.
 *
 * Checked when the owner PUBLISHES, never by un-publishing somebody who is already listed:
 * profiles listed before clouds existed must not vanish from the directory the day this ships.
 */
function listingProblems(profile, { cloudCount = 0 } = {}) {
  const problems = [];
  if (!profile || !profile.primary_role) problems.push('choose your primary role');
  if (cloudCount < 1) problems.push('pick at least one cloud you work on');
  // The spec's listing minimum is role + cloud + availability: a card that cannot say whether
  // somebody is free is the one question every company opens it to answer.
  if (!profile || !profile.availability) problems.push('set your availability');
  if (!profile || profile.completeness < MIN_COMPLETENESS_TO_PUBLISH) {
    problems.push(`reach ${MIN_COMPLETENESS_TO_PUBLISH}% complete`);
  }
  return problems;
}

/*
 * The next things worth doing, biggest gain first, for the progress bar's hint ("add three
 * skills to reach 80%"). Derived from the SAME weights `completenessOf` scores with, so the
 * promised percentage is the one the bar will show after the change.
 */
const STEP_LABELS = Object.freeze({
  headline: 'add a professional title',
  bio: 'write a short bio',
  primary_role: 'choose your primary role',
  seniority: 'set your seniority',
  country: 'add your country',
  day_rate: 'add your day rate',
  availability: 'set your availability',
  profile_picture: 'add a photo'
});

function nextSteps(profile, { skillCount = 0, certificationCount = 0, experienceCount = 0 } = {}) {
  const steps = [];
  for (const field of COMPLETENESS_FIELDS) {
    const value = profile ? profile[field.key] : null;
    const ok = field.satisfied ? field.satisfied(value) : value !== null && value !== undefined && String(value).trim() !== '';
    if (!ok) steps.push({ label: STEP_LABELS[field.key], gain: field.weight });
  }
  if (skillCount < 3) steps.push({ label: `add ${3 - skillCount} more skill${3 - skillCount === 1 ? '' : 's'}`, gain: 10 });
  if (certificationCount < 1) steps.push({ label: 'add a certification', gain: 5 });
  if (experienceCount < 1) steps.push({ label: 'add your work experience', gain: 5 });
  return steps.sort((a, b) => b.gain - a.gain);
}
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
/*
 * What "in the directory" means, stated once. Two switches: `is_public` is the member's own,
 * `admin_hidden_at` is a moderator's (migration 033), and the account must be active. Exported
 * so the Talent column on /admin/users reads the directory's own rule rather than restating
 * it — a restated copy is the one that drifts, and "Listed" on that screen would then name
 * people a reader of /consultants cannot find.
 */
const LISTED_CONDITIONS = Object.freeze(['cp.is_public = 1', 'cp.admin_hidden_at IS NULL', 'u.is_active = 1']);

function buildFilter(filters = {}) {
  // The directory requires every listed condition; see `Moderation.setProfileHidden`.
  const where = [...LISTED_CONDITIONS];
  const params = [];

  /*
   * "Hide my profile from these companies."
   *
   * HERE, and nowhere else. Every list, count and search of consultants goes through this
   * builder, so a profile hidden from the viewing company is hidden from all of them by
   * construction — including any query somebody adds next year without knowing this feature
   * exists.
   *
   * The reference implementation put its equivalent clause inline in ONE query out of the
   * fourteen that read `consultant_profiles`. Its browse list honoured the block and its
   * search, its featured-talent panel and everything else did not: a privacy promise that
   * holds on one page. That is what the one-builder rule in CLAUDE.md is for, and this is
   * the most expensive shape the failure takes.
   *
   * `viewer` is resolved once per request by `ConsultantHiddenCompany.viewerFor` and passed
   * in. The builder stays a pure function over its filters — it does not reach into the
   * database — which is what keeps it testable and what stops a list and its count
   * disagreeing about what is in scope.
   *
   * A signed-out visitor has no viewer and is filtered by nothing. That is not an oversight:
   * the directory is public and no clause can ask who an anonymous browser works for. The
   * page tells the consultant exactly that rather than implying protection it cannot give.
   */
  if (filters.viewer && filters.viewer.companyUserId) {
    where.push(`NOT EXISTS (
      SELECT 1 FROM consultant_hidden_companies h
       WHERE h.consultant_user_id = cp.user_id
         AND ( h.company_user_id = ?
            OR (h.company_name_key IS NOT NULL AND h.company_name_key = ?) )
    )`);
    params.push(filters.viewer.companyUserId, filters.viewer.companyNameKey || '\u0000');
  }

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
      /*
       * A HIDDEN RATE IS AN UNKNOWN RATE, not a known one we decline to print.
       *
       * Hiding the figure in the view and leaving it in this clause would make it
       * searchable one query at a time: set the maximum to 700, then 600, then 550, and
       * watch the profile drop out. The consultant would have been told their rate was
       * private while anybody patient could read it to the nearest step.
       *
       * So a hidden rate behaves exactly like a missing one — which is already included
       * here, because "no rate given" must not mean "too expensive".
       */
      where.push('(cp.rate_visible = 0 OR cp.day_rate IS NULL OR cp.day_rate <= ?)');
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
    const like = containsPattern(filters.q);
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

/*
 * Ordering by rate must not order by a rate nobody is allowed to see. A hidden figure is
 * placed with the profiles that have none — the same reasoning as the filter above, and
 * for the same reason: position in a sorted list is a measurement.
 */
/*
 * ONE SWITCH COVERS EVERY FIGURE.
 *
 * `rate_visible` was added for the day rate; migration 030 added an hourly rate and an
 * expected salary beside it. Publishing either of those while the day rate was hidden
 * would defeat the switch — multiply an hourly rate by a working day and you are within a
 * few per cent of the number somebody chose to keep back.
 */
const hiddenUnlessVisible = (column) => `CASE WHEN cp.rate_visible = 1 THEN cp.${column} ELSE NULL END`;
const RATE_OR_NULL = hiddenUnlessVisible('day_rate');

const SORTS = {
  relevance: `${RANK_EXPRESSION} DESC, cp.updated_at DESC`,
  newest: 'cp.created_at DESC',
  rate_asc: `${RATE_OR_NULL} IS NULL, ${RATE_OR_NULL} ASC`,
  rate_desc: `${RATE_OR_NULL} IS NULL, ${RATE_OR_NULL} DESC`
};

class ConsultantProfile {
  static get MIN_COMPLETENESS_TO_PUBLISH() {
    return MIN_COMPLETENESS_TO_PUBLISH;
  }

  static completenessOf = completenessOf;

  static buildFilter = buildFilter;

  static LISTED_CONDITIONS = LISTED_CONDITIONS;

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
      'country', 'city', 'timezone', 'work_mode', 'willing_to_travel', 'works_anywhere',
      'day_rate', 'hourly_rate', 'annual_salary', 'currency', 'rate_visible',
      'availability', 'available_from',
      'linkedin_url', 'website_url', 'trailblazer_url', 'phone',
      'open_to_contract', 'open_to_permanent', 'trailhead_rank', 'trailhead_badges'
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
      const [[row]] = await conn.query(
        'SELECT completeness, admin_hidden_at FROM consultant_profiles WHERE user_id = ? FOR UPDATE',
        [userId]
      );
      if (!row) throw new Error(`No consultant profile for user ${userId}`);

      /*
       * A profile an administrator has taken down cannot be put back by its owner. Without
       * this the member's Publish would succeed and do nothing visible, and nothing on their
       * screen would tell them a decision had been made.
       */
      if (isPublic && row.admin_hidden_at) {
        return { published: false, completeness: row.completeness, adminHidden: true };
      }

      if (isPublic) {
        const [[profile]] = await conn.query('SELECT primary_role, availability, completeness FROM consultant_profiles WHERE user_id = ?', [userId]);
        const [[{ cloudCount }]] = await conn.query('SELECT COUNT(*) AS cloudCount FROM consultant_clouds WHERE user_id = ?', [userId]);
        const problems = listingProblems(profile, { cloudCount });
        if (problems.length) return { published: false, completeness: row.completeness, problems };
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

  /*
   * A hidden rate is NULLED IN THE QUERY, not left for each template to remember.
   *
   * Three call sites read this list — the directory, the home page and services/search.js —
   * and the one that forgets the check is the one that leaks. The detail fetch
   * (findByUserId) still returns the real row, because the owner and an admin are allowed
   * to see it there and the route decides with `showRate`.
   */
  static async browse(filters = {}, { limit = 20, offset = 0, sort = 'relevance' } = {}) {
    const { clause, params } = buildFilter(filters);
    const orderBy = SORTS[sort] || SORTS.relevance;

    const [rows] = await promisePool.query(
      `SELECT cp.user_id, cp.headline, cp.primary_role, cp.seniority, cp.country, cp.city,
              cp.work_mode, ${RATE_OR_NULL} AS day_rate,
              ${hiddenUnlessVisible('hourly_rate')} AS hourly_rate,
              ${hiddenUnlessVisible('annual_salary')} AS annual_salary,
              cp.currency, cp.rate_visible, cp.availability, cp.profile_picture,
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

  static async addCertification(userId, { name, credentialId = null, credentialUrl = null, earnedOn = null, expiresOn = null }) {
    await promisePool.query(
      `INSERT INTO consultant_certifications (user_id, name, credential_id, credential_url, earned_on, expires_on)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE credential_id = VALUES(credential_id), credential_url = VALUES(credential_url),
                               earned_on = VALUES(earned_on), expires_on = VALUES(expires_on)`,
      [userId, name, credentialId, credentialUrl, earnedOn, expiresOn]
    );
    await ConsultantProfile.recomputeCompleteness(userId);
  }

  static async removeCertification(userId, certificationId) {
    await promisePool.query('DELETE FROM consultant_certifications WHERE id = ? AND user_id = ?', [certificationId, userId]);
    await ConsultantProfile.recomputeCompleteness(userId);
  }

  static async listExperiences(userId) {
    const [rows] = await promisePool.query(
      'SELECT * FROM consultant_work_experiences WHERE user_id = ? ORDER BY sort_order, is_current DESC, started_on DESC, id',
      [userId]
    );
    return rows;
  }

  static async addExperience(userId, exp) {
    await promisePool.query(
      `INSERT INTO consultant_work_experiences (user_id, sort_order, company, title, location, started_on, ended_on, is_current, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, await nextSortOrder('consultant_work_experiences', userId), exp.company, exp.title || '', exp.location || null,
        exp.startedOn, exp.isCurrent ? null : exp.endedOn || null, exp.isCurrent ? 1 : 0, exp.description || null]
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
        ORDER BY sort_order, ended_on IS NULL DESC, ended_on DESC, started_on DESC, id`,
      [userId]
    );
    return rows;
  }

  static async addProject(userId, project) {
    await promisePool.query(
      `INSERT INTO consultant_projects (user_id, sort_order, name, client, cloud, role, started_on, ended_on, is_current, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        await nextSortOrder('consultant_projects', userId),
        project.name,
        project.client || null,
        project.cloud || null,
        project.role || null,
        project.startedOn || null,
        // A current engagement has no end date, whatever the form also carried.
        project.isCurrent ? null : project.endedOn || null,
        project.isCurrent ? 1 : 0,
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

/*
 * The lists a profile states about its owner: clouds, languages and the countries they will
 * work in. Each REPLACES the whole list in one transaction (the form posts every ticked box),
 * and validates every element against its catalogue — a value that is not ours is dropped
 * here, not stored and filtered later.
 */
async function replaceList(table, column, userId, values, extraColumn = null) {
  await withTransaction(async (conn) => {
    await conn.query(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
    if (values.length === 0) return;
    const cols = extraColumn ? `(user_id, ${column}, ${extraColumn})` : `(user_id, ${column})`;
    const rows = values.map((v) => (extraColumn ? [userId, v[0], v[1]] : [userId, v]));
    await conn.query(`INSERT IGNORE INTO ${table} ${cols} VALUES ?`, [rows]);
  });
}

ConsultantProfile.listClouds = async function listClouds(userId) {
  const [rows] = await promisePool.query('SELECT family FROM consultant_clouds WHERE user_id = ? ORDER BY family', [userId]);
  return rows.map((r) => r.family);
};

ConsultantProfile.setClouds = async function setClouds(userId, families) {
  const valid = [...new Set((families || []).map(String))].filter(isValidFamily).slice(0, 20);
  await replaceList('consultant_clouds', 'family', userId, valid);
  return valid;
};

ConsultantProfile.listLanguages = async function listLanguages(userId) {
  const [rows] = await promisePool.query(
    `SELECT language, level FROM consultant_languages WHERE user_id = ?
      ORDER BY FIELD(level, 'native', 'fluent', 'basic'), language`,
    [userId]
  );
  return rows;
};

ConsultantProfile.setLanguages = async function setLanguages(userId, entries) {
  const seen = new Set();
  const valid = [];
  for (const { language, level } of entries || []) {
    const name = String(language || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!name || !LANGUAGE_LEVELS.includes(level) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    valid.push([name, level]);
    if (valid.length === 10) break;
  }
  await replaceList('consultant_languages', 'language', userId, valid, 'level');
  return valid;
};

ConsultantProfile.listWorkCountries = async function listWorkCountries(userId) {
  const [rows] = await promisePool.query('SELECT country FROM consultant_work_countries WHERE user_id = ? ORDER BY country', [userId]);
  return rows.map((r) => r.country);
};

ConsultantProfile.setWorkCountries = async function setWorkCountries(userId, codes) {
  const valid = [...new Set((codes || []).map(String))].filter((c) => COUNTRY_CODES.has(c)).slice(0, 40);
  await replaceList('consultant_work_countries', 'country', userId, valid);
  return valid;
};

ConsultantProfile.listingProblems = listingProblems;
ConsultantProfile.nextSteps = nextSteps;
ConsultantProfile.LANGUAGE_LEVELS = LANGUAGE_LEVELS;
ConsultantProfile.SKILL_LEVELS = SKILL_LEVELS;

/*
 * EDITING AND ORDERING projects and experience.
 *
 * Ownership is part of every WHERE: an id from somebody else's list updates nothing. The
 * order is an explicit `sort_order` (migration 037); rows that have never been moved all
 * carry 0 and fall back to the date order, so the FIRST move renumbers the whole list in the
 * order the owner was looking at, and from then on the numbers are the order.
 */
const ENTRY_TABLES = Object.freeze({ projects: 'consultant_projects', experience: 'consultant_work_experiences' });

function entryTable(kind) {
  if (!Object.prototype.hasOwnProperty.call(ENTRY_TABLES, kind)) throw new Error(`No entry list "${kind}"`);
  return ENTRY_TABLES[kind];
}

async function orderedIds(conn, kind, userId) {
  const listSql = kind === 'projects'
    ? 'SELECT id FROM consultant_projects WHERE user_id = ? ORDER BY sort_order, ended_on IS NULL DESC, ended_on DESC, started_on DESC, id FOR UPDATE'
    : 'SELECT id FROM consultant_work_experiences WHERE user_id = ? ORDER BY sort_order, is_current DESC, started_on DESC, id FOR UPDATE';
  const [rows] = await conn.query(listSql, [userId]);
  return rows.map((r) => r.id);
}

async function writeOrder(conn, kind, userId, ids) {
  const table = entryTable(kind);
  for (let i = 0; i < ids.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- a handful of rows, inside one transaction
    await conn.query(`UPDATE ${table} SET sort_order = ? WHERE id = ? AND user_id = ?`, [i + 1, ids[i], userId]);
  }
}

ConsultantProfile.moveEntry = async function moveEntry(kind, userId, id, direction) {
  entryTable(kind);
  return withTransaction(async (conn) => {
    const ids = await orderedIds(conn, kind, userId);
    const at = ids.indexOf(Number(id));
    const to = direction === 'up' ? at - 1 : at + 1;
    if (at < 0 || to < 0 || to >= ids.length) return false;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    await writeOrder(conn, kind, userId, ids);
    return true;
  });
};

/** A whole new order from a drag. Refused unless it is exactly the owner's ids, rearranged. */
ConsultantProfile.setEntryOrder = async function setEntryOrder(kind, userId, requested) {
  entryTable(kind);
  return withTransaction(async (conn) => {
    const ids = await orderedIds(conn, kind, userId);
    const wanted = (requested || []).map(Number);
    const same = wanted.length === ids.length && new Set(wanted).size === ids.length && wanted.every((x) => ids.includes(x));
    if (!same) return false;
    await writeOrder(conn, kind, userId, wanted);
    return true;
  });
};

ConsultantProfile.updateProject = async function updateProject(userId, id, project) {
  const [result] = await promisePool.query(
    `UPDATE consultant_projects
        SET name = ?, client = ?, cloud = ?, role = ?, started_on = ?, ended_on = ?, is_current = ?, description = ?
      WHERE id = ? AND user_id = ?`,
    [project.name, project.client || null, project.cloud || null, project.role || null, project.startedOn || null,
      project.isCurrent ? null : project.endedOn || null, project.isCurrent ? 1 : 0, project.description || null, id, userId]
  );
  return result.affectedRows === 1;
};

ConsultantProfile.updateExperience = async function updateExperience(userId, id, exp) {
  const [result] = await promisePool.query(
    `UPDATE consultant_work_experiences
        SET company = ?, title = ?, location = ?, started_on = ?, ended_on = ?, is_current = ?, description = ?
      WHERE id = ? AND user_id = ?`,
    [exp.company, exp.title || '', exp.location || null, exp.startedOn, exp.isCurrent ? null : exp.endedOn || null,
      exp.isCurrent ? 1 : 0, exp.description || null, id, userId]
  );
  return result.affectedRows === 1;
};

module.exports = ConsultantProfile;
