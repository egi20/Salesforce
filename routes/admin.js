'use strict';

const express = require('express');

const IssueReport = require('../models/IssueReport');
const PlacementQuote = require('../models/PlacementQuote');
const CompanyProfile = require('../models/CompanyProfile');
const { PLACEMENT_KINDS, PLACEMENT_STATUSES, kindLabel } = require('../config/placements');
const { CURRENCIES } = require('../config/finance');
const { ISSUE_KINDS, ISSUE_STATUSES } = require('../config/issues');
const User = require('../models/User');
const Job = require('../models/Job');
const Application = require('../models/Application');
const ErrorLog = require('../models/ErrorLog');
const RateSubmission = require('../models/RateSubmission');
const Payment = require('../models/Payment');
const { formatMinor } = require('../config/payments');
const ApiUsage = require('../models/ApiUsage');
const assistantConfig = require('../config/assistant');
const { budgetStatus } = require('../utils/aiBudget');
const Moderation = require('../models/Moderation');
const Post = require('../models/Post');
const AppSetting = require('../models/AppSetting');
const { DEFINITIONS: SETTING_DEFINITIONS } = require('../config/settings');
const { returnTo } = require('../utils/returnTo');
const Referral = require('../models/Referral');
const TaxEnquiry = require('../models/TaxEnquiry');
const SuccessStory = require('../models/SuccessStory');
const SiteReview = require('../models/SiteReview');
const ImageBlob = require('../models/ImageBlob');
const { singleImage } = require('../middleware/fileUpload');
const { CLOUD_FAMILIES } = require('../config/cloudFamilies');
const { TOPICS: ADVISORY_TOPICS, ARRANGEMENTS: ADVISORY_ARRANGEMENTS, STATUSES: ADVISORY_STATUSES, TRANSITIONS: ADVISORY_TRANSITIONS, RETENTION_DAYS: ADVISORY_RETENTION_DAYS } = require('../config/taxAdvisory');
const { PAYOUT_METHODS, MIN_PAYOUT_MINOR, DEFAULT_RATE_BPS } = require('../config/referrals');
const { promisePool } = require('../config/database');
const { isAuthenticated, isAdmin, isSuperadmin } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam, parseId } = require('../utils/ids');
const { toCsv } = require('../utils/csv');
const AccountErasure = require('../models/AccountErasure');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { TEST_SUITE, totalTestCount } = require('../config/adminTests');
const AdminTestRun = require('../models/AdminTestRun');
const { runSuite } = require('../utils/adminTestRunner');
const SiteStats = require('../models/SiteStats');
const SalesAgent = require('../models/SalesAgent');
const config = require('../config/config');
const { countryName } = require('../utils/geo');
const { donutSlices } = require('../utils/donutSlices');
const webAnalyticsConfig = require('../config/webAnalytics');
const webAnalyticsService = require('../services/webAnalytics');
const analyticsDashboard = require('../services/analyticsDashboard');
const { rangeFrom, rangeQuery, PRESETS: RANGE_PRESETS } = require('../utils/analyticsRange');

const router = express.Router();

router.use(isAuthenticated, isAdmin);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [[counts]] = await promisePool.query(
      `SELECT
         (SELECT COUNT(*) FROM users)                              AS users,
         (SELECT COUNT(*) FROM users WHERE is_active = 1)          AS active_users,
         (SELECT COUNT(*) FROM users WHERE email_verified = 1)     AS verified_users,
         (SELECT COUNT(*) FROM consultant_profiles WHERE is_public = 1) AS public_consultants,
         (SELECT COUNT(*) FROM company_profiles)                   AS companies,
         (SELECT COUNT(*) FROM jobs)                               AS jobs,
         (SELECT COUNT(*) FROM jobs WHERE status = 'open')         AS open_jobs,
         (SELECT COUNT(*) FROM applications)                       AS applications,
         (SELECT COUNT(*) FROM quotes)                             AS quotes,
         (SELECT COUNT(*) FROM posts WHERE hidden_at IS NULL)      AS posts,
         (SELECT COUNT(*) FROM payments WHERE needs_refund = 1)    AS refunds_due,
         (SELECT COUNT(*) FROM issue_reports WHERE status <> 'closed') AS open_issues,
         (SELECT COUNT(*) FROM error_logs WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)) AS recent_errors`
    );

    const [geo] = await promisePool.query(
      `SELECT country, SUM(visits) AS visits
         FROM visit_geo_daily
        WHERE day > DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY country ORDER BY visits DESC LIMIT 12`
    );

    res.render('admin/index', {
      title: 'Admin',
      counts,
      geo,
      rateContributors: await RateSubmission.totalContributors()
    });
  })
);

router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });
    const { rows, total } = await User.list({
      search: req.query.q || '',
      role: req.query.role || '',
      limit,
      offset
    });

    res.render('admin/users', {
      title: 'Users',
      users: rows,
      roles: User.ALL_ROLES,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/users', req.query, p)
    });
  })
);

/**
 * Role changes here are the ONLY way to remove a role or grant a privileged one.
 * Superadmin-gated, because granting `admin` from this form is a full escalation.
 */
router.post(
  '/users/:id/roles',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    if (req.params.id === req.session.user.id) {
      req.flash('error', 'You cannot change your own roles here.');
      return res.redirect('/admin/users');
    }

    /*
     * A superadmin's roles are not edited here. Superadmin is granted only from a shell
     * (`npm run create-admin`), so the people who hold it are decided by whoever can run
     * commands on the server — not by one superadmin clicking on another's row.
     */
    const target = await User.findById(req.params.id);
    if (!target) {
      req.flash('error', 'That account no longer exists.');
      return res.redirect('/admin/users');
    }
    if (target.is_superadmin) {
      req.flash('error', 'A superadmin is managed from the server shell, not from this page.');
      return res.redirect('/admin/users');
    }

    const submitted = Array.isArray(req.body.roles) ? req.body.roles : [req.body.roles].filter(Boolean);
    const roles = await User.adminSetRoles(req.params.id, submitted, { primary: req.body.primary || null });
    req.flash('success', `Roles set to: ${roles.join(', ') || 'none'}.`);
    return res.redirect('/admin/users');
  })
);

router.post(
  '/users/:id/active',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    if (req.params.id === req.session.user.id) {
      req.flash('error', 'You cannot deactivate your own account.');
      return res.redirect('/admin/users');
    }
    await User.setActive(req.params.id, req.body.is_active === 'on');
    req.flash('success', 'Account updated.');
    return res.redirect('/admin/users');
  })
);

/**
 * Admin-created and admin-promoted accounts are force-verified.
 * Without this, an account whose owner never received a confirmation e-mail could never
 * sign in at all, because login refuses unverified non-admin accounts.
 */
