'use strict';

const { promisePool, withTransaction } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');
const { uniqueSlug } = require('../utils/slug');
const { isValidRole } = require('../config/roleTaxonomy');

const SORTS = {
  newest: 'j.published_at DESC, j.id DESC',
  rate_desc: 'j.rate_max IS NULL, j.rate_max DESC',
  rate_asc: 'j.rate_min IS NULL, j.rate_min ASC',
  relevance: 'j.published_at DESC, j.id DESC'
};

/**
 * Whether a paid featured window is open on this job right now.
 *
 * A correlated EXISTS rather than a column on `jobs`, because a window EXPIRES: a
 * boolean flag would need something to come round and unset it, and the day that job
 * fails to run is the day someone keeps a placement they stopped paying for. Asking the
 * question at read time cannot go stale. Overlapping rows are expected — a renewal
 * bought mid-window appends another row (see migration 010).
 */
const FEATURED_EXPR = `EXISTS (
        SELECT 1 FROM job_features f
         WHERE f.job_id = j.id AND f.starts_at <= NOW() AND f.ends_at > NOW()
      )`;

/**
 * Featured jobs sort first, within whatever order was asked for.
 *
 * Prefixed rather than replacing the sort: someone who explicitly sorted by rate still
 * gets a rate-sorted list, with the paid placements at its head. Silently overriding a
 * chosen sort would make the control look broken.
 */
function orderByFor(sort) {
  return `is_featured DESC, ${SORTS[sort] || SORTS.newest}`;
}

/*
 * A filter field may be one value or several (the board's checkboxes post a list). One
 * value keeps its `= ?` clause; several become `IN (?)`, which mysql2 expands into one
 * placeholder per element — still parameterised, never interpolated. Lists are capped so a
 * crafted query string cannot build a clause with ten thousand placeholders.
 */
const MAX_LIST = 30;

function asList(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.filter((v) => typeof v === 'string' && v !== '').slice(0, MAX_LIST);
}

function pushMatch(where, params, column, values) {
  if (values.length === 1) {
    where.push(`${column} = ?`);
    params.push(values[0]);
  } else if (values.length > 1) {
    where.push(`${column} IN (?)`);
    params.push(values);
  }
}

/** The columns the board counts by, keyed by filter field. */
const FACET_COLUMNS = Object.freeze({
  role: 'j.role',
  country: 'j.country',
  seniority: 'j.seniority',
  work_mode: 'j.work_mode',
  engagement_type: 'j.engagement_type'
});

/**
 * THE single WHERE builder for job browsing.
 *
 * Used by the public list, the count behind it, the RSS feed, the sitemap and every
 * bulk mutation. One builder is what guarantees that a bulk action provably targets the
 * same rows the operator was looking at; two builders drift, and eventually a bulk
 * "close all filtered jobs" closes a different set than the screen showed.
 *
 * @returns {{clause:string, params:Array}}
 */
