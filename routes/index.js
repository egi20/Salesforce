'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { writeLimiter } = require('../middleware/rateLimit');
const { isAuthenticated } = require('../middleware/auth');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { PUBLIC_PATHS, canonicalUrl } = require('../config/seoMeta');
const legal = require('../config/legal');
const IssueReport = require('../models/IssueReport');
const { ISSUE_KINDS, ISSUE_SEVERITIES, SCREENSHOTS, LIMITS: ISSUE_LIMITS } = require('../config/issues');
const { screenshots } = require('../middleware/fileUpload');
const Job = require('../models/Job');
const config = require('../config/config');
const Post = require('../models/Post');
const Points = require('../models/Points');
const ConsultantProfile = require('../models/ConsultantProfile');
const ConsultantHiddenCompany = require('../models/ConsultantHiddenCompany');
const CompanyProfile = require('../models/CompanyProfile');
const RateSubmission = require('../models/RateSubmission');
const { POST_KINDS, isPostKind, postKind } = require('../config/community');
const { toPlainText } = require('../utils/sanitize');
const legalVersions = require('../config/legal-versions');
const SalesAgent = require('../models/SalesAgent');
const { requireIdParam } = require('../utils/ids');
const { looksLikeAPerson } = require('../middleware/visitGeo');

const router = express.Router();

/**
 * The front door is the community feed, for everybody.
 *
 * It used to be two pages: a marketing landing signed out, the feed signed in. The sister
 * site opens on its feed for a visitor too, and so does this one now — a page of real
 * questions and answers says more about a community than a hero banner about it, and it
 * is the page worth coming back to daily.
 *
 * What differs by viewer is the SIDEBAR, not the list. Signed in: your standing, the
 * leaderboard. Signed out: what this is and what an account adds. The leaderboard stays
 * behind sign-in because it names people next to links to their profiles, and putting
 * that list on the one page every crawler indexes is a bigger audience than any of them
 * signed up to be shown to.
 *
 * Deliberately one query set and no personalisation beyond the filters: a feed that tries
 * to guess what someone wants, on a community this size, mostly hides things.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const viewer = req.session.user || null;
    /*
     * "Jobs" is a tab of the feed, not a post kind. It is answered by `Job.browse`, the
     * same builder `/jobs` uses, rather than by merging jobs into the post query: a UNION
     * across two tables is a third filter builder, and the count beside the pill has to be
     * the count that page shows. So "All" means every POST, and the Jobs tab is its own list.
     */
    const showJobs = req.query.kind === 'jobs';
    const filters = {
      kind: isPostKind(req.query.kind) ? req.query.kind : '',
      category_slug: req.query.category ? String(req.query.category).slice(0, 64) : '',
      unanswered: req.query.unanswered === '1' ? '1' : ''
    };

    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 15 });
    const none = Promise.resolve(null);

    const [postPage, counts, jobPage, newMembers, standing, leaderboard] = await Promise.all([
      showJobs ? Promise.resolve({ rows: [], total: 0 }) : Post.browse(filters, { limit, offset, sort: 'recent' }),
      Post.countsByKind(filters),
      showJobs ? Job.browse({}, { limit, offset, sort: 'newest' }) : Job.browse({}, { limit: 4, sort: 'newest' }),
      countRecentMembers(),
      viewer ? Points.standingFor(viewer.id) : none,
      viewer ? Points.leaderboard({ days: 30, limit: 6 }) : Promise.resolve([])
    ]);

    res.render('feed/index', {
      title: viewer ? 'Home' : res.locals.seo.title,
      posts: postPage.rows,
      jobs: showJobs ? jobPage.rows : [],
      showJobs,
      jobsTotal: jobPage.total,
      counts,
      filters,
      standing,
      leaderboard,
      newMembers,
      latestJobs: showJobs ? [] : jobPage.rows,
      kinds: POST_KINDS,
      postKind,
      toPlainText,
      greeting: greetingFor(new Date()),
      pagination: paginationMeta({ page, perPage, total: showJobs ? jobPage.total : postPage.total }),
      pageUrl: (p) => pageUrl('/', req.query, p)
    });
  })
);

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
/*
 * Explainer pages for the engagement models named in the Companies Hub menu.
 *
 * Static content, one view, one data object — the same shape as PAGE_META, so a new entry
 * is one object rather than a new route and view each time. Each one ends at a real page
 * that already exists; none of them describes something the Hub cannot do.
 */