router.post(
  '/users/:id/verify',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    await User.setEmailVerified(req.params.id);
    req.flash('success', 'Email marked as verified.');
    return res.redirect('/admin/users');
  })
);

/* ------------------------------------------------------- erasing an account */

/** The most accounts one bulk erasure may touch: each is its own transaction. */
const BULK_ERASE_MAX = 50;

/**
 * Erase an account on somebody's behalf, through `models/AccountErasure.js` and NOTHING
 * else — it is the single eraser, a test forbids `DELETE FROM users` anywhere outside it,
 * and it anonymises rather than deletes for the reasons CLAUDE.md gives (a published
 * percentile, other people's threads, financial records under a retention period).
 *
 * SUPERADMIN, and refused on your own account here (the self-service path is
 * `/profile/close`, which shows the person what goes and what stays). A superadmin target
 * is refused by `AccountErasure.erase` itself: an erased account cannot sign in, and the
 * superadmin role is granted and removed only from the server shell, never from this page.
 */
async function eraseByAdmin(req, id) {
  if (id === req.session.user.id) {
    return { ok: false, message: 'That is your own account. Close it from your own profile, where you can see what goes and what stays.' };
  }
  try {
    await AccountErasure.erase(id, { reason: `admin:${req.session.user.id}` });
    return { ok: true };
  } catch (err) {
    if (!['NOT_FOUND', 'ALREADY_ERASED', 'SUPERADMIN'].includes(err.code)) throw err;
    return { ok: false, message: err.message };
  }
}

/**
 * POST /admin/users/:id/delete — erase one account.
 *
 * Confirmed by TYPING the account's email address, not by a checkbox: an account erased by
 * accident cannot be handed back, because the whole point is that the data is gone — and
 * typing the address is what proves the person is looking at the row they think they are.
 */
router.post(
  '/users/:id/delete',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const back = returnTo(req, '/admin/users');
    const target = await User.findById(req.params.id);
    if (!target) {
      req.flash('error', 'That account no longer exists.');
      return res.redirect(back);
    }
    const typed = typeof req.body.confirm === 'string' ? req.body.confirm.trim().toLowerCase() : '';
    if (!typed || typed !== String(target.email).toLowerCase()) {
      req.flash('error', "Type the account's email address exactly to confirm. Nothing has been changed.");
      return res.redirect(back);
    }
    const result = await eraseByAdmin(req, req.params.id);
    if (result.ok) {
      req.flash('success', `Erased ${target.email}. Their personal data is gone; shared records are kept, anonymised.`);
    } else {
      req.flash('error', result.message);
    }
    return res.redirect(back);
  })
);

/**
 * POST /admin/users/bulk-delete — erase several accounts.
 *
 * The confirmation IS the count interlock, so it works without scripting: the person types
 * `ERASE` and the number of accounts they ticked. A mismatch means the form was not the one
 * they read, and nothing is erased — the same interlock `Job.bulkSetStatus` holds with its
 * `expectedCount`. Each id is checked the way `requireIdParam` checks one.
 */
router.post(
  '/users/bulk-delete',
  isSuperadmin,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const back = returnTo(req, '/admin/users');
    const submitted = [].concat(req.body.ids || []);
    const ids = [...new Set(submitted.map((v) => parseId(String(v))).filter(Boolean))];
    if (!ids.length || ids.length !== submitted.length || ids.length > BULK_ERASE_MAX) {
      req.flash('error', ids.length > BULK_ERASE_MAX ? `At most ${BULK_ERASE_MAX} accounts at a time.` : 'Select at least one account.');
      return res.redirect(back);
    }
    const typed = typeof req.body.confirm === 'string' ? req.body.confirm.trim().toUpperCase() : '';
    if (typed !== `ERASE ${ids.length}`) {
      req.flash('error', `Type ERASE ${ids.length} to confirm erasing the ${ids.length} selected account${ids.length === 1 ? '' : 's'}. Nothing has been changed.`);
      return res.redirect(back);
    }

    let erased = 0;
    const refused = [];
    for (const id of ids) {
      // One at a time: each erasure is its own transaction with its own checks.
      // eslint-disable-next-line no-await-in-loop
      const result = await eraseByAdmin(req, id);
      if (result.ok) erased += 1;
      else refused.push(`#${id}: ${result.message}`);
    }
    if (erased) req.flash('success', `Erased ${erased} account${erased === 1 ? '' : 's'}. Personal data is gone; shared records are kept, anonymised.`);
    if (refused.length) req.flash('error', `Not erased — ${refused.join(' ')}`);
    return res.redirect(back);
  })
);

/**
 * POST /admin/users/:id/talent — take a consultant profile out of the directory, or put it
 * back.
 *
 * ADMIN, not superadmin, and deliberately: this is moderation, which is what an ordinary
 * administrator is for. It is also why it is not the Disable button — the account keeps
 * working, and the only thing that goes is the public listing. `Moderation.setProfileHidden`
 * is the single writer, so the decision lands in the same log as every other one.
 */
router.post(
  '/users/:id/talent',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const back = returnTo(req, '/admin/users');
    if (req.params.id === req.session.user.id) {
      req.flash('error', 'That is your own profile.');
      return res.redirect(back);
    }
    const hidden = req.body.hidden === 'on';
    try {
      const result = await Moderation.setProfileHidden(req.params.id, hidden, {
        actorUserId: req.session.user.id,
        reason: (req.body.reason || '').trim() || null
      });
      if (!result.changed) req.flash('info', 'Somebody had already done that.');
      else req.flash('success', hidden
        ? 'Taken out of the directory. The account still works; only the public listing is gone.'
        : 'Our decision is cleared. Whether it appears again is their own publish switch.');
    } catch (err) {
      if (err.code !== 'NOT_FOUND') throw err;
      req.flash('error', err.message);
    }
    return res.redirect(back);
  })
);

/**
 * POST /admin/jobs/:id/hidden — take an advert off the board, or put it back.
 *
 * NOT "delete the job", and not a status change: the applications made to it, their events
 * and the conversations anchored to it belong to other people, and an advertiser moves
 * their own `status` freely, so a moderator writing `closed` there would be overruled by
 * the next press of Reopen. There is deliberately no admin path that creates or edits an
 * advert either: an advert written here would name a company that did not write it.
 */
router.post(
  '/jobs/:id/hidden',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const back = returnTo(req, '/admin/jobs');
    const hidden = req.body.hidden === 'on';
    try {
      const result = await Moderation.setJobHidden(req.params.id, hidden, {
        actorUserId: req.session.user.id,
        reason: (req.body.reason || '').trim() || null
      });
      if (!result.changed) req.flash('info', 'Somebody had already done that.');
      else req.flash('success', hidden
        ? `"${result.job.title}" is off the board. The applications already made to it stay.`
        : "Our decision is cleared. Whether it is live again is the advertiser's own status.");
    } catch (err) {
      if (err.code !== 'NOT_FOUND') throw err;
      req.flash('error', err.message);
    }
    return res.redirect(back);
  })
);

