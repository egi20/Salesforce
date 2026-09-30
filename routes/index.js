'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { writeLimiter } = require('../middleware/rateLimit');
const { isAuthenticated } = require('../middleware/auth');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { PUBLIC_PATHS, canonicalUrl } = require('../config/seoMeta');
const legal = require('../config/legal');
const IssueReport = require('../models/IssueReport');
const { ISSUE_KINDS, LIMITS: ISSUE_LIMITS } = require('../config/issues');
const { ROLE_CATEGORIES } = require('../config/roleTaxonomy');
const { CLOUD_FAMILIES } = require('../config/cloudFamilies');
const Job = require('../models/Job');
const RateSubmission = require('../models/RateSubmission');
const ConsultantProfile = require('../models/ConsultantProfile');
const config = require('../config/config');
const Post = require('../models/Post');
const Points = require('../models/Points');
const Notification = require('../models/Notification');
const { POST_KINDS, isPostKind, postKind } = require('../config/community');
const { toPlainText } = require('../utils/sanitize');
const legalVersions = require('../config/legal-versions');

const router = express.Router();

/**
 * The front door is two different pages.
 *
 * Signed out it is the marketing landing: what this is, and why to join. Signed in that
 * pitch is noise — the person has already joined — so it becomes the community feed, which
 * is the thing worth coming back to daily.
 */
router.get(
  '/',
  asyncHandler(async (req, res, next) => {
    if (req.session.user) return feedHandler(req, res, next);

    const [latestJobs, featuredConsultants, contributors] = await Promise.all([
      Job.browse({}, { limit: 6, sort: 'newest' }),
      // No viewer: this branch runs only when nobody is signed in, so there is no company
      // identity to filter against. A hidden-company block cannot apply to an anonymous
      // visitor and the consultant is told exactly that on the page that sets one.
      ConsultantProfile.browse({}, { limit: 6 }),
      RateSubmission.totalContributors()
    ]);

    res.render('index', {
      title: res.locals.seo.title,
      latestJobs: latestJobs.rows,
      totalJobs: latestJobs.total,
      featuredConsultants: featuredConsultants.rows,
      totalConsultants: featuredConsultants.total,
      // Stated as the plain number of people who have contributed, because an
      // unverifiable scale claim is worse than a small honest one.
      rateContributors: contributors,
      roleCategories: ROLE_CATEGORIES,
      cloudFamilies: CLOUD_FAMILIES
    });
  })
);

/**
 * The signed-in feed.
 *
 * Deliberately one query set and no personalisation beyond the filters: a feed that tries
 * to guess what someone wants, on a community this size, mostly hides things.
 */
const feedHandler = asyncHandler(async (req, res) => {
  const filters = {
    kind: isPostKind(req.query.kind) ? req.query.kind : '',
    category_slug: req.query.category ? String(req.query.category).slice(0, 64) : '',
    unanswered: req.query.unanswered === '1' ? '1' : ''
  };

  const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 15 });

  const [{ rows: posts, total }, counts, standing, leaderboard, newMembers, unread, latestJobs] = await Promise.all([
    Post.browse(filters, { limit, offset, sort: 'recent' }),
    Post.countsByKind(filters),
    Points.standingFor(req.session.user.id),
    Points.leaderboard({ days: 30, limit: 6 }),
    countRecentMembers(),
    Notification.unreadCount(req.session.user.id),
    Job.browse({}, { limit: 4, sort: 'newest' })
  ]);

  res.render('feed/index', {
    title: 'Home',
    posts,
    counts,
    filters,
    standing,
    leaderboard,
    newMembers,
    unread,
    latestJobs: latestJobs.rows,
    kinds: POST_KINDS,
    postKind,
    toPlainText,
    greeting: greetingFor(new Date()),
    pagination: paginationMeta({ page, perPage, total }),
    pageUrl: (p) => pageUrl('/', req.query, p)
  });
});

/** People who joined in the last seven days — the "new this week" line. */
async function countRecentMembers() {
  const { promisePool } = require('../config/database');
  const [[row]] = await promisePool.query(
    'SELECT COUNT(*) AS count FROM users WHERE is_active = 1 AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)'
  );
  return row.count;
}

/**
 * Time-of-day greeting, from the SERVER's clock.
 *
 * Worth knowing rather than discovering: a user in another timezone will be greeted with
 * the server's idea of evening. Storing a per-user timezone would fix it; until then this
 * is a deliberate, small inaccuracy rather than a bug.
 */
