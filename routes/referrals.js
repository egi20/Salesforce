'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const config = require('../config/config');
const Referral = require('../models/Referral');
const SalesAgent = require('../models/SalesAgent');
const AgentLead = require('../models/AgentLead');
const { requireIdParam } = require('../utils/ids');
const { isAuthenticated } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { shouldCount } = require('../utils/salesAgentOpens');
const { asyncHandler } = require('../middleware/errorHandler');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { formatMinor } = require('../config/payments');
const { returnTo } = require('../utils/returnTo');
const {
  DEFAULT_RATE_BPS,
  MIN_PAYOUT_MINOR,
  MAX_COMMISSION_MINOR,
  ATTRIBUTION_WINDOW_DAYS,
  COMMISSIONABLE_PRODUCTS,
  PAYOUT_METHODS,
  PAYOUT_METHOD_LABELS,
  COMMISSION_LABELS,
  NOT_COMMISSIONABLE_LABELS
} = require('../config/referrals');
const {
  LEAD_STAGES,
  LEAD_SOURCES,
  AGENT_EARNINGS,
  AGENT_NOT_EARNING,
  isStage,
  stageFor,
  sourceLabel
} = require('../config/salesAgents');

const router = express.Router();

/**
 * GET /referrals/go/:code — the link a referrer shares.
 *
 * Records the code in the SESSION and redirects to the front door. Deliberately not a
 * long-lived tracking cookie: this application already has a session cookie the visitor
 * has been told about, and adding a second one that follows people for thirty days is a
 * consent question nobody asked. The trade is honest and worth stating — an attribution
 * that survives a browser restart is lost, and the `?ref=` on the registration link is
 * what covers the common case.
 *
 * Writing to the session is what CREATES it for an anonymous visitor: with
 * `saveUninitialized: false` nothing is stored until something is put in it.
 *
 * Public, unauthenticated, and it validates the code before storing anything — an
 * arbitrary string in the session would only surface later as a failed attribution.
 */
router.get(
  '/go/:code',
  asyncHandler(async (req, res) => {
    const referrer = await Referral.findByCode(req.params.code);

    if (referrer && referrer.is_active) {
      req.session.referralCode = referrer.code;
      // Counted by the agent link's rule (`shouldCount` in utils/salesAgentOpens.js): people,
      // not robots or preview fetchers, once per session, and nobody signed in — the commonest
      // signed-in visitor is the member testing their own link. Same rule, so the two "opens"
      // figures mean the same thing.
      const counted = Array.isArray(req.session.referralOpens) ? req.session.referralOpens : [];
      if (shouldCount({ signedIn: Boolean(req.session.user), userAgent: req.get('user-agent') || '', alreadyCounted: counted, code: referrer.code })) {
        req.session.referralOpens = [...counted, referrer.code].slice(-10);
        await Referral.countOpen(referrer.id);
      }
      return res.redirect(`/auth/register?ref=${encodeURIComponent(referrer.code)}`);
    }

    // An unknown or retired code is not an error worth showing a stranger: send them to
    // the front door and let them decide for themselves.
    return res.redirect('/');
  })
);

router.use(isAuthenticated);

/**
 * GET /referrals — the referrer's own view.
 *
 * Enrolment is on request rather than automatic: an account that has not asked to be in a
 * commission scheme should not silently be in one.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const referrer = await Referral.findByUserId(req.session.user.id);

    if (!referrer) {
      return res.render('referrals/join', {
        title: 'Refer someone',
        rateBps: DEFAULT_RATE_BPS,
        minPayout: formatMinor(MIN_PAYOUT_MINOR),
        maxCommission: formatMinor(MAX_COMMISSION_MINOR),
        windowDays: ATTRIBUTION_WINDOW_DAYS,
        commissionableProducts: COMMISSIONABLE_PRODUCTS
      });
    }

    // Two tabs over one card. Server-side, so they work without scripting and each keeps its
    // own pagination: Introductions (who joined, as a role and a date) and Earnings (the ledger).
    const tab = req.query.tab === 'earnings' ? 'earnings' : 'introductions';
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 25 });
    const [balance, linkStats, earnings, payouts, tabRows] = await Promise.all([
      Referral.balanceFor(referrer.id),
      Referral.linkStatsFor(referrer.id),
      Referral.earningsByProduct(referrer.id),
      Referral.payoutsFor(referrer.id),
      tab === 'earnings'
        ? Referral.ledgerFor(referrer.id, { limit, offset })
        : Referral.introductionsFor(referrer.id, { limit, offset }).then((rows) => ({ rows, total: null }))
    ]);
    const total = tab === 'earnings' ? tabRows.total : linkStats.signups;
    const shareUrl = `${config.app.baseUrl}/referrals/go/${referrer.code}`;

    return res.render('referrals/dashboard', {
      title: 'Your referrals',
      referrer,
      balance,
      linkStats,
      tab,
      rows: tabRows.rows,
      earnings,
      payouts,
      shareUrl,
      shareLinkedIn: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`,
      shareEmail: `mailto:?subject=${encodeURIComponent(`Join me on ${config.app.name}`)}&body=${encodeURIComponent(`I use ${config.app.name} for Salesforce work. You can sign up here: ${shareUrl}`)}`,
      payoutMethods: PAYOUT_METHODS,
      payoutLabels: PAYOUT_METHOD_LABELS,
      windowDays: ATTRIBUTION_WINDOW_DAYS,
      commissionableProducts: COMMISSIONABLE_PRODUCTS,
      commissionLabels: COMMISSION_LABELS,
      notCommissionable: NOT_COMMISSIONABLE_LABELS,
      formatMinor,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/referrals', req.query, p)
    });
  })
);

router.post(
  '/join',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await Referral.enrol(req.session.user.id);
    req.flash('success', 'You are in. Share your link and anything it brings in is credited when it is paid.');
    return res.redirect('/referrals');
  })
);

/**
 * Where the money goes. Stored as free text and never transmitted anywhere by this
 * application: an administrator reads it and makes the transfer by hand.
 */