router.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });
    const status = ['draft', 'open', 'paused', 'filled', 'closed'].includes(req.query.status) ? req.query.status : 'open';
    const { rows, total } = await Job.browse({ status }, { limit, offset, sort: 'newest' });

    res.render('admin/jobs', {
      title: 'Jobs',
      jobs: rows,
      status,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/jobs', req.query, p)
    });
  })
);

router.get(
  '/errors',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 50 });
    const { rows, total } = await ErrorLog.list({ limit, offset });

    res.render('admin/errors', {
      title: 'Error log',
      errors: rows,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/errors', req.query, p)
    });
  })
);

/**
 * GET /admin/errors/export.csv — the rows the screen lists, as a file.
 *
 * Without the stack trace (see `ErrorLog.exportRows`), and through `utils/csv.js`, which
 * neutralises a cell that would run as a spreadsheet formula: the path and the message are
 * text any stranger can choose by making a request. Same guard as the screen.
 */
router.get(
  '/errors/export.csv',
  asyncHandler(async (req, res) => {
    const rows = await ErrorLog.exportRows();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="errors.csv"');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(toCsv(['created_at', 'status_code', 'method', 'path', 'message', 'user_id'], rows));
  })
);

/**
 * GET /admin/payments — the money view, and the refund queue.
 *
 * The queue is the point of the page. A payment flagged `needs_refund` is money that
 * arrived and could not be fulfilled — almost always two checkout tabs open against one
 * quote, where the schema let exactly one of them settle it. Nothing reverses those
 * automatically: a refund is a decision with a person on the other end of it, and a
 * webhook handler issuing one has neither the context nor the accountability for it.
 */