function buildFilter(filters = {}) {
  const where = [];
  const params = [];

  /*
   * An advert a moderator has taken down (migration 033) leaves every list, whatever its own
   * status says. The board, the feed, search and the matches all come through here, so none
   * of them has to know this rule exists — and there is no `include_hidden` option, because
   * the one screen that has to see what was taken down reads `Moderation.hiddenContent()`
   * instead. An escape hatch on the builder is how the rule ends up off on the page that
   * forgets to pass it.
   */
  where.push('j.admin_hidden_at IS NULL');

  // `status` defaults to the public view. An explicit status is only honoured for
  // callers that pass one (the employer's own list, admin).
  if (filters.status) {
    where.push('j.status = ?');
    params.push(filters.status);
  } else {
    where.push("j.status = 'open'");
    where.push('(j.expires_at IS NULL OR j.expires_at > NOW())');
  }

  if (filters.company_user_id) {
    where.push('j.company_user_id = ?');
    params.push(filters.company_user_id);
  }
  // Several values in one field are alternatives (Apex OR CPQ); separate fields still narrow.
  pushMatch(where, params, 'j.role', asList(filters.role).filter(isValidRole));
  pushMatch(where, params, 'j.seniority', asList(filters.seniority));
  pushMatch(where, params, 'j.engagement_type', asList(filters.engagement_type));
  pushMatch(where, params, 'j.work_mode', asList(filters.work_mode));
  pushMatch(where, params, 'j.country', asList(filters.country).filter((c) => /^[A-Z]{2}$/.test(c)));
  if (filters.rate_min) {
    const min = Number(filters.rate_min);
    if (Number.isFinite(min) && min > 0) {
      where.push('(j.rate_max IS NULL OR j.rate_max >= ?)');
      params.push(min);
    }
  }
  if (filters.rate_published) {
    /*
     * Only adverts whose company chose to show the figure. A rate an employer hid on the job
     * page must not reappear, aggregated, on the rate index.
     */
    where.push('j.rate_visible = 1 AND (j.rate_min IS NOT NULL OR j.rate_max IS NOT NULL)');
  }
  if (filters.posted_within_days) {
    /*
     * "Posted in the last N days", bounded by the caller against a declared list so this
     * can never become a caller-supplied interval expression.
     *
     * On `published_at` rather than `created_at`: a draft written in March and published in
     * September is a September role to everybody reading the board, and a job searcher
     * sorting by freshness is asking when it appeared, not when it was typed.
     */
    where.push('j.published_at IS NOT NULL AND j.published_at >= DATE_SUB(NOW(), INTERVAL ? DAY)');
    params.push(filters.posted_within_days);
  }
  const modules = asList(filters.module);
  if (modules.length === 1) {
    where.push('EXISTS (SELECT 1 FROM job_modules jm WHERE jm.job_id = j.id AND jm.module_slug = ?)');
    params.push(modules[0]);
  } else if (modules.length > 1) {
    where.push('EXISTS (SELECT 1 FROM job_modules jm WHERE jm.job_id = j.id AND jm.module_slug IN (?))');
    params.push(modules);
  }
  if (filters.skill_ids && filters.skill_ids.length) {
    where.push(
      `j.id IN (SELECT js.job_id FROM job_skills js WHERE js.skill_id IN (?)
                 GROUP BY js.job_id HAVING COUNT(DISTINCT js.skill_id) = ?)`
    );
    params.push(filters.skill_ids, filters.skill_ids.length);
  }
  if (filters.q) {
    // LIKE rather than MATCH: the FULLTEXT index exists, but a mixed-language, mostly
    // short-token corpus made boolean-mode results worse than a plain substring match.
    where.push('(j.title LIKE ? OR j.description LIKE ?)');
    // Escaped, so a search for "50%" looks for "50%" and a search for "%" is not a scan
    // of the whole table. See utils/likePattern.js.
    const like = containsPattern(filters.q);
    params.push(like, like);
  }

  return { clause: where.join(' AND '), params };
}

class Job {
  static buildFilter = buildFilter;

  static async slugTaken(slug) {
    const [rows] = await promisePool.query('SELECT 1 FROM jobs WHERE slug = ? LIMIT 1', [slug]);
    return rows.length > 0;
  }

  static async create(companyUserId, data) {
    const slug = await uniqueSlug(`${data.title}`, Job.slugTaken);
    const [result] = await promisePool.query(
      `INSERT INTO jobs
         (company_user_id, title, slug, description, role, seniority, engagement_type, work_mode,
          country, city, rate_min, rate_max, currency, rate_visible, duration_months, starts_on,
          status, published_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyUserId,
        data.title,
        slug,
        data.description,
        data.role,
        data.seniority,
        data.engagement_type,
        data.work_mode,
        data.country || null,
        data.city || null,
        data.rate_min ?? null,
        data.rate_max ?? null,
        data.currency || 'EUR',
        data.rate_visible ? 1 : 0,
        data.duration_months ?? null,
        data.starts_on || null,
        data.status || 'draft',
        data.status === 'open' ? new Date() : null,
        data.expires_at || null
      ]
    );
    return Job.findById(result.insertId);
  }

  static async update(jobId, companyUserId, data) {
    const allowed = [
      'title', 'description', 'role', 'seniority', 'engagement_type', 'work_mode',
      'country', 'city', 'rate_min', 'rate_max', 'currency', 'rate_visible',
      'duration_months', 'starts_on', 'expires_at'
    ];

    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        sets.push(`${key} = ?`);
        params.push(data[key]);
      }
    }
    if (sets.length === 0) return Job.findById(jobId);

    // Ownership is part of the WHERE, never a separate check: there is then no window
    // between "is this yours?" and "write it".
    params.push(jobId, companyUserId);
    await promisePool.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ? AND company_user_id = ?`, params);
    return Job.findById(jobId);
  }

  /** Publishing stamps `published_at` once, the first time only. */
  static async setStatus(jobId, companyUserId, status) {
    const [result] = await promisePool.query(
      `UPDATE jobs
          SET status = ?,
              published_at = CASE WHEN ? = 'open' AND published_at IS NULL THEN NOW() ELSE published_at END
        WHERE id = ? AND company_user_id = ?`,
      [status, status, jobId, companyUserId]
    );
    return result.affectedRows === 1;
  }