const SERVICE_PAGES = {
  'staff-augmentation': {
    heading: 'Staff augmentation',
    icon: 'bi-people',
    intro: 'Add certified Salesforce specialists to your existing team, working under your own delivery lead and your own backlog.',
    points: [
      'You keep the roadmap and the day-to-day work — the consultant reports into your team, not the other way round.',
      'Engaged on a day rate, for as long as the work runs.',
      'A good fit when you already have a delivery process and just need certified hands.'
    ],
    cta: { label: 'Browse consultants', href: '/consultants' }
  },
  'project-based': {
    heading: 'Project-based delivery',
    icon: 'bi-kanban',
    intro: 'Scope a piece of work end to end — phases, team shape, timeline and budget — before anyone starts.',
    points: [
      'A phased plan with a fixed set of deliverables and a reconciled budget, not an open-ended day-rate clock.',
      'Built from the same estimator that prices every quote on the Hub, so the figures reconcile line by line.',
      'A good fit for a defined piece of work with a clear start and end.'
    ],
    cta: { label: 'Get a scope estimate', href: '/quotes/new' }
  },
  'managed-services': {
    heading: 'Managed services',
    icon: 'bi-gear',
    intro: 'Ongoing support and enhancement of a live Salesforce org, without hiring a permanent admin.',
    points: [
      'A consultant or small team owns the org’s day-to-day health: fixes, small enhancements, release management.',
      'Priced and agreed the same way as any other engagement on the Hub — nothing is billed that was not scoped first.',
      'A good fit once a build is live and needs someone to keep it running.'
    ],
    cta: { label: 'Browse consultants', href: '/consultants' }
  },
  'document-generator': {
    heading: 'Document generator',
    icon: 'bi-file-earmark-text',
    intro: 'Every quote on the Hub can be turned into a matching SOW, work breakdown and summary deck — and every consultant profile into a CV and rate card.',
    points: [
      'A scope estimate becomes a downloadable SOW (.docx), work breakdown with Gantt (.xlsx) and summary deck (.pptx), zipped together — all three read the same stored figures, so they cannot contradict each other.',
      'A consultant profile becomes a formatted CV and rate card on demand, rendered from the profile rather than written by anything else.',
      'Nothing is generated until you ask for it, and nothing is stored afterwards — the source is always the quote or the profile, not the file.'
    ],
    cta: { label: 'Start a quote', href: '/quotes/new' }
  }
};


/*
 * `hasOwnProperty`, never a truthiness check on the lookup.
 *
 * `SERVICE_PAGES['constructor']` is `Object` — truthy — so a plain `if (!model)` guard
 * hands `Object` to the view and the render dies on `model.points.forEach`. The same trap
 * `AppSetting.isValidKey` and `ImageBlob`'s table lookup already avoid, arriving here
 * through a URL segment anybody can type.
 */
router.get('/services/:page', (req, res, next) => {
  if (!Object.prototype.hasOwnProperty.call(SERVICE_PAGES, req.params.page)) return next();
  const model = SERVICE_PAGES[req.params.page];
  res.render('services/engagement-model', { title: model.heading, model });
});

/*
 * The two hub landing pages: what each half of the site offers, in one place.
 *
 * Every card links to a page that already exists — a landing page is a table of contents,
 * and a contents entry for a chapter that was never written is a 404 with a nicer label.
 * Cards behind a sign-in are shown only to the account that can open them, the same rule
 * the menu follows.
 *
 * The figures are counted by the SAME builders the list pages use, so "312 open roles"
 * here is the number /jobs shows. The consultant count passes a viewer for the same reason
 * /consultants does: a company that a consultant has hidden from must not be counted to
 * that company, or the total quietly reveals that somebody is missing.
 */