router.get(
  '/payments',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });

    const [[totals]] = await promisePool.query(
      `SELECT
         (SELECT COUNT(*) FROM payments WHERE status = 'paid')                     AS paid_count,
         (SELECT COALESCE(SUM(amount_minor), 0) FROM payments WHERE status = 'paid') AS paid_minor,
         (SELECT COUNT(*) FROM payments WHERE status = 'pending')                  AS pending_count,
         (SELECT COUNT(*) FROM payments WHERE needs_refund = 1)                    AS refund_count,
         (SELECT COUNT(*) FROM invoices)                                           AS invoices`
    );

    const [rows] = await promisePool.query(
      `SELECT p.*, u.email, i.number AS invoice_number
         FROM payments p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN invoices i ON i.payment_id = p.id
        ORDER BY p.created_at DESC
        LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    const [[{ total }]] = await promisePool.query('SELECT COUNT(*) AS total FROM payments');

    res.render('admin/payments', {
      title: 'Payments',
      totals,
      payments: rows,
      refunds: await Payment.listNeedingRefund({ limit: 20 }),
      formatMinor,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/payments', req.query, p)
    });
  })
);

/**
 * GET /admin/ai — what the assistant has cost.
 *
 * The number that matters is month-to-date against the cap, because that cap is the only
 * thing bounding a public endpoint that spends money per request. Everything else on this
 * page is context for it.
 */
router.get(
  '/ai',
  asyncHandler(async (req, res) => {
    const [budget, daily] = await Promise.all([budgetStatus(), ApiUsage.dailyCost({ days: 30 })]);

    res.render('admin/ai', {
      title: 'Assistant usage',
      budget,
      daily,
      model: assistantConfig.MODEL,
      configured: assistantConfig.isConfigured(),
      priceInput: assistantConfig.PRICE_PER_MTOK_INPUT,
      priceOutput: assistantConfig.PRICE_PER_MTOK_OUTPUT
    });
  })
);

/**
 * POST /admin/errors/purge — drop error logs older than a chosen number of days.
 *
 * The table grows without bound otherwise, and an error log nobody can load is an error
 * log nobody reads. The window is validated against a fixed set rather than taken as a
 * number: `INTERVAL ? DAY` with a zero would delete everything, and a purge is the one
 * action on this screen that cannot be undone.
 */
router.post(
  '/errors/purge',
  isSuperadmin,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const ALLOWED_DAYS = [30, 90, 180, 365];
    const days = parseInt(req.body.days, 10);
    if (!ALLOWED_DAYS.includes(days)) {
      req.flash('error', 'Choose one of the offered retention windows.');
      return res.redirect('/admin/errors');
    }

    const removed = await ErrorLog.purgeOlderThan(days);
    req.flash('success', `Removed ${removed} entries older than ${days} days.`);
    return res.redirect('/admin/errors');
  })
);

/* ---------------------------------------------------------------- moderation */

/**
 * GET /admin/moderation — the queue, and what has already been taken down.
 *
 * Content is HIDDEN, never deleted, so this screen is as much about putting things back
 * as about removing them: every hidden item is listed with who hid it and why, and one
 * button restores it. A moderation tool that can only remove is a tool nobody dares use.
 */
router.get(
  '/moderation',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });

    const [hidden, log, recent] = await Promise.all([
      Moderation.hiddenContent({ limit: 50 }),
      Moderation.events({ limit, offset }),
      // The same builder the public list uses, with the one documented opt-in, so the
      // moderator is provably looking at the same rows a reader would.
      Post.browse({ include_hidden: true }, { limit: 20, offset: 0, sort: 'newest' })
    ]);

    res.render('admin/moderation', {
      title: 'Moderation',
      hidden,
      events: log.rows,
      recentPosts: recent.rows,
      pagination: paginationMeta({ page, perPage, total: log.total }),
      pageUrl: (p) => pageUrl('/admin/moderation', req.query, p)
    });
  })
);

/**
 * The three content actions.
 *
 * Each is a single POST that flips a flag one way or the other, so there is no "delete"
 * verb anywhere in the admin surface for user-written content. `Moderation` is the only
 * module that touches these columns — it also moves the reply counter, the accepted-answer
 * mark and the points ledger, none of which a bare UPDATE here would remember to do.
 */
function moderationAction(handler, describe) {
  return asyncHandler(async (req, res) => {
    const back = returnTo(req, '/admin/moderation');
    const hide = req.body.hidden === 'true';
    const reason = (req.body.reason || '').trim() || null;

    try {
      const result = await handler(req.params.id, hide, {
        actorUserId: req.session.user.id,
        reason
      });
      req.flash(
        'success',
        result.changed ? describe(hide) : 'Nothing to do — it was already in that state.'
      );
    } catch (err) {
      if (err.code !== 'NOT_FOUND') throw err;
      req.flash('error', err.message);
    }

    return res.redirect(back);
  });
}

router.post(
  '/moderation/posts/:id',
  requireIdParam('id'),
  writeLimiter,
  moderationAction(
    (id, hide, options) => Moderation.setPostHidden(id, hide, options),
    (hide) => (hide ? 'Post hidden. Its author keeps the text; you can restore it.' : 'Post restored.')
  )
);

router.post(
  '/moderation/replies/:id',
  requireIdParam('id'),
  writeLimiter,
  moderationAction(
    (id, hide, options) => Moderation.setReplyHidden(id, hide, options),
    (hide) => (hide ? 'Reply hidden, and the thread count corrected.' : 'Reply restored.')
  )
);

/**
 * A rate submission is VOIDED rather than hidden, and the wording matters: this is not
 * moderation of speech, it is excluding a figure from an average. Superadmin-gated
 * because the screen behind it shows contributed rates next to the people who gave them,
 * which is the one place the index's own promise of aggregation is set aside.
 */
router.post(
  '/moderation/rates/:id',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  moderationAction(
    (id, voided, options) => Moderation.setRateVoided(id, voided, options),
    (voided) => (voided ? 'Submission voided and removed from every aggregate.' : 'Submission reinstated.')
  )
);

/**
 * GET /admin/rates — contributed figures, with a hint about which look wrong.
 *
 * Superadmin-only. Everywhere else in this application a rate is only ever seen as part
 * of an aggregate over at least three people; this screen deliberately breaks that, which
 * is why the narrowest role guard in the app is on it.
 */
router.get(
  '/rates',
  isSuperadmin,
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 40 });
    const includeVoided = req.query.voided === '1';
    const { rows, total } = await RateSubmission.listForReview({ limit, offset, includeVoided });

    res.render('admin/rates', {
      title: 'Rate submissions',
      submissions: rows,
      includeVoided,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/rates', req.query, p)
    });
  })
);

/* ------------------------------------------------------------------ settings */

router.get(
  '/settings',
  isSuperadmin,
  asyncHandler(async (req, res) => {
    res.render('admin/settings', {
      title: 'Settings',
      definitions: SETTING_DEFINITIONS,
      values: await AppSetting.all()
    });
  })
);

/**
 * Superadmin-gated: these switches close registration and freeze the community, which is
 * not something an ordinary admin account should be able to do on its own.
 *
 * `AppSetting.setMany` iterates the DECLARED keys rather than the submitted body, so an
 * unchecked box (which posts nothing) is correctly read as false and an unknown field is
 * a no-op rather than a new row.
 */
router.post(
  '/settings',
  isSuperadmin,
  writeLimiter,
  asyncHandler(async (req, res) => {
    await AppSetting.setMany(req.body);
    req.flash('success', 'Settings saved. They take effect within a minute on every instance.');
    return res.redirect('/admin/settings');
  })
);

/* ----------------------------------------------------------------- analytics */

/**
 * GET /admin/analytics — growth, in one query per series.
 *
 * Read-only and deliberately plain: counts per month for the handful of things that say
 * whether the marketplace is alive. No charting library — the CSP allows no CDN, and a
 * table of numbers is what someone actually reads off a screen like this.
 */
router.get(
  '/analytics',
  asyncHandler(async (req, res) => {
    const MONTHS = 12;

    // One shape for every series, so the view has one loop rather than five.
    const series = async (label, table, column = 'created_at', extraWhere = '1 = 1') => {
      /*
       * GROUP BY the EXPRESSION, not the alias.
       *
       * `GROUP BY period` looks equivalent and is not: MySQL resolves the name against the
       * table's real columns first, and `rate_submissions.period` exists — it holds the
       * rate's own period (`2026-09`), nothing to do with this grouping. So that one series
       * silently grouped by the wrong column and then failed `only_full_group_by`, which is
       * on by default in MySQL 8. The other five worked, which is what made it a 500 on one
       * page rather than an obviously broken query.
       *
       * Found by running the app against a real database for the first time. No mocked test
       * could have caught it: it needs MySQL's name resolution and a table that happens to
       * carry a column called `period`.
       */
      const [rows] = await promisePool.query(
        `SELECT DATE_FORMAT(${column}, '%Y-%m') AS period, COUNT(*) AS count
           FROM ${table}
          WHERE ${extraWhere} AND ${column} >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL ? MONTH)
          GROUP BY DATE_FORMAT(${column}, '%Y-%m')
          ORDER BY DATE_FORMAT(${column}, '%Y-%m')`,
        [MONTHS - 1]
      );
      return { label, rows };
    };

    const [signups, jobs, applications, posts, quotes, rates] = await Promise.all([
      series('Sign-ups', 'users'),
      series('Jobs posted', 'jobs'),
      series('Applications', 'applications'),
      series('Community posts', 'posts', 'created_at', 'hidden_at IS NULL'),
      series('Quotes', 'quotes'),
      series('Rate contributions', 'rate_submissions', 'created_at', 'voided_at IS NULL')
    ]);

    // The periods present in ANY series, so a month with no sign-ups still has a row.
    const periods = [...new Set([signups, jobs, applications, posts, quotes, rates]
      .flatMap((s) => s.rows.map((r) => r.period)))].sort();

    /*
     * The server-side panels, read over the same date range as the provider screens: who
     * looked (by country), who signed up (by country) and who played the daily challenge.
     * Aggregates only, never a person. The growth table above stays twelve months whatever
     * the range: it answers a different question, "is this alive", on a fixed window.
     */
    const range = rangeFrom(req.query);
    const [visitors, signupCountries, challenges] = await Promise.all([
      SiteStats.visitorsByCountry(range),
      SiteStats.signupsByCountry(range),
      SiteStats.challengePlayers(range)
    ]);

    res.render('admin/analytics', {
      title: 'Analytics',
      range,
      presets: RANGE_PRESETS,
      rangeQuery,
      visitors,
      signups: signupCountries,
      challenges,
      periods,
      series: [signups, jobs, applications, posts, quotes, rates].map((s) => ({
        label: s.label,
        byPeriod: Object.fromEntries(s.rows.map((r) => [r.period, r.count]))
      }))
    });
  })
);

/**
 * POST /admin/analytics/reset-geo — clear the server-side visitor geography so it rebuilds
 * from real traffic (ported from SAP Hub).
 *
 * Superadmin, because it deletes a table's history and nothing undoes it, and confirmed by
 * TYPING a word rather than a click, the way erasure is: a click is what somebody does by
 * accident. It never touches sign-ups or the providers' data, only this site's own tally.
 */
router.post(
  '/analytics/reset-geo',
  isSuperadmin,
  writeLimiter,
  asyncHandler(async (req, res) => {
    if (String(req.body.confirm || '').trim().toUpperCase() !== 'RESET') {
      req.flash('error', 'Type RESET to confirm. Nothing has been cleared.');
      return res.redirect('/admin/analytics');
    }
    const removed = await SiteStats.resetVisitorGeography();
    req.flash('success', `Visitor geography cleared (${removed} day-and-country rows). It rebuilds from the next page view.`);
    return res.redirect('/admin/analytics');
  })
);

/**
 * GET /admin/analytics/ga4 and /admin/analytics/cloudflare — the two providers.
 *
 * One data shape (services/webAnalytics.js), so the two screens can be read side by side.
 * A provider that is not configured renders the steps that are missing rather than a 404:
 * the screen is where somebody goes to find out why there is no data. A failed API call
 * renders its message — "no data" and "the token is wrong" must not look the same.
 *
 * Same guard as /admin/analytics (any administrator): the figures are aggregates and name
 * nobody, and the API credentials never reach the page.
 */
const WEB_ANALYTICS_PROVIDERS = Object.freeze({
  ga4: {
    name: 'Google Analytics 4',
    tagEnabled: webAnalyticsConfig.ga4TagEnabled,
    reportingEnabled: webAnalyticsConfig.ga4ReportingEnabled,
    dashboardUrl: 'https://analytics.google.com/'
  },
  cloudflare: {
    name: 'Cloudflare Web Analytics',
    tagEnabled: webAnalyticsConfig.cloudflareTagEnabled,
    reportingEnabled: webAnalyticsConfig.cloudflareReportingEnabled,
    dashboardUrl: 'https://dash.cloudflare.com/?to=/:account/web-analytics'
  }
});

Object.entries(WEB_ANALYTICS_PROVIDERS).forEach(([key, provider]) => {
  router.get(
    `/analytics/${key}`,
    asyncHandler(async (req, res) => {
      const range = rangeFrom(req.query);
      let report = null;
      let dashboard = null;
      let realtime = null;
      let error = null;
      if (provider.reportingEnabled()) {
        try {
          if (key === 'cloudflare') {
            /*
             * The totals come from the summary report, because it is the one that asks the
             * two diagnostic questions — what the sample interval is, and which hosts have
             * data when this one has none — and the sections from the dashboard, each its
             * own request so one refused field empties one card.
             */
            const end = new Date(`${range.to}T23:59:59Z`);
            [report, dashboard] = await Promise.all([
              webAnalyticsService.cloudflareReport(range.days, { now: end }),
              analyticsDashboard.cloudflareDashboard(range)
            ]);
          } else {
            [dashboard, realtime] = await Promise.all([
              analyticsDashboard.ga4Dashboard(range),
              analyticsDashboard.ga4Realtime().catch((err) => ({ error: err.message }))
            ]);
          }
        } catch (err) {
          error = err.message;
        }
      }

      /*
       * The site's OWN count for the same days, from `visit_geo_daily`: pages browsers
       * opened, counted on the server, with no script, no sampling and no consent involved.
       * It is the yardstick — a provider far below it is losing visitors (blockers,
       * declined consent), one above it is extrapolating.
       */
      const own = await SiteStats.visitorsByCountry(range, { limit: 1 });

      return res.render(`admin/analytics-${key}`, {
        title: provider.name,
        serverViews: own.total,
        providerKey: key,
        provider: { name: provider.name, dashboardUrl: provider.dashboardUrl },
        tagEnabled: provider.tagEnabled(),
        reportingEnabled: provider.reportingEnabled(),
        range,
        presets: RANGE_PRESETS,
        rangeQuery,
        report,
        dashboard,
        realtime,
        error
      });
    })
  );
});

/* ------------------------------------------------------- applications oversight */

/** Submitted, never moved, and older than this: the headline figure on the oversight screen. */
const STALLED_AFTER_DAYS = 14;
const STALLED_OPTIONS = Object.freeze([7, 14, 30, 90]);

/**
 * GET /admin/applications — every application on the platform (ported from SAP Hub).
 *
 * SUPERADMIN, like `/admin/rates`, and for the same reason: this is the one screen that can
 * enumerate what candidates sent to employers across every company. It shows the STATE of
 * each application and never its content — the cover letter and the day rate live on
 * `/applications/:id`, behind that page's own guard.
 *
 * The question it answers is not "who applied", which a company's own board answers better.
 * It is whether the marketplace is working: a candidate spends an evening on an
 * application, and a board where those sit untouched for a month is broken in a way no
 * count of adverts shows. That is what "stalled" is.
 *
 * It goes through `Application.buildFilter`, the same builder as the employer's board, with
 * `ALL_COMPANIES` said out loud. Named query fields only, never a spread of the request.
 */
router.get(
  '/applications',
  isSuperadmin,
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 50 });

    const stalledDays = STALLED_OPTIONS.includes(Number(req.query.stalled)) ? Number(req.query.stalled) : null;
    const filters = {
      status: Application.STATUSES.includes(req.query.status) ? req.query.status : '',
      q: typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '',
      reached: req.query.reached === 'interviewing' ? 'interviewing' : '',
      hideWithdrawn: req.query.withdrawn !== '1',
      stalledDays
    };

    const all = Application.ALL_COMPANIES;
    const [{ rows, total }, counts, stalled] = await Promise.all([
      Application.browseForCompany(all, filters, { limit, offset }),
      Application.countsForCompany(all, { ...filters, stalledDays: null }),
      // The headline number, deliberately NOT affected by the filters: it is the one figure
      // somebody opens this screen for.
      Application.browseForCompany(all, { stalledDays: STALLED_AFTER_DAYS }, { limit: 1, offset: 0 })
    ]);

    return res.render('admin/applications', {
      title: 'Applications',
      applications: rows,
      total,
      counts,
      filters,
      statuses: Application.STATUSES,
      stalledOptions: STALLED_OPTIONS,
      stalledAfterDays: STALLED_AFTER_DAYS,
      stalledCount: stalled.total,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (n) => pageUrl('/admin/applications', req.query, n)
    });
  })
);

/* ----------------------------------------------------------------- referrals */

/**
 * GET /admin/referrals — who is owed what.
 *
 * Every balance on this page is a SUM over `commission_ledger`. There is no cached total
 * anywhere to disagree with it, which is the whole reason the scheme has no balance
 * columns: the first time a stored figure and its own history diverge, nobody can say
 * which one somebody is actually owed.
 */
router.get(
  '/referrals',
  isSuperadmin,
  asyncHandler(async (req, res) => {
    /*
     * The Sales agents tab (migration 031): the Hub's own people, whose links are MEASURED
     * and pay nothing. It lives on this page, as on SAP Hub, because "who brought this
     * person in" has two answers and an administrator should see both in one place — but
     * it reads its own table and never touches the commission ledger.
     */
    if (req.query.tab === 'agents') {
      const agents = await SalesAgent.listAll();
      const [direct, agentPeople, countries] = await Promise.all([
        SalesAgent.unattributed(),
        SalesAgent.peopleFor(agents.map((a) => a.user_id)),
        SalesAgent.countriesByAgent()
      ]);
      const countryLabel = (code) => (code ? countryName(code) : 'Unknown');
      const geoOf = (rows) => ({
        rows,
        chart: donutSlices(rows.map((r) => ({ label: countryLabel(r.code), key: r.code, count: r.count })))
      });
      const agentCountries = {};
      Object.entries(countries.byAgent).forEach(([id, rows]) => { agentCountries[id] = geoOf(rows); });
      return res.render('admin/referrals', {
        title: 'Sales agents',
        tab: 'agents',
        agents,
        direct,
        agentPeople,
        agentCountries,
        directCountries: geoOf(countries.direct),
        overallCountries: geoOf(countries.overall),
        countryLabel,
        geoNote: 'The country stated on the profile; where none is stated yet, the country of the address they signed up from (marked "sign-up IP").',
        linkFor: (code) => `${config.app.baseUrl}/s/${code}`
      });
    }

    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });
    const { rows, total } = await Referral.listAll({ limit, offset });

    res.render('admin/referrals', {
      title: 'Referrals and payouts',
      tab: 'referrers',
      referrers: rows,
      payoutMethods: PAYOUT_METHODS,
      minPayoutMinor: MIN_PAYOUT_MINOR,
      defaultRateBps: DEFAULT_RATE_BPS,
      formatMinor,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/referrals', req.query, p)
    });
  })
);

/**
 * POST /admin/referrals/agents/add — promote an existing account to sales agent.
 *
 * Never creates an account, and never touches the account's roles: an agent is a row in
 * `sales_agents`, not a user type, so promoting an administrator cannot demote them (the
 * reference re-typed the account and did). Registered BEFORE `/referrals/:id/...`, because
 * `requireIdParam` answers a non-numeric id with a 404 rather than passing it on.
 */
router.post(
  '/referrals/agents/add',
  isSuperadmin,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const back = '/admin/referrals?tab=agents';
    const emailAddress = typeof req.body.email === 'string' ? req.body.email.trim().slice(0, 255) : '';
    if (!emailAddress) {
      req.flash('error', 'Give the email address of the account to add.');
      return res.redirect(back);
    }
    const user = await User.findByEmail(emailAddress);
    if (!user || !user.is_active) {
      req.flash('error', 'No active account has that email address. The person must sign up first.');
      return res.redirect(back);
    }
    const { agent, created } = await SalesAgent.add(user.id, req.session.user.id);
    if (!created) {
      req.flash('info', `${user.name || user.email} is already a sales agent (link /s/${agent.code}).`);
      return res.redirect(back);
    }
    req.flash('success', `${user.name || user.email} is now a sales agent. Their link: ${config.app.baseUrl}/s/${agent.code}`);
    return res.redirect(back);
  })
);

/** Pausing a link stops new sign-ups being credited; who it already brought in stays. */
router.post(
  '/referrals/agents/:id/active',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const changed = await SalesAgent.setActive(req.params.id, req.body.is_active === 'true');
    req.flash(changed ? 'success' : 'error', changed
      ? 'Sales agent updated. The people they already brought in are still credited to them.'
      : 'That account is not a sales agent.');
    return res.redirect('/admin/referrals?tab=agents');
  })
);

/**
 * POST /admin/referrals/:id/payout — record that a transfer was made.
 *
 * It settles the WHOLE unpaid balance, not an amount typed into a box. The reference took
 * a requested figure and matched it against unpaid rows FIFO, which produced refusals like
 * "requested €3 cannot be matched exactly by unpaid commissions" — a problem created
 * entirely by that design. Settling everything unpaid has no remainder to explain.
 *
 * This records that money LEFT; it does not move any. There is no automated transfer here
 * and there should not be: Stripe collects, a person pays out, and the gap between them is
 * where somebody looks at the number before it goes.
 */
router.post(
  '/referrals/:id/payout',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      const result = await Referral.payOut(req.params.id, {
        method: req.body.method,
        reference: req.body.reference || null,
        note: req.body.note || null,
        actorUserId: req.session.user.id
      });
      req.flash(
        'success',
        `Recorded a payout of ${formatMinor(result.amountMinor, result.currency)} covering ${result.entries} entries.`
      );
    } catch (err) {
      if (!['NOTHING_TO_PAY', 'BELOW_MINIMUM', 'BAD_PAYOUT_METHOD'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect('/admin/referrals');
  })
);

/**
 * POST /admin/referrals/:id/adjust — a compensating entry.
 *
 * The only way a commission is ever reversed, and it takes a human and a reason that the
 * referrer will see. There is deliberately no automatic clawback on a refund: a webhook
 * silently debiting somebody's balance is how a referrer discovers from a dashboard that
 * they owe money.
 */
router.post(
  '/referrals/:id/adjust',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await Referral.adjust(req.params.id, {
        // Entered in euros because that is what a person reading a refund thinks in;
        // stored in cents because that is the only thing the ledger holds.
        amountMinor: Math.round(Number(req.body.amount_eur) * 100),
        note: req.body.note,
        actorUserId: req.session.user.id
      });
      req.flash('success', 'Adjustment recorded. It is visible to the referrer with its reason.');
    } catch (err) {
      if (!['BAD_ADJUSTMENT', 'REASON_REQUIRED'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect('/admin/referrals');
  })
);

router.post(
  '/referrals/:id/active',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    await Referral.setActive(req.params.id, req.body.is_active === 'true');
    // Note what this does NOT do: a retired referrer keeps every attribution and every
    // entry already earned. Deactivating stops new introductions, it does not take money
    // back.
    req.flash('success', 'Referrer updated. Existing attributions and balances are untouched.');
    return res.redirect('/admin/referrals');
  })
);

router.post(
  '/referrals/:id/rate',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const rate = await Referral.setRate(req.params.id, req.body.rate_bps);
    // Only future introductions: `referral_attributions.rate_bps` snapshots the rate in
    // force when the introduction was made, so nobody is repriced retroactively.
    req.flash('success', `Rate set to ${rate / 100}% for introductions made from now on.`);
    return res.redirect('/admin/referrals');
  })
);

/**
 * GET /admin/tax-advisory — the enquiry queue.
 *
 * Superadmin-gated, and for the same reason `/admin/rates` is: it is a screen that shows
 * individual people's private circumstances next to their names. A general admin
 * moderating a forum has no business reading somebody's question about how they are paid.
 *
 * The count next to a filter comes from `TaxEnquiry.buildFilter`, which is also what the
 * list runs — one builder, so the two cannot describe different rows.
 */
router.get(
  '/tax-advisory',
  isSuperadmin,
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 25 });
    const filters = {
      status: req.query.status || '',
      country: req.query.country || '',
      topic: req.query.topic || '',
      q: req.query.q || ''
    };

    const [{ rows, total }, duePurge] = await Promise.all([
      TaxEnquiry.list(filters, { limit, offset }),
      TaxEnquiry.dueForPurge()
    ]);

    res.render('admin/taxAdvisory', {
      title: 'Tax advisory enquiries',
      enquiries: rows,
      filters,
      statuses: ADVISORY_STATUSES,
      transitions: ADVISORY_TRANSITIONS,
      topics: ADVISORY_TOPICS,
      arrangements: ADVISORY_ARRANGEMENTS,
      retentionDays: ADVISORY_RETENTION_DAYS,
      duePurge,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/tax-advisory', req.query, p)
    });
  })
);

/**
 * POST /admin/tax-advisory/:id/status — move one enquiry along.
 *
 * The transition is checked in the model against the declared machine, so an undeclared
 * move is refused rather than written. Closing is what releases the one-open-enquiry-per-
 * address reservation, which is why it is a status change and not a delete.
 */
router.post(
  '/tax-advisory/:id/status',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      const result = await TaxEnquiry.setStatus(req.params.id, req.body.status, {
        actorUserId: req.session.user.id,
        note: req.body.note || null
      });
      req.flash('success', `Enquiry #${result.id} moved from ${result.from} to ${result.to}.`);
    } catch (err) {
      if (!['NOT_FOUND', 'BAD_STATUS', 'BAD_TRANSITION'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, '/admin/tax-advisory'));
  })
);