  /**
   * Bulk status change with an expectedCount interlock.
   *
   * The caller passes the number of rows the screen showed. If the filtered set has
   * changed since then — someone else edited a job, a job expired — the whole operation
   * aborts instead of acting on a set the operator never saw. Callers surface this as a
   * 409, not as a success.
   *
   * @throws {Error & {code:'BULK_COUNT_MISMATCH', actual:number, expected:number}}
   */
  static async bulkSetStatus(filters, status, expectedCount, companyUserId) {
    return withTransaction(async (conn) => {
      // The SAME builder the list view used, plus a hard ownership scope.
      const { clause, params } = buildFilter({ ...filters, company_user_id: companyUserId });

      const [[{ actual }]] = await conn.query(
        `SELECT COUNT(*) AS actual FROM jobs j WHERE ${clause} FOR UPDATE`,
        params
      );

      if (actual !== expectedCount) {
        const err = new Error(
          `Bulk update aborted: ${actual} jobs now match this filter, but the screen showed ${expectedCount}.`
        );
        err.code = 'BULK_COUNT_MISMATCH';
        err.actual = actual;
        err.expected = expectedCount;
        throw err;
      }

      const [result] = await conn.query(
        `UPDATE jobs j
            SET j.status = ?,
                j.published_at = CASE WHEN ? = 'open' AND j.published_at IS NULL THEN NOW() ELSE j.published_at END
          WHERE ${clause}`,
        [status, status, ...params]
      );
      return result.affectedRows;
    });
  }

  static async findById(jobId) {
    const [rows] = await promisePool.query(
      `SELECT j.*, cp.company_name, cp.slug AS company_slug, cp.logo AS company_logo,
              cp.website AS company_website, cp.company_type
         FROM jobs j
         LEFT JOIN company_profiles cp ON cp.user_id = j.company_user_id
        WHERE j.id = ? LIMIT 1`,
      [jobId]
    );
    return rows[0] || null;
  }

  static async findBySlug(slug) {
    const [rows] = await promisePool.query(
      `SELECT j.*, cp.company_name, cp.slug AS company_slug, cp.logo AS company_logo,
              cp.website AS company_website, cp.company_type,
              ${FEATURED_EXPR} AS is_featured
         FROM jobs j
         LEFT JOIN company_profiles cp ON cp.user_id = j.company_user_id
        WHERE j.slug = ? LIMIT 1`,
      [slug]
    );
    return rows[0] || null;
  }

