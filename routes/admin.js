'use strict';

const express = require('express');

const User = require('../models/User');
const Job = require('../models/Job');
const ErrorLog = require('../models/ErrorLog');
const RateSubmission = require('../models/RateSubmission');
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

module.exports = router;