/**
 * POST /admin/tax-advisory/purge — delete everything past the retention period.
 *
 * Deliberately a button rather than a background job on a timer. The retention promise is
 * made on a public form, so somebody should be able to see the number of rows due and
 * watch it go to zero; a cron nobody watches is how a promise quietly stops being kept.
 * `npm run purge:enquiries` does the same thing from a scheduler when there is one.
 */
router.post(
  '/tax-advisory/purge',
  isSuperadmin,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const deleted = await TaxEnquiry.purgeExpired();
    req.flash(
      'success',
      deleted === 0
        ? `Nothing was older than ${ADVISORY_RETENTION_DAYS} days.`
        : `Deleted ${deleted} enquir${deleted === 1 ? 'y' : 'ies'} older than ${ADVISORY_RETENTION_DAYS} days, with their history.`
    );
    return res.redirect('/admin/tax-advisory');
  })
);

/**
 * GET /admin/stories — write and manage case studies.
 *
 * Admin, not superadmin: a story is marketing copy about work that was done, not a screen
 * showing somebody's private circumstances.
 */
router.get(
  '/stories',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 20 });
    const { rows, total } = await SuccessStory.list({ include_unpublished: true }, { limit, offset });

    res.render('admin/stories', {
      title: 'Success stories',
      stories: rows,
      families: CLOUD_FAMILIES,
      limits: SuccessStory.LIMITS,
      editing: req.query.edit ? await SuccessStory.findById(parseInt(req.query.edit, 10) || 0) : null,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/stories', req.query, p)
    });
  })
);