router.get(
  '/consultant-hub',
  asyncHandler(async (req, res) => {
    const user = req.session.user || null;
    const isConsultant = Boolean(user && user.isConsultant);
    const [jobs, contributors] = await Promise.all([
      Job.browse({}, { limit: 1 }),
      RateSubmission.totalContributors()
    ]);

    const tools = [
      { href: '/jobs', icon: 'bi-briefcase', tone: 'icon-blue', title: 'Find Jobs', text: 'Contract and permanent roles, filtered by cloud, role, seniority, work mode and rate.' },
      { href: isConsultant ? '/profile/consultant' : '/auth/register', icon: 'bi-person-gear', tone: 'icon-navyblue', title: 'Build Profile', text: 'Your clouds, certifications, delivery history and availability, in a profile companies can find. You decide whether it is public, and whether the rate is shown.' },
      { href: '/services/document-generator', icon: 'bi-file-earmark-person', tone: 'icon-info', title: 'CV Generator', text: 'A formatted CV and rate card rendered from your profile. Nothing is written for you and nothing is stored.' },
      { href: '/rates', icon: 'bi-graph-up', tone: 'icon-success', title: 'Rate & Salary Index', text: 'Day rates contributed by consultants. No figure is published from fewer than three people.' },
      { href: '/rates/calculator', icon: 'bi-calculator', tone: 'icon-blue', title: 'Rate calculator', text: 'What a day rate comes to over a year once holidays, illness and the bench are taken out.' },
      { href: '/tax-advisory', icon: 'bi-signpost-split', tone: 'icon-navyblue', title: 'Tax Optimization', text: 'An introduction to a specialist for your situation. The Hub itself calculates nothing.' }
    ];
    if (isConsultant) {
      tools.push(
        { href: '/dashboard/applications', icon: 'bi-send', tone: 'icon-info', title: 'Your applications', text: 'Every role you applied to and where each one stands.' },
        { href: '/rates/submit', icon: 'bi-plus-circle', tone: 'icon-success', title: 'Contribute your rate', text: 'Add your figure to the index. It is never shown on its own.' }
      );
    }

    res.render('hubs/show', {
      title: 'Consultant Hub',
      model: {
        icon: 'bi-person-badge',
        label: 'CONSULTANT HUB',
        heading: 'Everything for Salesforce consultants',
        intro: 'Find your next role, show companies what you have delivered, and know what the work is worth — from figures other consultants contributed, not a guess.',
        stats: [
          { value: jobs.total, label: jobs.total === 1 ? 'open role' : 'open roles', href: '/jobs' },
          { value: contributors, label: contributors === 1 ? 'rate contributor' : 'rate contributors', href: '/rates' }
        ],
        tools,
        cta: user ? null : { label: 'Create your profile', href: '/auth/register' }
      }
    });
  })
);

router.get(
  '/companies-hub',
  asyncHandler(async (req, res) => {
    const user = req.session.user || null;
    const viewer = await ConsultantHiddenCompany.viewerFor(user);
    const [consultants, companies] = await Promise.all([
      ConsultantProfile.browse({ viewer }, { limit: 1 }),
      CompanyProfile.browse({}, { limit: 1 })
    ]);

    const tools = [
      { href: '/consultants', icon: 'bi-people', tone: 'icon-blue', title: 'Browse Talent', text: 'Consultants filtered by cloud, certification, seniority, availability and rate.' },
      { href: '/quotes/new', icon: 'bi-calculator', tone: 'icon-navyblue', title: 'Get SOW Quote', text: 'Pick clouds and modules and get a phased plan, team shape, budget and timeline that add up line by line.' },
      { href: user && user.isCompany ? '/jobs/new' : '/auth/register', icon: 'bi-plus-square', tone: 'icon-success', title: 'Post a role', text: 'Publish a contract or permanent role and manage applicants through a pipeline.' },
      { href: '/services/staff-augmentation', icon: 'bi-person-plus', tone: 'icon-info', title: 'Staff Augmentation', text: 'Named consultants inside your team, on your backlog.' },
      { href: '/services/project-based', icon: 'bi-kanban', tone: 'icon-blue', title: 'Project-Based', text: 'A defined scope delivered to a plan, priced from an estimate.' },
      { href: '/services/managed-services', icon: 'bi-gear', tone: 'icon-navyblue', title: 'Managed Services', text: 'Ongoing support and improvement after go-live.' },
      { href: '/recruiters', icon: 'bi-person-rolodex', tone: 'icon-success', title: 'Recruitment agencies', text: 'Agencies that specialise in Salesforce placements, by cloud.' }
    ];
    if (user && user.isCompany) {
      tools.push({ href: '/dashboard/applicants', icon: 'bi-kanban', tone: 'icon-info', title: 'Applicants', text: 'Every application across your roles, by stage.' });
    }

    res.render('hubs/show', {
      title: 'Companies Hub',
      model: {
        icon: 'bi-building',
        label: 'COMPANIES HUB',
        heading: 'Hire Salesforce talent, or scope the work first',
        intro: 'Browse consultants directly, post a role, or turn a list of clouds and modules into an estimate and the documents that go with it.',
        stats: [
          { value: consultants.total, label: consultants.total === 1 ? 'public consultant profile' : 'public consultant profiles', href: '/consultants' },
          { value: companies.total, label: companies.total === 1 ? 'company profile' : 'company profiles', href: '/companies' }
        ],
        tools,
        cta: user ? null : { label: 'Create a company account', href: '/auth/register' }
      }
    });
  })
);

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
    severities: ISSUE_SEVERITIES,
    screenshots: SCREENSHOTS,
    limits: ISSUE_LIMITS,
    // Pre-filled from where they came from, and shown so they can see and change it. Never
    // taken from the Referer header — this app sends `Referrer-Policy: no-referrer`, so it
    // would be empty on a real browser anyway.
    pagePath: IssueReport.pagePath(req.query.from) || ''
  });
});

/*
 * The body is multipart, because of the screenshots, so the CSRF check runs once multer has
 * parsed it (middleware/csrf.js and middleware/fileUpload.js).
 */
