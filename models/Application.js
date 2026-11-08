'use strict';

const { promisePool, withTransaction } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');

/**
 * The scope that means "every company", said out loud. A Symbol, so no value from a request,
 * a session or a database row can ever equal it by accident — only code that imports it.
 * Used by exactly one route, the superadmin oversight screen.
 */
const ALL_COMPANIES = Symbol('all companies');

/**
 * The hiring pipeline state machine.
 *
 * Transitions are declared, not implied. An undeclared transition is rejected rather
 * than silently written, so the pipeline cannot end up in a state the UI has no
 * rendering for and so "hired" can never be reached without passing through a decision.
 */
const TRANSITIONS = Object.freeze({
  submitted: ['reviewing', 'rejected', 'withdrawn'],
  reviewing: ['shortlisted', 'rejected', 'withdrawn'],
  shortlisted: ['interviewing', 'rejected', 'withdrawn'],
  interviewing: ['offered', 'rejected', 'withdrawn'],
  offered: ['hired', 'rejected', 'withdrawn'],
  hired: [],
  rejected: [],
  withdrawn: ['submitted']
});

const TERMINAL = Object.freeze(['hired', 'rejected']);

/*
 * Where an application belongs on the consultant's own page. "Archived" is the decided and
 * the dead: hired, rejected, withdrawn, or a role that is no longer open whatever the row
 * says. Declared once and used as a clause by buildFilter, so the tab and its count agree.
 */
const ARCHIVED_STATUSES = Object.freeze(['hired', 'rejected', 'withdrawn']);
const ARCHIVED_CLAUSE = "(a.status IN ('hired','rejected','withdrawn') OR j.status <> 'open')";