router.post(
  '/stories',
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { slug } = await SuccessStory.create(req.body, { actorUserId: req.session.user.id });
      req.flash('success', `Story created as a draft. Publish it when you are ready (${slug}).`);
    } catch (err) {
      if (!['TITLE_REQUIRED', 'BODY_REQUIRED'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect('/admin/stories');
  })
);

router.post(
  '/stories/:id',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await SuccessStory.update(req.params.id, req.body);
      req.flash('success', 'Story saved.');
    } catch (err) {
      if (!['TITLE_REQUIRED', 'BODY_REQUIRED', 'NOT_FOUND'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, '/admin/stories'));
  })
);

/**
 * Publish and hide are separate switches, and neither is a delete.
 *
 * Unpublished means "not finished"; hidden means "was live and should not be". Collapsing
 * them into one flag loses the difference between a draft and a retraction, and the
 * retraction is the one somebody will ask about later.
 */
router.post(
  '/stories/:id/state',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    if (req.body.field === 'published') {
      await SuccessStory.setPublished(req.params.id, req.body.value === 'true');
      req.flash('success', req.body.value === 'true' ? 'Story published.' : 'Story unpublished.');
    } else if (req.body.field === 'hidden') {
      await SuccessStory.setHidden(req.params.id, req.body.value === 'true');
      req.flash('success', req.body.value === 'true' ? 'Story hidden. Nothing was deleted.' : 'Story restored.');
    } else {
      req.flash('error', 'Unknown field.');
    }
    return res.redirect(returnTo(req, '/admin/stories'));
  })
);

