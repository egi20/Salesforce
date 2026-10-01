'use strict';

const express = require('express');

const Job = require('../models/Job');
const Application = require('../models/Application');
const ConsultantProfile = require('../models/ConsultantProfile');
const Skill = require('../models/Skill');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { isAuthenticated, isCompany, isConsultant } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { matchScore } = require('../utils/jobMatcher');

const router = express.Router();

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

    res.render('dashboard/index', {
      title: 'Dashboard',
      unreadNotifications: unread,
      savedJobs,
      consultant,
      company
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

router.get(
  '/applications',
  isConsultant,
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const applications = await Application.listForConsultant(req.session.user.id, { limit, offset });

    res.render('dashboard/applications', {
      title: 'Your applications',
      applications,
      pagination: paginationMeta({ page, perPage, total: applications.length + offset }),
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