router.post(
  '/payout-details',
  writeLimiter,
  [body('reference').optional({ checkFalsy: true }).trim().isLength({ max: 255 })],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', 'That payout reference is too long.');
      return res.redirect('/referrals');
    }

    try {
      await Referral.setPayoutDetails(req.session.user.id, {
        method: req.body.method || null,
        reference: req.body.reference || null
      });
      req.flash('success', 'Payout details saved.');
    } catch (err) {
      if (err.code !== 'BAD_PAYOUT_METHOD') throw err;
      req.flash('error', err.message);
    }

    return res.redirect('/referrals');
  })
);

/*
 * The sales agent dashboard. Only for an account that is an ACTIVE agent: anybody else gets
 * the site's 404, the same answer as a page that does not exist — an agent dashboard is not
 * something a non-agent needs told they lack.
 */
async function requireActiveAgent(req, res, next) {
  try {
    const agent = await SalesAgent.activeAgentFor(req.session.user.id);
    if (!agent) return next('router');
    res.locals.agent = agent;
    return next();
  } catch (err) {
    return next(err);
  }
}

const PEOPLE_ROLES = ['consultant', 'company', 'other'];
const PEOPLE_VERIFIED = ['yes', 'no'];

async function renderAgent(req, res, { status = 200, leadErrors = null, leadValues = {} } = {}) {
  const agent = res.locals.agent;
  const userId = req.session.user.id;
  const stage = isStage(req.query.stage) ? req.query.stage : '';
  const showAll = req.query.leads === 'all';
  const people = {
    q: typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '',
    role: PEOPLE_ROLES.includes(req.query.role) ? req.query.role : '',
    verified: PEOPLE_VERIFIED.includes(req.query.verified) ? req.query.verified : ''
  };
  const [stats, summary, leads, earnings, cameFrom] = await Promise.all([
    SalesAgent.statsFor(userId),
    AgentLead.summaryFor(userId),
    AgentLead.list(userId, { stage, limit: showAll ? 200 : 10 }),
    SalesAgent.earningsFor(userId),
    SalesAgent.peopleForAgent(userId, people)
  ]);
  const link = `${config.app.baseUrl}/s/${agent.code}`;
  const taxLink = `${config.app.baseUrl}/t/${agent.code}`;
  // Every link on the page is built from the current query with one thing changed, so a
  // stage filter survives a people search and the other way round.
  const linkWith = (change) => {
    const params = new URLSearchParams();
    const merged = { stage, leads: showAll ? 'all' : '', ...people, ...change };
    Object.entries(merged).forEach(([k, v]) => { if (v) params.set(k, v); });
    const str = params.toString();
    return `/referrals/agent${str ? `?${str}` : ''}`;
  };
  return res.status(status).render('referrals/agent', {
    title: 'Sales agent dashboard',
    agent,
    agentCode: `AGT-${agent.code}`,
    link,
    taxLink,
    stats,
    signupRatePct: stats.link_opens > 0 ? Math.round((stats.signups / stats.link_opens) * 100) : null,
    summary,
    leads: leads.rows,
    leadsTotal: leads.total,
    stage,
    showAll,
    stages: LEAD_STAGES,
    sources: LEAD_SOURCES,
    stageFor,
    sourceLabel,
    earnings,
    agentEarnings: AGENT_EARNINGS,
    agentNotEarning: AGENT_NOT_EARNING,
    cameFrom,
    people,
    linkWith,
    leadErrors,
    leadValues,
    currentUrl: req.originalUrl,
    formatMinor
  });
}

router.get('/agent', requireActiveAgent, asyncHandler((req, res) => renderAgent(req, res)));

router.post(
  '/agent/leads',
  requireActiveAgent,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { value, errors } = AgentLead.inputFrom(req.body);
    if (errors) {
      // Re-rendered with the modal open and every typed value kept: a refused lead must not
      // cost the agent the details they just typed.
      return renderAgent(req, res, { status: 422, leadErrors: errors, leadValues: req.body });
    }
    await AgentLead.create(req.session.user.id, value);
    req.flash('success', `${value.company} added to your leads.`);
    return res.redirect('/referrals/agent');
  })
);

router.post(
  '/agent/leads/:id/stage',
  requireActiveAgent,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const moved = await AgentLead.setStage(req.session.user.id, req.params.id, req.body.stage);
    if (!moved) req.flash('error', 'That lead could not be moved.');
    return res.redirect(returnTo(req, '/referrals/agent'));
  })
);

module.exports = router;