/**
 * The story photo. Same pipeline as every other image here: multer keeps it in memory,
 * sharp re-encodes it to a bounded WebP — which is also the real sanitiser, since anything
 * that is not an image fails to decode — and the bytes go to a side table, never the disk
 * and never a column on a row that gets SELECT *'d.
 */
router.post(
  '/stories/:id/photo',
  requireIdParam('id'),
  writeLimiter,
  singleImage('photo'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      req.flash('error', 'Choose an image first.');
      return res.redirect(returnTo(req, '/admin/stories'));
    }
    await ImageBlob.put('story_photos', req.params.id, req.file.buffer, { size: 1200 });
    await SuccessStory.setPhoto(req.params.id, ImageBlob.pointerUrl('/success-stories/photo', req.params.id));
    req.flash('success', 'Photo saved.');
    return res.redirect(returnTo(req, '/admin/stories'));
  })
);

/**
 * GET /admin/reviews — the approval queue.
 *
 * Three actions and none of them is delete. The reference's bulk action calls
 * `SiteReview.delete`, a hard DELETE from a list view; after it runs nobody can say what
 * was removed or by whom.
 */
router.get(
  '/reviews',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 25 });
    const status = ['pending', 'hidden', 'approved'].includes(req.query.status) ? req.query.status : 'pending';

    const filters =
      status === 'approved'
        ? {}
        : { include_pending: true, include_hidden: true, status };

    const [{ rows, total }, summary, pending] = await Promise.all([
      SiteReview.list(filters, { limit, offset }),
      SiteReview.summary(),
      SiteReview.pendingCount()
    ]);

    res.render('admin/reviews', {
      title: 'Member reviews',
      reviews: rows,
      status,
      summary,
      pending,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/reviews', req.query, p)
    });
  })
);

router.post(
  '/reviews/:id/state',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    if (req.body.field === 'approved') {
      await SiteReview.setApproved(req.params.id, req.body.value === 'true', {
        actorUserId: req.session.user.id
      });
      req.flash('success', req.body.value === 'true' ? 'Review approved.' : 'Approval withdrawn.');
    } else if (req.body.field === 'hidden') {
      await SiteReview.setHidden(req.params.id, req.body.value === 'true');
      req.flash('success', req.body.value === 'true' ? 'Review hidden. The row is kept.' : 'Review restored.');
    } else {
      req.flash('error', 'Unknown field.');
    }
    return res.redirect(returnTo(req, '/admin/reviews'));
  })
);