function greetingFor(now) {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * /about.
 *
 * `/faq` was standing in for this and is a different page: a FAQ answers the questions
 * somebody already has, an About page answers who this is and what it will not do. The
 * second half is the part worth having — every refusal listed there is a rule enforced in
 * the code, so if one stops being true the page is wrong and has to change with it.
 */
router.get('/about', (req, res) => {
  res.render('about', { title: 'About', legal });
});

router.get('/faq', (req, res) => {
  res.render('faq', { title: 'Frequently asked questions' });
});

router.get('/legal/privacy', (req, res) => {
  res.render('legal/privacy', {
    title: 'Privacy policy',
    version: legalVersions.PRIVACY_VERSION,
    legal,
    // Only the processors THIS deployment actually uses — a policy that names Stripe on a
    // site with no Stripe key is inaccurate in the direction that matters.
    processors: legal.activeProcessors(),
    supportEmail: config.app.supportEmail,
    supportConfigured: config.app.supportEmail !== 'support@example.com'
  });
});

router.get('/legal/terms', (req, res) => {
  res.render('legal/terms', { title: 'Terms of service', version: legalVersions.TERMS_VERSION });
});

/**
 * robots.txt and the sitemap are generated from the SAME allowlist, so the sitemap can
 * never advertise a URL that robots.txt disallows.
 */
router.get('/robots.txt', (req, res) => {
  const lines = ['User-agent: *', 'Disallow: /admin', 'Disallow: /dashboard', 'Disallow: /profile', 'Disallow: /auth', ''];
  lines.push(`Sitemap: ${config.app.baseUrl}/sitemap.xml`);
  res.type('text/plain').send(lines.join('\n'));
});

/**
 * Reporting that something is wrong.
 *
 * OPEN TO ANONYMOUS VISITORS on purpose. The most valuable report a marketplace can get comes
 * from somebody who could not finish signing up, and requiring an account to say
 * "registration is broken" loses exactly the report you most need. `/admin/errors` already
 * records what the server noticed; this records what a person noticed, which is a different
 * and mostly disjoint set.
 */
router.get('/report-issue', (req, res) => {
  res.render('reportIssue', {
    title: 'Report a problem',
    kinds: ISSUE_KINDS,
    limits: ISSUE_LIMITS,
    // Pre-filled from where they came from, and shown so they can see and change it. Never
    // taken from the Referer header — this app sends `Referrer-Policy: no-referrer`, so it
    // would be empty on a real browser anyway.
    pagePath: IssueReport.pagePath(req.query.from) || ''
  });
});

router.post(
  '/report-issue',
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await IssueReport.create(req.body, { userId: req.session.user ? req.session.user.id : null });
      req.flash(
        'success',
        req.session.user
          ? 'Thank you. You can follow it on your reports page.'
          : 'Thank you. If you left an address we will use it to reply.'
      );
    } catch (err) {
      if (!['SUMMARY_REQUIRED', 'DETAIL_REQUIRED', 'BAD_EMAIL'].includes(err.code)) throw err;
      req.flash('error', err.message);
      return res.redirect('/report-issue');
    }
    return res.redirect(req.session.user ? '/my-issues' : '/report-issue');
  })
);

/** What somebody reported, and what was said back. A queue that never answers teaches people not to write to it. */
router.get(
  '/my-issues',
  isAuthenticated,
  asyncHandler(async (req, res) => {
    res.render('myIssues', {
      title: 'Your reports',
      issues: await IssueReport.listForUser(req.session.user.id)
    });
  })
);

/**
 * Contact.
 *
 * This path was already in `PUBLIC_PATHS`, so robots.txt allowed it and the sitemap handed
 * it to search engines — and it 404'd, because no route or view had ever been written. That
 * mattered more than a dead link: the privacy policy said "ask us and your account and its
 * data are removed", and this was the page that would have said how to ask.
 *
 * No form and no table. A contact form on a public page is a spam sink that needs storage,
 * moderation and a retention rule of its own; an address somebody reads needs none of that.
 */
router.get('/contact', (req, res) => {
  res.render('contact', {
    title: 'Contact',
    legal,
    supportEmail: config.app.supportEmail,
    // The shipped default is a placeholder. Printing it as though it were real would invite
    // people to write to an address nobody has ever opened.
    supportConfigured: config.app.supportEmail !== 'support@example.com'
  });
});

router.get(
  '/sitemap.xml',
  asyncHandler(async (req, res) => {
    const { rows: jobs } = await Job.browse({}, { limit: 5000, sort: 'newest' });

    const urls = [
      ...PUBLIC_PATHS.map((p) => ({ loc: canonicalUrl(p), changefreq: 'daily' })),
      ...jobs.map((j) => ({
        loc: canonicalUrl(`/jobs/${j.slug}`),
        lastmod: j.published_at ? new Date(j.published_at).toISOString() : undefined,
        changefreq: 'weekly'
      }))
    ];

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...urls.map((u) =>
        [
          '  <url>',
          `    <loc>${u.loc}</loc>`,
          u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>` : null,
          u.changefreq ? `    <changefreq>${u.changefreq}</changefreq>` : null,
          '  </url>'
        ]
          .filter(Boolean)
          .join('\n')
      ),
      '</urlset>'
    ].join('\n');

    res.type('application/xml').send(xml);
  })
);

/** Liveness only: deliberately does not touch the database, so a slow query cannot
 *  make the platform restart a process that is serving fine. */
router.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

module.exports = router;
