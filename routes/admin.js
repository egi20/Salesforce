'use strict';

const express = require('express');

const User = require('../models/User');
const Job = require('../models/Job');
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
const { TOPICS: ADVISORY_TOPICS, ARRANGEMENTS: ADVISORY_ARRANGEMENTS, STATUSES: ADVISORY_STATUSES, TRANSITIONS: ADVISORY_TRANSITIONS, RETENTION_DAYS: ADVISORY_RETENTION_DAYS } = require('../config/taxAdvisory');
const { PAYOUT_METHODS, MIN_PAYOUT_MINOR, DEFAULT_RATE_BPS } = require('../config/referrals');
const { promisePool } = require('../config/database');
const { isAuthenticated, isAdmin, isSuperadmin } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');

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
      const [rows] = await promisePool.query(
        `SELECT DATE_FORMAT(${column}, '%Y-%m') AS period, COUNT(*) AS count
           FROM ${table}
          WHERE ${extraWhere} AND ${column} >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL ? MONTH)
          GROUP BY period ORDER BY period`,
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

    res.render('admin/analytics', {
      title: 'Analytics',
      periods,
      series: [signups, jobs, applications, posts, quotes, rates].map((s) => ({
        label: s.label,
        byPeriod: Object.fromEntries(s.rows.map((r) => [r.period, r.count]))
      }))
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
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });
    const { rows, total } = await Referral.listAll({ limit, offset });

    res.render('admin/referrals', {
      title: 'Referrals and payouts',
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

module.exports = router;