/* ------------------------------------------------------------------- placements */

/**
 * Agreeing a placement fee.
 *
 * SUPERADMIN ONLY. This screen sets a figure a company will be charged, so it sits behind
 * the same gate as /admin/rates and /crm rather than the general admin one — a moderator
 * running a forum has no business agreeing somebody's invoice.
 */
router.get(
  '/placements',
  isSuperadmin,
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });
    const filters = { status: req.query.status || '', q: req.query.q || '' };
    const [{ rows, total }, companies] = await Promise.all([
      PlacementQuote.list(filters, { limit, offset }),
      CompanyProfile.browse({}, { limit: 500, offset: 0 })
    ]);

    res.render('admin/placements', {
      title: 'Placements',
      placements: rows,
      companies: companies.rows,
      kinds: PLACEMENT_KINDS,
      statuses: PLACEMENT_STATUSES,
      currencies: CURRENCIES,
      kindLabel,
      filters,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/placements', req.query, p)
    });
  })
);

router.post(
  '/placements',
  isSuperadmin,
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await PlacementQuote.agree(req.body, { actorUserId: req.session.user.id });
      req.flash('success', 'Agreed. The company can pay it from their placements page.');
    } catch (err) {
      if (!['NO_COMPANY', 'NO_CONSULTANT', 'NO_TITLE', 'BAD_KIND', 'BAD_CURRENCY', 'BAD_VALUE'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect('/admin/placements');
  })
);

router.post(
  '/placements/:id/cancel',
  isSuperadmin,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await PlacementQuote.cancel(req.params.id, req.body.reason, { actorUserId: req.session.user.id });
      req.flash('success', 'Cancelled. The row stays, with the reason on it.');
    } catch (err) {
      if (!['NOT_FOUND', 'BAD_TRANSITION', 'REASON_REQUIRED'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, '/admin/placements'));
  })
);

/* --------------------------------------------------------------- issue reports */

/**
 * What people reported. `/admin/errors` is what the server noticed; this is what a person
 * noticed, and the two barely overlap — a button that does nothing raises no exception.
 */
router.get(
  '/issues',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });
    const filters = { status: req.query.status || '', kind: req.query.kind || '', q: req.query.q || '' };
    const [{ rows, total }, counts] = await Promise.all([
      IssueReport.list(filters, { limit, offset }),
      IssueReport.counts()
    ]);

    res.render('admin/issues', {
      title: 'Reported problems',
      issues: rows,
      counts,
      filters,
      kinds: ISSUE_KINDS,
      statuses: ISSUE_STATUSES,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/issues', req.query, p)
    });
  })
);

router.post(
  '/issues/:id',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await IssueReport.setStatus(req.params.id, req.body.status, {
        response: req.body.response,
        actorUserId: req.session.user.id
      });
      req.flash('success', 'Updated.');
    } catch (err) {
      if (!['NOT_FOUND', 'BAD_TRANSITION'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, '/admin/issues'));
  })
);

/*
 * THE AUTOMATED-TESTING PANEL.
 *
 * It answers one question nothing else here answers: "is the running site, as deployed,
 * still serving what it should?" The Jest suite proves the code is right on the machine
 * that ran it; this proves the thing behind the domain is up, behind the right guards, and
 * answering the status codes CLAUDE.md's Auth section documents. Those are different
 * questions, and the second one is the one a deployment breaks.
 *
 * Three things keep it from being a liability:
 *
 * 1. The cases are CODE, in `config/adminTests.js`, never a table an admin edits through a
 *    form. A list of endpoints to request is exactly the shape of thing somebody would
 *    point at an internal address, and a change with no diff and no review is the whole
 *    objection. Same rule the settings surface already holds: catalogue values live in
 *    config under version control.
 * 2. It only ever GETs its own declared endpoints on its own base URL. Nothing here takes
 *    a URL from the request.
 * 3. The run is the only thing it writes, and it writes results — never the cases.
 *
 * `/admin` is behind `isAuthenticated, isAdmin` at the router level, so all three inherit
 * that.
 */
router.get(
  '/tests',
  asyncHandler(async (req, res) => {
    const [lastRun, totalRuns, recentRuns] = await Promise.all([
      AdminTestRun.lastRun(),
      AdminTestRun.totalRuns(),
      AdminTestRun.recent(20)
    ]);
    const lastResults = lastRun ? await AdminTestRun.resultsFor(lastRun.runBatch) : {};

    res.render('admin/tests', {
      title: 'Automated testing',
      suite: TEST_SUITE,
      totalTests: totalTestCount(),
      categoryCount: TEST_SUITE.length,
      lastRun,
      totalRuns,
      recentRuns,
      lastResults
    });
  })
);

router.post(
  '/tests/run',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const summary = await runSuite({ runBy: req.session.user.id });
    req.flash('success', `${summary.passed}/${summary.total} tests passed.`);
    // Straight to the run's own page, as SAP Hub does: the failures are what was asked for.
    return res.redirect(summary.total ? `/admin/tests/runs/${summary.runBatch}` : '/admin/tests');
  })
);

router.post(
  '/tests/run-category',
  writeLimiter,
  asyncHandler(async (req, res) => {
    // The category is matched against the declared suite, not used as a filter value: an
    // unrecognised one is refused rather than quietly running nothing and reporting 0/0.
    const category = TEST_SUITE.find((g) => g.category === req.body.category);
    if (!category) {
      req.flash('error', 'Unknown test category.');
      return res.redirect('/admin/tests');
    }
    const summary = await runSuite({ category: category.category, runBy: req.session.user.id });
    req.flash('success', `${category.category}: ${summary.passed}/${summary.total} tests passed.`);
    return res.redirect(summary.total ? `/admin/tests/runs/${summary.runBatch}` : '/admin/tests');
  })
);

/**
 * GET /admin/tests/runs/:batch — one past run, every result in the order it ran.
 *
 * The parameter is the batch's UUID (`crypto.randomUUID()` in utils/adminTestRunner.js),
 * not a numeric id, so it is checked against that exact shape rather than `requireIdParam`
 * — and anything else is a 404 before it reaches SQL, for the same reason.
 *
 * There is deliberately no `/tests/switch` here, although SAP Hub has one. This suite has
 * no disabled tests: the cases are an array in config/adminTests.js and every entry runs, so
 * turning one off is a change with an author, a diff and a review — not a button that makes
 * a failing check stop failing.
 */
const RUN_BATCH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

router.get(
  '/tests/runs/:batch',
  asyncHandler(async (req, res) => {
    const run = RUN_BATCH_RE.test(req.params.batch) ? await AdminTestRun.batch(req.params.batch) : null;
    if (!run) return res.status(404).render('errors/404', { title: 'Not found' });
    return res.render('admin/test-run', { title: 'Test run', run });
  })
);

module.exports = router;