/** The consultant-side scope. A frozen object only this module builds; see buildFilter. */
function consultantScope(consultantUserId) {
  const id = Number(consultantUserId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('A consultant scope needs a user id.');
  return Object.freeze({ consultantUserId: id });
}

/** First sign of life from the company: opened, or moved, whichever came first. */
/*
 * "A move by the company" is read from WHICH transition happened, not from who the event
 * row names: the consultant can only withdraw, re-submit or accept an offer — and an offer is
 * itself a company move that comes first — so the earliest step that is not a withdrawal or a
 * submission is the company's, even when its actor was later erased and is NULL.
 */
function withSeenAt(row) {
  const times = [row.viewed_at, row.first_company_move_at].filter(Boolean).map((t) => new Date(t).getTime());
  return { ...row, seen_at: times.length ? new Date(Math.min(...times)) : null };
}

/**
 * What the CONSULTANT may do: withdraw, apply again after withdrawing, and answer an offer.
 * Accepting is offered -> hired; declining is a withdrawal. Everything else is the company's
 * decision. "Hired" still cannot be reached without a decision: the company's offer, then
 * the consultant's yes.
 */
const CONSULTANT_TRANSITIONS = Object.freeze(['withdrawn', 'submitted']);
function consultantMay(from, to) {
  return CONSULTANT_TRANSITIONS.includes(to) || (from === 'offered' && to === 'hired');
}

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

function isTerminal(status) {
  return TERMINAL.includes(status);
}

/*
 * The joins every query over `buildFilter` carries — the list, its total and its counts —
 * so a clause naming the candidate or the company resolves identically in all three. A
 * count with fewer joins than its list is the first thing to disagree with the page.
 */
const SCOPE_JOINS = `JOIN jobs j ON j.id = a.job_id
         JOIN users u ON u.id = a.consultant_user_id
         LEFT JOIN company_profiles comp ON comp.user_id = j.company_user_id`;

class Application {
  static get ALL_COMPANIES() {
    return ALL_COMPANIES;
  }

  static get STATUSES() {
    return Object.keys(TRANSITIONS);
  }

  static get TRANSITIONS() {
    return TRANSITIONS;
  }

  static canTransition = canTransition;

  static isTerminal = isTerminal;

  /**
   * Apply, or re-open a withdrawn application.
   *
   * The unique key on (job_id, consultant_user_id) makes this idempotent: a
   * double-submitted form updates the existing row rather than creating a duplicate.
   * The job's denormalised counter is only incremented when a row is actually inserted.
   */
  static async apply(jobId, consultantUserId, { coverLetter = null, dayRate = null, currency = 'EUR', availableFrom = null, cvDocumentId = null }) {
    return withTransaction(async (conn) => {
      const [[job]] = await conn.query(
        "SELECT id, status, company_user_id, title FROM jobs WHERE id = ? AND status = 'open' AND admin_hidden_at IS NULL FOR UPDATE",
        [jobId]
      );
      if (!job) {
        const err = new Error('This job is no longer accepting applications.');
        err.code = 'JOB_NOT_OPEN';
        throw err;
      }

      const [[existing]] = await conn.query(
        'SELECT id, status FROM applications WHERE job_id = ? AND consultant_user_id = ? FOR UPDATE',
        [jobId, consultantUserId]
      );

      if (existing) {
        if (isTerminal(existing.status)) {
          const err = new Error('This application has already been decided.');
          err.code = 'APPLICATION_CLOSED';
          throw err;
        }
        await conn.query(
          `UPDATE applications
              SET cover_letter = ?, day_rate = ?, currency = ?, available_from = ?, cv_document_id = ?, status = 'submitted'
            WHERE id = ?`,
          [coverLetter, dayRate, currency, availableFrom, cvDocumentId, existing.id]
        );
        await conn.query(
          'INSERT INTO application_events (application_id, actor_user_id, from_status, to_status, note) VALUES (?, ?, ?, ?, ?)',
          [existing.id, consultantUserId, existing.status, 'submitted', 'Application updated']
        );
        return { applicationId: existing.id, created: false, job };
      }

      const [result] = await conn.query(
        `INSERT INTO applications (job_id, consultant_user_id, cover_letter, day_rate, currency, available_from, cv_document_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [jobId, consultantUserId, coverLetter, dayRate, currency, availableFrom, cvDocumentId]
      );
      await conn.query(
        'INSERT INTO application_events (application_id, actor_user_id, from_status, to_status) VALUES (?, ?, NULL, ?)',
        [result.insertId, consultantUserId, 'submitted']
      );
      await conn.query('UPDATE jobs SET application_count = application_count + 1 WHERE id = ?', [jobId]);

      return { applicationId: result.insertId, created: true, job };
    });
  }

  /**
   * Move an application through the pipeline.
   *
   * `actorUserId` must own the job (employer side) or be the applicant (consultant
   * side); the caller establishes that. This method enforces the state machine and
   * writes the audit event in the same transaction as the status change, so the audit
   * can never be missing for a transition that happened.
   */
  static async transition(applicationId, actorUserId, toStatus, { note = null, actorIsEmployer = false } = {}) {
    return withTransaction(async (conn) => {
      const [[application]] = await conn.query('SELECT * FROM applications WHERE id = ? FOR UPDATE', [applicationId]);
      if (!application) {
        const err = new Error('Application not found.');
        err.code = 'NOT_FOUND';
        throw err;
      }

      if (!canTransition(application.status, toStatus)) {
        const err = new Error(`Cannot move an application from "${application.status}" to "${toStatus}".`);
        err.code = 'INVALID_TRANSITION';
        throw err;
      }

      if (!actorIsEmployer && !consultantMay(application.status, toStatus)) {
        const err = new Error('Only the hiring company can make this change.');
        err.code = 'FORBIDDEN';
        throw err;
      }

      await conn.query('UPDATE applications SET status = ? WHERE id = ?', [toStatus, applicationId]);
      await conn.query(
        'INSERT INTO application_events (application_id, actor_user_id, from_status, to_status, note) VALUES (?, ?, ?, ?, ?)',
        [applicationId, actorUserId, application.status, toStatus, note]
      );

      return { ...application, status: toStatus, previousStatus: application.status };
    });
  }

  /**
   * Whether this consultant has applied to any role this company posted. It is what lets a
   * company open the profile it was SENT even while the profile is private: applying is the
   * consultant choosing to show it to that company.
   */
  static async consultantAppliedToCompany(consultantUserId, companyUserId) {
    const [rows] = await promisePool.query(
      `SELECT 1 FROM applications a JOIN jobs j ON j.id = a.job_id
        WHERE a.consultant_user_id = ? AND j.company_user_id = ? LIMIT 1`,
      [consultantUserId, companyUserId]
    );
    return rows.length > 0;
  }

  static async findById(applicationId) {
    const [rows] = await promisePool.query(
      `SELECT a.*, j.title AS job_title, j.slug AS job_slug, j.company_user_id,
              u.name AS consultant_name, u.email AS consultant_email,
              cp.headline, cp.primary_role, cp.seniority, cp.country, cp.profile_picture,
              comp.company_name, d.title AS cv_title, d.filename AS cv_filename
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         JOIN users u ON u.id = a.consultant_user_id
         LEFT JOIN consultant_profiles cp ON cp.user_id = a.consultant_user_id
         LEFT JOIN company_profiles comp ON comp.user_id = j.company_user_id
         LEFT JOIN consultant_documents d ON d.id = a.cv_document_id AND d.user_id = a.consultant_user_id
        WHERE a.id = ? LIMIT 1`,
      [applicationId]
    );
    return rows[0] || null;
  }

  static async listForJob(jobId, { status = '', limit = 50, offset = 0 } = {}) {
    const where = ['a.job_id = ?'];
    const params = [jobId];
    if (status) {
      where.push('a.status = ?');
      params.push(status);
    }
    const clause = where.join(' AND ');

    const [rows] = await promisePool.query(
      `SELECT a.*, u.name AS consultant_name,
              cp.headline, cp.primary_role, cp.seniority, cp.country, cp.profile_picture,
              cp.linkedin_verified,
              (SELECT COUNT(*) FROM consultant_certifications cc WHERE cc.user_id = a.consultant_user_id) AS certification_count
         FROM applications a
         JOIN users u ON u.id = a.consultant_user_id
         LEFT JOIN consultant_profiles cp ON cp.user_id = a.consultant_user_id
        WHERE ${clause}
        ORDER BY FIELD(a.status,'offered','interviewing','shortlisted','reviewing','submitted','hired','rejected','withdrawn'),
                 a.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await promisePool.query(`SELECT COUNT(*) AS total FROM applications a WHERE ${clause}`, params);
    return { rows, total };
  }

  static async listForConsultant(consultantUserId, { limit = 30, offset = 0 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT a.*, j.title AS job_title, j.slug AS job_slug, j.status AS job_status,
              cp.company_name, cp.slug AS company_slug
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         LEFT JOIN company_profiles cp ON cp.user_id = j.company_user_id
        WHERE a.consultant_user_id = ?
        ORDER BY a.updated_at DESC
        LIMIT ? OFFSET ?`,
      [consultantUserId, limit, offset]
    );
    return rows;
  }

  static async events(applicationId) {
    const [rows] = await promisePool.query(
      `SELECT ae.*, u.name AS actor_name
         FROM application_events ae
         LEFT JOIN users u ON u.id = ae.actor_user_id
        WHERE ae.application_id = ?
        ORDER BY ae.created_at ASC, ae.id ASC`,
      [applicationId]
    );
    return rows;
  }

  /**
   * THE ONLY FILTER BUILDER FOR APPLICATIONS SEEN FROM THE HIRING SIDE.
   *
   * The board, its per-status counts and its paginated list all go through this, so the
   * number on a tab is provably the number of rows behind it. Two builders would let a
   * count and its list disagree, and here that disagreement is somebody being told they
   * have four people to review and finding three.
   *
   * `companyUserId` is not a filter, it is the scope: it is always applied and it comes
   * from the session, never from the query string. Everything else is optional and is
   * dropped when it is not one of the declared values.
   *
   * The superadmin oversight screen (`/admin/applications`) passes `ALL_COMPANIES` instead,
   * and that is the ONLY way to widen it. A missing scope throws rather than quietly meaning
   * "everybody": a forgotten argument must never become every company's pipeline behind one
   * URL. This is not the `include_hidden` escape hatch the job and profile builders refuse —
   * it cannot reveal anything a scoped call would hide, it only widens whose rows count.
   */
  static buildFilter(companyUserId, filters = {}) {
    const where = [];
    const params = [];
    if (companyUserId === ALL_COMPANIES) {
      // No company clause: the oversight screen, on purpose.
    } else if (companyUserId && typeof companyUserId === 'object' && Number.isInteger(companyUserId.consultantUserId)) {
      /*
       * The consultant's OWN applications (`Application.forConsultant(id)`, id from the
       * session). The same builder serves both sides of the table rather than a second one
       * for the consultant page: the clauses below mean the same thing from either side, and
       * a second builder is a second place for a list and its count to disagree.
       */
      where.push('a.consultant_user_id = ?');
      params.push(companyUserId.consultantUserId);
    } else if (companyUserId) {
      where.push('j.company_user_id = ?');
      params.push(companyUserId);
    } else {
      throw new Error('An application filter must be scoped to a company, or say ALL_COMPANIES.');
    }

    if (filters.status && Object.prototype.hasOwnProperty.call(TRANSITIONS, filters.status)) {
      where.push('a.status = ?');
      params.push(filters.status);
    } else if (filters.hideWithdrawn) {
      // Somebody who pulled out is not in play. One checkbox away, never gone.
      where.push("a.status <> 'withdrawn'");
    }
    if (filters.jobId) {
      where.push('a.job_id = ?');
      params.push(filters.jobId);
    }
    if (filters.archived === true) where.push(ARCHIVED_CLAUSE);
    if (filters.archived === false) where.push(`NOT ${ARCHIVED_CLAUSE}`);
    if (filters.engagement === 'contract' || filters.engagement === 'permanent') {
      where.push('j.engagement_type = ?');
      params.push(filters.engagement);
    }
    if (filters.sinceDays) {
      // Bounded by the caller against a declared list, so this can never become a
      // caller-supplied interval expression.
      where.push('a.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)');
      params.push(filters.sinceDays);
    }
    if (filters.q) {
      // Through likePattern, like every LIKE here: a search for `%` is a search for a
      // per-cent sign, not a full scan of the applications table. The advert and the
      // company are searched too, because the oversight screen is looking for "what
      // happened to that role" at least as often as for a person.
      const like = containsPattern(filters.q);
      where.push('(u.name LIKE ? OR j.title LIKE ? OR comp.company_name LIKE ?)');
      params.push(like, like, like);
    }
    /*
     * "Has reached this stage", from the append-only event log rather than the current
     * status: somebody who interviewed and was then turned down HAS interviewed.
     */
    if (filters.reached && Object.prototype.hasOwnProperty.call(TRANSITIONS, filters.reached)) {
      where.push('EXISTS (SELECT 1 FROM application_events ae WHERE ae.application_id = a.id AND ae.to_status = ?)');
      params.push(filters.reached);
    }
    /*
     * STALLED: submitted, never moved, and older than this many days. "Never moved" is read
     * from the event log rather than from `updated_at`, which any unrelated write refreshes.
     */
    if (Number.isInteger(filters.stalledDays) && filters.stalledDays > 0) {
      where.push("a.status = 'submitted'");
      where.push('a.created_at < DATE_SUB(NOW(), INTERVAL ? DAY)');
      params.push(filters.stalledDays);
      where.push('NOT EXISTS (SELECT 1 FROM application_events ae2 WHERE ae2.application_id = a.id AND ae2.from_status IS NOT NULL)');
    }

    return { clause: where.length ? where.join(' AND ') : '1 = 1', params };
  }

  /** One page of an employer's applications, across every role they have posted. */
  static async browseForCompany(companyUserId, filters = {}, { limit = 50, offset = 0 } = {}) {
    const { clause, params } = Application.buildFilter(companyUserId, filters);

    const [rows] = await promisePool.query(
      `SELECT a.id, a.status, a.day_rate, a.currency, a.created_at, a.updated_at,
              a.consultant_user_id,
              j.id AS job_id, j.title AS job_title, j.slug AS job_slug,
              u.name AS consultant_name,
              cp.headline, cp.primary_role, cp.seniority, cp.country, cp.profile_picture,
              cp.linkedin_verified,
              comp.company_name,
              (SELECT MAX(ae.created_at) FROM application_events ae
                WHERE ae.application_id = a.id AND ae.from_status IS NOT NULL) AS last_moved_at
         FROM applications a
         ${SCOPE_JOINS}
         LEFT JOIN consultant_profiles cp ON cp.user_id = a.consultant_user_id
        WHERE ${clause}
        ORDER BY a.updated_at DESC, a.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM applications a ${SCOPE_JOINS} WHERE ${clause}`,
      params
    );
    return { rows, total };
  }

  /**
   * How many applications sit at each status, under the SAME filters as the list.
   *
   * The status filter is deliberately dropped: a tab row whose own counts collapsed the
   * moment you picked a tab would make every other tab read as empty.
   */
  static async countsForCompany(companyUserId, filters = {}) {
    const { clause, params } = Application.buildFilter(companyUserId, { ...filters, status: '' });
    const [rows] = await promisePool.query(
      `SELECT a.status, COUNT(*) AS count
         FROM applications a ${SCOPE_JOINS}
        WHERE ${clause}
        GROUP BY a.status`,
      params
    );
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  }

  /** The roles that actually have applications, for the board's job filter. */
  static async jobsWithApplications(companyUserId) {
    const [rows] = await promisePool.query(
      `SELECT j.id, j.title, COUNT(a.id) AS application_count
         FROM jobs j JOIN applications a ON a.job_id = j.id
        WHERE j.company_user_id = ?
        GROUP BY j.id, j.title
        ORDER BY j.title ASC`,
      [companyUserId]
    );
    return rows;
  }

  static async statusCountsForCompany(companyUserId) {
    return Application.countsForCompany(companyUserId);
  }

  // ------------------------------------------------------------------ consultant side

  static forConsultant(consultantUserId) {
    return consultantScope(consultantUserId);
  }

  /**
   * One page of a consultant's applications with everything a row shows. `seen_at` is the
   * first sign of life from the company — the moment they opened it or the first move they
   * made, whichever came first — and is what "Viewed by company", the follow-up reminder and
   * the response-time figure all read.
   */
  static async browseForConsultant(consultantUserId, filters = {}, { limit = 20, offset = 0, sort = 'recent' } = {}) {
    const { clause, params } = Application.buildFilter(consultantScope(consultantUserId), filters);
    const order = {
      recent: 'a.updated_at DESC, a.id DESC',
      newest: 'a.created_at DESC, a.id DESC',
      oldest: 'a.created_at ASC, a.id ASC'
    }[sort] || 'a.updated_at DESC, a.id DESC';

    const [rows] = await promisePool.query(
      `SELECT a.id, a.status, a.day_rate, a.currency, a.created_at, a.updated_at, a.viewed_at,
              a.cv_document_id, a.job_id,
              j.title AS job_title, j.slug AS job_slug, j.status AS job_status, j.engagement_type,
              j.work_mode, j.country, j.city, j.rate_min, j.rate_max, j.currency AS job_currency, j.rate_visible,
              comp.company_name, comp.slug AS company_slug, comp.logo AS company_logo,
              d.title AS cv_title, d.filename AS cv_filename,
              n.body AS note,
              (SELECT MIN(ae.created_at) FROM application_events ae
                WHERE ae.application_id = a.id AND ae.to_status NOT IN ('submitted','withdrawn')) AS first_company_move_at
         FROM applications a
         ${SCOPE_JOINS}
         LEFT JOIN consultant_documents d ON d.id = a.cv_document_id AND d.user_id = a.consultant_user_id
         LEFT JOIN application_notes n ON n.application_id = a.id AND n.user_id = a.consultant_user_id
        WHERE ${clause}
        ORDER BY ${order}
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM applications a ${SCOPE_JOINS} WHERE ${clause}`,
      params
    );
    return { rows: rows.map(withSeenAt), total };
  }

  /** Per-status counts and the two tab totals, under the same filters minus status and tab. */
  static async countsForConsultant(consultantUserId, filters = {}) {
    const { clause, params } = Application.buildFilter(consultantScope(consultantUserId), { ...filters, status: '', archived: undefined });
    const [rows] = await promisePool.query(
      `SELECT a.status, ${ARCHIVED_CLAUSE} AS is_archived, COUNT(*) AS count
         FROM applications a ${SCOPE_JOINS}
        WHERE ${clause}
        GROUP BY a.status, is_archived`,
      params
    );
    const byStatus = {};
    let active = 0;
    let archived = 0;
    for (const r of rows) {
      const n = Number(r.count);
      byStatus[r.status] = (byStatus[r.status] || 0) + n;
      if (Number(r.is_archived)) archived += n;
      else active += n;
    }
    return { byStatus, active, archived, total: active + archived };
  }

  /** The roles this consultant has applied for, so suggestions do not repeat them. */
  static async appliedJobIds(consultantUserId) {
    const [rows] = await promisePool.query('SELECT job_id FROM applications WHERE consultant_user_id = ?', [consultantUserId]);
    return new Set(rows.map((r) => r.job_id));
  }

  /**
   * The consultant's application for each of these jobs, as a Map of job id → { id, status }:
   * one query for a page of saved jobs, so a card can say "Applied · In review" instead of
   * offering Apply twice.
   */
  static async statusByJob(consultantUserId, jobIds) {
    if (!consultantUserId || !jobIds || !jobIds.length) return new Map();
    const [rows] = await promisePool.query(
      'SELECT id, job_id, status FROM applications WHERE consultant_user_id = ? AND job_id IN (?)',
      [consultantUserId, jobIds]
    );
    return new Map(rows.map((r) => [r.job_id, { id: r.id, status: r.status }]));
  }

  /** Every event for a set of applications, grouped by application id — one query per page. */
  static async eventsFor(applicationIds) {
    if (!applicationIds.length) return {};
    const [rows] = await promisePool.query(
      `SELECT application_id, from_status, to_status, actor_user_id, created_at
         FROM application_events WHERE application_id IN (?)
        ORDER BY created_at ASC, id ASC`,
      [applicationIds]
    );
    const out = {};
    for (const r of rows) (out[r.application_id] = out[r.application_id] || []).push(r);
    return out;
  }

  /** The rows the summary figures are computed from (utils/applicationStats.js). */
  static async statsRowsForConsultant(consultantUserId) {
    const [rows] = await promisePool.query(
      `SELECT a.created_at, a.viewed_at,
              (SELECT MIN(ae.created_at) FROM application_events ae
                WHERE ae.application_id = a.id AND ae.to_status NOT IN ('submitted','withdrawn')) AS first_company_move_at
         FROM applications a
        WHERE a.consultant_user_id = ?
        ORDER BY a.created_at DESC
        LIMIT 1000`,
      [consultantUserId]
    );
    return rows.map(withSeenAt);
  }

  /**
   * The company opened the application. A conditional UPDATE that only ever sets the first
   * time: idempotent and writes no new row, so it is safe on the GET that triggers it — the
   * one exception to "no GET writes", because "opened" can only be observed on a read.
   */
  /**
   * The day rates consultants put on contract applications in the last `months`, one row per
   * application, for "Asked on applications" on /rates. Rows, not an AVG: the mean is taken
   * over PEOPLE in `rateAggregation.meanOfPeople`, with the same floor as the index.
   */
  static async askedDayRates({ months = 12 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT a.consultant_user_id AS user_id, a.day_rate, a.currency
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
        WHERE j.engagement_type = 'contract'
          AND a.day_rate IS NOT NULL AND a.day_rate > 0
          AND a.created_at >= DATE_SUB(NOW(), INTERVAL ? MONTH)`,
      [months]
    );
    return rows;
  }

  static async markViewed(applicationId) {
    await promisePool.query('UPDATE applications SET viewed_at = NOW() WHERE id = ? AND viewed_at IS NULL', [applicationId]);
  }

  /**
   * A private note, the consultant's only. Ownership is part of the INSERT ... SELECT, so a
   * note can only ever attach to an application the writer made. Empty clears it.
   */
  static async saveNote(applicationId, consultantUserId, body) {
    const text = String(body || '').trim().slice(0, 2000);
    if (!text) {
      await promisePool.query('DELETE FROM application_notes WHERE application_id = ? AND user_id = ?', [applicationId, consultantUserId]);
      return true;
    }
    const [r] = await promisePool.query(
      `INSERT INTO application_notes (application_id, user_id, body, updated_at)
       SELECT a.id, a.consultant_user_id, ?, NOW() FROM applications a WHERE a.id = ? AND a.consultant_user_id = ?
       ON DUPLICATE KEY UPDATE body = VALUES(body), updated_at = NOW()`,
      [text, applicationId, consultantUserId]
    );
    return r.affectedRows > 0;
  }

  /** The CV sent with an application, for its two parties only (the caller checks which). */
  static async sentCv(applicationId) {
    const [rows] = await promisePool.query(
      `SELECT d.id, d.filename, d.title, d.content_type, d.bytes
         FROM applications a JOIN consultant_documents d ON d.id = a.cv_document_id AND d.user_id = a.consultant_user_id
        WHERE a.id = ? LIMIT 1`,
      [applicationId]
    );
    return rows[0] || null;
  }
}

Application.ARCHIVED_STATUSES = ARCHIVED_STATUSES;
Application.consultantMay = consultantMay;

module.exports = Application;