  static async browse(filters = {}, { limit = 20, offset = 0, sort = 'newest' } = {}) {
    const { clause, params } = buildFilter(filters);
    const orderBy = orderByFor(sort);

    const [rows] = await promisePool.query(
      `SELECT j.id, j.title, j.slug, j.role, j.seniority, j.engagement_type, j.work_mode,
              j.country, j.city, j.rate_min, j.rate_max, j.currency, j.rate_visible,
              j.duration_months, j.published_at, j.application_count, j.status,
              LEFT(j.description, 600) AS description_snippet,
              cp.company_name, cp.slug AS company_slug, cp.logo AS company_logo,
              ${FEATURED_EXPR} AS is_featured
         FROM jobs j
         LEFT JOIN company_profiles cp ON cp.user_id = j.company_user_id
        WHERE ${clause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await promisePool.query(`SELECT COUNT(*) AS total FROM jobs j WHERE ${clause}`, params);
    return { rows, total };
  }

  /**
   * The published figures of the adverts a filter selects, for the rate index's "Day rate
   * budgets" and "Annual salaries". Through `buildFilter` like every list, so a job that is
   * closed, expired or taken down is not counted, and with `rate_published` so a hidden
   * rate stays hidden.
   */
  static async rateRows(filters = {}) {
    const { clause, params } = buildFilter({ ...filters, rate_published: true });
    const [rows] = await promisePool.query(
      `SELECT j.role, j.seniority, j.engagement_type, j.rate_min, j.rate_max, j.currency, j.published_at
         FROM jobs j
        WHERE ${clause}`,
      params
    );
    return rows;
  }

  /*
   * Counts per value of one filter field, for the board's checkbox groups — the usual facet
   * rule: the field's OWN selection is left out (ticking Albania must not make Germany read
   * 0), every other field's selection applies. The column comes from this fixed map, never
   * from the caller, because a column name cannot be a placeholder.
   */
  static async facet(field, filters = {}) {
    const column = FACET_COLUMNS[field];
    if (!column) throw new Error(`No facet for "${field}"`);
    const { clause, params } = buildFilter({ ...filters, [field]: undefined });
    const [rows] = await promisePool.query(
      `SELECT ${column} AS value, COUNT(*) AS count FROM jobs j
        WHERE ${clause} AND ${column} IS NOT NULL
        GROUP BY ${column} ORDER BY count DESC, ${column}`,
      params
    );
    return rows;
  }

  /** Counts per role for the browse sidebar, using the same filter minus `role`. */
  static async facetByRole(filters = {}) {
    return (await Job.facet('role', filters)).map((r) => ({ role: r.value, count: r.count }));
  }

  /** Which of these jobs the user has saved, as a Set of ids — one query for a whole page. */
  static async savedIdsFor(userId, jobIds) {
    if (!userId || !jobIds || jobIds.length === 0) return new Set();
    const [rows] = await promisePool.query(
      'SELECT job_id FROM saved_jobs WHERE user_id = ? AND job_id IN (?)',
      [userId, jobIds]
    );
    return new Set(rows.map((r) => r.job_id));
  }

  static async incrementViews(jobId) {
    // Best effort: a lost view count is not worth failing a page render over.
    try {
      await promisePool.query('UPDATE jobs SET view_count = view_count + 1 WHERE id = ?', [jobId]);
    } catch (err) {
      console.error(`View increment failed for job ${jobId}: ${err.message}`);
    }
  }

  static async setModules(jobId, moduleSlugs) {
    await promisePool.query('DELETE FROM job_modules WHERE job_id = ?', [jobId]);
    if (!moduleSlugs || moduleSlugs.length === 0) return;
    const values = moduleSlugs.map((slug) => [jobId, slug]);
    await promisePool.query('INSERT IGNORE INTO job_modules (job_id, module_slug) VALUES ?', [values]);
  }

  static async modulesFor(jobId) {
    const [rows] = await promisePool.query('SELECT module_slug FROM job_modules WHERE job_id = ?', [jobId]);
    return rows.map((r) => r.module_slug);
  }

  static async remove(jobId, companyUserId) {
    const [result] = await promisePool.query('DELETE FROM jobs WHERE id = ? AND company_user_id = ?', [jobId, companyUserId]);
    return result.affectedRows === 1;
  }

  static async saveForUser(userId, jobId) {
    const [result] = await promisePool.query('INSERT IGNORE INTO saved_jobs (user_id, job_id) VALUES (?, ?)', [userId, jobId]);
    return result.affectedRows === 1;
  }

  static async unsaveForUser(userId, jobId) {
    const [result] = await promisePool.query('DELETE FROM saved_jobs WHERE user_id = ? AND job_id = ?', [userId, jobId]);
    return result.affectedRows === 1;
  }

  static async isSaved(userId, jobId) {
    const [rows] = await promisePool.query('SELECT 1 FROM saved_jobs WHERE user_id = ? AND job_id = ? LIMIT 1', [userId, jobId]);
    return rows.length > 0;
  }

  /**
   * The jobs a user saved, closed ones included — a bookmark outlives the advert, and the
   * saved page says "No longer open" rather than letting the row vanish without a word.
   *
   * `is_open` is the board's own visibility rule (open, not expired, not taken down), so a
   * card offering Apply is a card the board would show. The columns are the board's
   * (`browse`) so the shared job card has everything it renders: this query once left out
   * `seniority`, and every saved card carried an empty pill where the level should be.
   */
  static async listSaved(userId, { limit = 20, offset = 0 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT j.id, j.title, j.slug, j.role, j.seniority, j.engagement_type, j.work_mode,
              j.country, j.city, j.rate_min, j.rate_max, j.currency, j.rate_visible,
              j.duration_months, j.published_at, j.status,
              LEFT(j.description, 600) AS description_snippet,
              cp.company_name, cp.slug AS company_slug, cp.logo AS company_logo,
              ${FEATURED_EXPR} AS is_featured,
              (j.status = 'open' AND (j.expires_at IS NULL OR j.expires_at > NOW())
                AND j.admin_hidden_at IS NULL) AS is_open,
              sj.created_at AS saved_at
         FROM saved_jobs sj
         JOIN jobs j ON j.id = sj.job_id
         LEFT JOIN company_profiles cp ON cp.user_id = j.company_user_id
        WHERE sj.user_id = ?
        ORDER BY sj.created_at DESC, sj.job_id DESC
        LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    return rows.map((r) => ({ ...r, is_open: Boolean(Number(r.is_open)) }));
  }

  static async countSaved(userId) {
    const [rows] = await promisePool.query('SELECT COUNT(*) AS n FROM saved_jobs WHERE user_id = ?', [userId]);
    return Number(rows[0].n) || 0;
  }

  /**
   * When the current featured placement on a job runs out, or null if none is open.
   *
   * MAX rather than "the latest row": renewals overlap deliberately, so the window that
   * matters is the furthest-out end date, not the most recently bought one.
   */
  static async featuredUntil(jobId) {
    const [rows] = await promisePool.query(
      'SELECT MAX(ends_at) AS ends_at FROM job_features WHERE job_id = ? AND ends_at > NOW()',
      [jobId]
    );
    return (rows[0] && rows[0].ends_at) || null;
  }
}

module.exports = Job;
