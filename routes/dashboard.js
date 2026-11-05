'use strict';

const express = require('express');

const Job = require('../models/Job');
const Application = require('../models/Application');
const ConsultantProfile = require('../models/ConsultantProfile');
const Skill = require('../models/Skill');
const Notification = require('../models/Notification');
const User = require('../models/User');
const SalesAgent = require('../models/SalesAgent');
const config = require('../config/config');
const { isAuthenticated, isCompany, isConsultant } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { matchScore } = require('../utils/jobMatcher');
const appStats = require('../utils/applicationStats');
const ConsultantDocument = require('../models/ConsultantDocument');

const router = express.Router();

/** How many of an agent's sign-ups their own card lists; the count beside it is the full COUNT. */
const AGENT_LIST_CAP = 50;

router.use(isAuthenticated);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.session.user;

    const [unread, savedJobs] = await Promise.all([
      Notification.unreadCount(user.id),
      Job.listSaved(user.id, { limit: 5 })
    ]);

    let consultant = null;
    let company = null;

    if (user.isConsultant) {
      const [profile, applications, consultantSkillIds] = await Promise.all([
        ConsultantProfile.ensureExists(user.id),
        Application.listForConsultant(user.id, { limit: 5 }),
        Skill.idsForConsultant(user.id)
      ]);

      // Recommendations are computed from the same scorer the job page shows, so the
      // number a consultant sees on a job is the number that ranked it here.
      const { rows: openJobs } = await Job.browse({}, { limit: 60, sort: 'newest' });
      const recommended = openJobs
        .map((job) => ({ job, ...matchScore(job, profile, { consultantSkillIds }) }))
        .filter((r) => r.score >= 40)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      consultant = { profile, applications, recommended };
    }

    if (user.isCompany) {
      const [{ rows: jobs, total }, statusCounts] = await Promise.all([
        Job.browse({ company_user_id: user.id, status: 'open' }, { limit: 5 }),
        Application.statusCountsForCompany(user.id)
      ]);
      company = { jobs, totalOpen: total, statusCounts };
    }

    /*
     * A sales agent's own link and who came through it (migration 031). Being an agent is a
     * row in `sales_agents`, not a role flag, so it is asked here rather than read from the
     * session — and an account that is not one costs this one indexed lookup.
     */
    let salesAgent = null;
    const agentStats = await SalesAgent.statsFor(user.id);
    if (agentStats) {
      const people = (await SalesAgent.peopleFor([user.id], { perAgent: AGENT_LIST_CAP }))[user.id] || [];
      salesAgent = { ...agentStats, link: `${config.app.baseUrl}/s/${agentStats.code}`, people, cap: AGENT_LIST_CAP };
    }

    res.render('dashboard/index', {
      title: 'Dashboard',
      unreadNotifications: unread,
      savedJobs,
      consultant,
      company,
      salesAgent
    });
  })
);

/**
 * One small JSON call for the account-menu panel's notification preview, fetched lazily
 * when the menu opens rather than on every page render — the same reason the unread badge
 * is a separate fetch instead of a server-side include.
 */
router.get(
  '/nav-summary',
  asyncHandler(async (req, res) => {
    const notifications = await Notification.listFor(req.session.user.id, { limit: 4 });
    res.json({
      success: true,
      notifications: notifications.map((n) => ({
        id: n.id,
        title: n.title,
        link: n.link,
        unread: !n.read_at
      }))
    });
  })
);

router.get(
  '/jobs',
  isCompany,
  asyncHandler(async (req, res) => {
    const status = ['draft', 'open', 'paused', 'filled', 'closed'].includes(req.query.status) ? req.query.status : '';
    const filters = { company_user_id: req.session.user.id, status: status || 'open' };

    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const { rows, total } = await Job.browse(filters, { limit, offset, sort: 'newest' });

    res.render('dashboard/jobs', {
      title: 'Your jobs',
      jobs: rows,
      status: filters.status,
      // Passed to the bulk form as the interlock value: if the set has changed by the
      // time the operator submits, the model aborts rather than acting on unseen rows.
      expectedCount: total,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/dashboard/jobs', req.query, p)
    });
  })
);

/*
 * THE BOARD: every application across every role, in one place.
 *
 * The per-job pipeline (`/applications/job/:slug`) answers "who applied for this role".
 * It does not answer "what is waiting for me", which is the question somebody hiring for
 * five roles actually opens the site with — and answering it meant opening five pages and
 * holding the total in your head.
 *
 * It is READ-ONLY on purpose. Every transition still happens on the application's own page,
 * where the state machine, the audit event and the notification are already written in one
 * transaction. A board that moved rows itself would be a second write path into the same
 * table, and the first one to drift is the one nobody is looking at.
 */