router.post(
  '/report-issue',
  writeLimiter,
  screenshots('screenshots'),
  asyncHandler(async (req, res) => {
    if (req.uploadError) {
      req.flash('error', `${req.uploadError} Nothing was sent.`);
      return res.redirect('/report-issue');
    }
    try {
      const created = await IssueReport.create(req.body, { userId: req.session.user ? req.session.user.id : null });
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length) {
        try {
          await IssueReport.addAttachments(created.id, files.map((f) => f.buffer));
        } catch (err) {
          /*
           * sharp could not decode it, so it was not an image whatever its name said. The
           * report itself is already in the queue; say so rather than pretend nothing
           * arrived, and do not ask for it again.
           */
          console.error(`Issue ${created.id}: an attachment was not a readable image (${err.message})`);
          req.flash('info', 'Your report reached us, but one of the files was not a readable image and was left out.');
        }
      }
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

/**
 * /ideas — the suggestions people agreed to make public, once an administrator has
 * published them (ported from SAP Hub). A vote each for signed-in members. No names: both
 * switches are held by `IssueReport.publicIdeaFilter`, which every read here goes through.
 */
router.get(
  '/ideas',
  asyncHandler(async (req, res) => {
    const ideas = await IssueReport.publishedIdeas({ viewerUserId: req.session.user ? req.session.user.id : null });
    res.render('ideas', { title: 'Ideas', ideas });
  })
);

router.post(
  '/ideas/:id/vote',
  isAuthenticated,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const result = await IssueReport.toggleIdeaVote(req.params.id, req.session.user.id);
    if (!result.ok) return res.status(404).render('errors/404', { title: 'Not found' });
    return res.redirect(`/ideas#idea-${req.params.id}`);
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
/**
 * GET /s/:code — a sales agent's personal sign-up link (ported from SAP Hub).
 *
 * It lands on registration with the code in the URL (`?a=`) as well as in the session: an
 * in-app browser (LinkedIn, WhatsApp) hands the real browser the URL and never its
 * cookies, so the URL is the copy that survives "Open in browser". No cookie of its own —
 * this site sets one cookie and says so in the privacy policy; a second would change what
 * that sentence means. Same reasoning as `/referrals/go/:code`.
 *
 * Counting is STRICTER than attribution and the two are separate on purpose. Every open
 * stores the code, so a person we decline to count is still credited if they sign up; an
 * open is COUNTED only once per session and only for something that looks like a person.
 * Link previews matter most here: pasting a link into a chat makes the chat's servers open
 * it to draw the card, and they are what made every agent read "3 opens, 0 sign-ups" on
 * the reference before it filtered them.
 *
 * 302, never 301: a cached permanent redirect would stop the opens being counted. An
 * unknown or paused code still reaches sign-up — a stranger holding a stale link should
 * not meet an error page for it.
 *
 * `/s/` collides with nothing else here: no other route or static directory uses it.
 */
// The FETCHERS that draw a link's preview card, by their own names — never the app a person
// is using. SAP Hub's first version said `linkedin` and `twitter`, which also matched the
// LinkedIn and X IN-APP BROWSERS ("[LinkedInApp]", "Twitter for iPhone"): a real person
// tapping an agent's link inside LinkedIn, where agents share it, was credited at sign-up
// and never counted as an open. LinkedIn's fetcher is LinkedInBot, X's is Twitterbot.
const LINK_PREVIEW = /whatsapp\/|facebookexternalhit|facebookcatalog|slackbot|slack-imgproxy|telegrambot|discordbot|linkedinbot|twitterbot|skypeuripreview|viber|embedly|vkshare|redditbot|pinterestbot/i;

router.get(
  '/s/:code',
  asyncHandler(async (req, res) => {
    const agent = await SalesAgent.findActiveByCode(req.params.code);
    if (!agent) return res.redirect(302, '/auth/register');
    // First touch: a second agent's link later in the same session does not replace it.
    if (!req.session.salesAgentCode) req.session.salesAgentCode = agent.code;
    const ua = req.get('user-agent') || '';
    const counted = Array.isArray(req.session.salesAgentOpens) ? req.session.salesAgentOpens : [];
    if (looksLikeAPerson(ua) && !LINK_PREVIEW.test(ua) && !counted.includes(agent.code)) {
      // Capped, because a session is not somewhere to accumulate an unbounded list.
      req.session.salesAgentOpens = [...counted, agent.code].slice(-10);
      await SalesAgent.countOpen(agent.user_id);
    }
    return res.redirect(302, `/auth/register?a=${encodeURIComponent(agent.code)}`);
  })
);

router.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

module.exports = router;
module.exports.LINK_PREVIEW = LINK_PREVIEW;