const SINCE_OPTIONS = [
  { value: '', label: 'Any time' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' }
];

/** The pipeline in order, then the two ways an application ends. */
const BOARD_COLUMNS = ['submitted', 'reviewing', 'shortlisted', 'interviewing', 'offered', 'hired', 'rejected', 'withdrawn'];

/*
 * The columns the board actually draws.
 *
 * `rejected` and `withdrawn` are OUTCOMES, not stages somebody works through, and drawing
 * them pushed the six live stages off the right edge — the two columns nobody opens the
 * board for were the two taking up the room. Their counts are still on the tabs above, and
 * the tab opens the full list, so nothing is hidden; it is just not occupying a sixth of
 * the width by default.
 */
const BOARD_STAGES = BOARD_COLUMNS.filter((s) => !['rejected', 'withdrawn'].includes(s));

/** At most this many cards per column before the column offers its own filtered page. */
const CARDS_PER_COLUMN = 6;

router.get(
  '/applicants',
  isCompany,
  asyncHandler(async (req, res) => {
    const user = req.session.user;

    // Read named fields and drop anything not declared, rather than spreading the query.
    const jobId = /^\d+$/.test(req.query.job || '') ? Number(req.query.job) : null;
    const sinceDays = SINCE_OPTIONS.some((o) => o.value && o.value === req.query.since)
      ? Number(req.query.since)
      : null;
    const status = BOARD_COLUMNS.includes(req.query.status) ? req.query.status : '';

    const filters = { jobId, sinceDays, status };
    const [counts, jobs] = await Promise.all([
      Application.countsForCompany(user.id, filters),
      Application.jobsWithApplications(user.id)
    ]);

    // A named job that is not this company's produces no rows anyway — the scope is in the
    // builder — but saying so beats rendering an empty board with a filter nobody chose.
    const selectedJob = jobId ? jobs.find((j) => j.id === jobId) || null : null;

    const { page, perPage, limit, offset } = paginationFrom(req.query);

    if (status) {
      // One status: a full, paginated list rather than a column with a lid on it.
      const { rows, total } = await Application.browseForCompany(user.id, filters, { limit, offset });
      return res.render('dashboard/applicants', {
        title: 'Applicants',
        mode: 'list',
        applications: rows,
        columns: BOARD_COLUMNS,
        counts,
        jobs,
        selectedJob,
        filters: { job: jobId || '', since: req.query.since || '', status },
        sinceOptions: SINCE_OPTIONS,
        total,
        pagination: paginationMeta({ page, perPage, total }),
        pageUrl: (p) => pageUrl('/dashboard/applicants', req.query, p)
      });
    }

    /*
     * The board. One query per column rather than one query sliced in memory: a company
     * with a thousand applications would otherwise fetch all of them to show six per
     * column, and the LIMIT is the whole point of a capped column.
     */
    const columns = await Promise.all(
      BOARD_STAGES.map(async (columnStatus) => {
        const shown = counts[columnStatus] || 0;
        if (shown === 0) return { status: columnStatus, total: 0, rows: [] };
        const { rows } = await Application.browseForCompany(
          user.id,
          { ...filters, status: columnStatus },
          { limit: CARDS_PER_COLUMN, offset: 0 }
        );
        return { status: columnStatus, total: shown, rows };
      })
    );

    return res.render('dashboard/applicants', {
      title: 'Applicants',
      mode: 'board',
      columns: BOARD_COLUMNS,
      board: columns,
      cardsPerColumn: CARDS_PER_COLUMN,
      counts,
      jobs,
      selectedJob,
      filters: { job: jobId || '', since: req.query.since || '', status: '' },
      sinceOptions: SINCE_OPTIONS,
      total: Object.values(counts).reduce((sum, n) => sum + n, 0)
    });
  })
);

/*
 * The consultant's application tracker.
 *
 * Everything listed goes through `Application.buildFilter` with the consultant scope — the
 * same builder the company board uses — so a tab's count is the number of rows behind it.
 * The whole state is in the query string (view, status, type, search, sort), so a filtered
 * list is a link and Back works.
 *
 * With no applications at all the page is a starting point instead of an empty table:
 * readiness (profile and CV), roles that match the profile, and saved roles to apply to.
 */
const APP_VIEWS = ['active', 'archived', 'all'];
const APP_SORTS = { recent: 'Last updated', newest: 'Newest first', oldest: 'Oldest first' };

router.get(
  '/applications',
  isConsultant,
  asyncHandler(async (req, res) => {
    const userId = req.session.user.id;
    const status = Application.STATUSES.includes(req.query.status) ? req.query.status : '';
    // Picking a status means "show me those", wherever they live, so it opens on All.
    const view = APP_VIEWS.includes(req.query.view) ? req.query.view : status ? 'all' : 'active';
    const engagement = ['contract', 'permanent'].includes(req.query.type) ? req.query.type : '';
    const q = req.query.q ? String(req.query.q).trim().slice(0, 120) : '';
    const sort = Object.prototype.hasOwnProperty.call(APP_SORTS, req.query.sort) ? req.query.sort : 'recent';
    const filters = {
      status,
      engagement,
      q,
      archived: view === 'active' ? false : view === 'archived' ? true : undefined
    };

    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const [{ rows, total }, counts, statsRows, overall] = await Promise.all([
      Application.browseForConsultant(userId, filters, { limit, offset, sort }),
      Application.countsForConsultant(userId, filters),
      Application.statsRowsForConsultant(userId),
      // Unfiltered: "has this person ever applied" decides the empty state, not a search.
      q || engagement ? Application.countsForConsultant(userId, {}) : null
    ]);
    const hasAny = (overall || counts).total > 0;

    const eventsById = await Application.eventsFor(rows.map((r) => r.id));
    const now = new Date();
    const applications = rows.map((a) => ({
      ...a,
      timeline: appStats.timeline(a, eventsById[a.id] || []),
      followUp: appStats.followUpDue(a, now)
    }));

    // Readiness and suggestions: always computed for the empty state, and readiness alone
    // when there are applications (shown only if something is missing).
    const [profile, documents] = await Promise.all([
      ConsultantProfile.ensureExists(userId),
      ConsultantDocument.listFor(userId)
    ]);
    const readiness = {
      completeness: profile ? profile.completeness : 0,
      hasCv: documents.some((d) => d.kind === 'cv'),
      enough: ConsultantProfile.MIN_COMPLETENESS_TO_PUBLISH
    };

    /*
     * Saved roles and suggestions show in BOTH states: with no applications they are the way
     * in, with some they are what to do next. Anything already applied for is left out of
     * both, and suggestions need a profile complete enough to match against — a match % from
     * a half-empty profile is a number that means nothing.
     */
    const [consultantSkillIds, { rows: openJobs }, savedJobs, appliedIds] = await Promise.all([
      Skill.idsForConsultant(userId),
      Job.browse({}, { limit: 60, sort: 'newest' }),
      Job.listSaved(userId, { limit: 12 }),
      Application.appliedJobIds(userId)
    ]);
    const saved = savedJobs.filter((j) => j.status === 'open' && !appliedIds.has(j.id)).slice(0, 6);
    /*
     * With no applications only real matches (40%+) are offered: they are the way in. Below
     * a list, the row is "what to look at next", and it used to vanish without a word once
     * every role left above 40% had been applied for — so there it shows the three closest
     * open roles whatever their score, with the score, and says when none is a close match.
     */
    const scored = (!hasAny || readiness.completeness >= readiness.enough)
      ? openJobs
        .filter((job) => !appliedIds.has(job.id))
        // The same scorer the job page and the dashboard use, so the % here is the % there.
        .map((job) => ({ job, ...matchScore(job, profile, { consultantSkillIds }) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
      : [];
    const recommended = hasAny ? scored.slice(0, 3) : scored.filter((r) => r.score >= 40).slice(0, 4);
    const recommendedWeak = recommended.length > 0 && recommended[0].score < 40;

    const query = { view, status, type: engagement, q, sort };
    res.render('dashboard/applications', {
      title: 'Your applications',
      applications,
      total,
      counts,
      hasAny,
      stats: appStats.summary(statsRows, now),
      statusLabels: appStats.STATUS_LABELS,
      statusOrder: appStats.STATUS_ORDER,
      followUpDays: appStats.FOLLOW_UP_DAYS,
      filters: query,
      sorts: APP_SORTS,
      readiness,
      recommended,
      recommendedWeak,
      saved,
      // Every link on the page is built from the current query with one thing changed.
      linkWith: (change) => {
        const params = new URLSearchParams();
        const merged = { ...query, ...change };
        for (const [k, v] of Object.entries(merged)) if (v && !(k === 'sort' && v === 'recent') && !(k === 'view' && v === 'active')) params.set(k, v);
        const str = params.toString();
        return `/dashboard/applications${str ? `?${str}` : ''}`;
      },
      currentUrl: req.originalUrl,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/dashboard/applications', req.query, p)
    });
  })
);

router.get(
  '/saved',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const jobs = await Job.listSaved(req.session.user.id, { limit, offset });

    res.render('dashboard/saved', {
      title: 'Saved jobs',
      jobs,
      pagination: paginationMeta({ page, perPage, total: jobs.length + offset }),
      pageUrl: (p) => pageUrl('/dashboard/saved', req.query, p)
    });
  })
);

router.post(
  '/onboarded',
  asyncHandler(async (req, res) => {
    await User.markOnboarded(req.session.user.id);
    res.json({ success: true });
  })
);

module.exports = router;
