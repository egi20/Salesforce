'use strict';

/**
 * What counts as one OPEN of a sales agent's link — decided here, once, for every address
 * the link can arrive on.
 *
 * It used to be decided inside `GET /s/:code` alone, and that undercounted for a reason no
 * filter could fix: `/s/<code>` redirects to `/auth/register?a=<code>`, and that second
 * address is the one in the address bar afterwards. Copied from there — by the agent after
 * testing their own link, or by anybody forwarding the page — it credits every sign-up to
 * the agent and never passed through `/s/`, so the column read "few opens, sign-ups
 * growing" while the people behind it were perfectly real. Both addresses now ask this
 * function, so the opens column measures the people who arrived however the link travelled.
 *
 * The rules are the same on both:
 *   - a PERSON, not a crawler (`looksLikeAPerson`) and not a chat app drawing a preview card
 *     (`LINK_PREVIEW`);
 *   - ONCE per session per code, so a refresh, the redirect from `/s/` landing on the form,
 *     or a second click is not a second open;
 *   - NOBODY SIGNED IN. They already have an account and cannot sign up through anybody's
 *     link, and the commonest signed-in visitor is the agent checking their own link — each
 *     new device or private window counted them again. The registration form is guest-only
 *     already; `/s/` was not.
 *
 * Counting never decides attribution: a visitor we decline to count is still credited if
 * they sign up. Attribution is first touch and lives in the session and the URL.
 */
const SalesAgent = require('../models/SalesAgent');
const { looksLikeAPerson, LINK_PREVIEW } = require('../middleware/visitGeo');

// LINK_PREVIEW is defined once, in middleware/visitGeo.js, because a referral link's opens are
// counted by this same rule (routes/referrals.js). Two copies of a fetcher list drift.

/** Pure: would this request be counted for this code? Separate so the rule is testable. */
function shouldCount({ signedIn, userAgent, alreadyCounted, code }) {
  if (signedIn) return false;
  if (!looksLikeAPerson(userAgent) || LINK_PREVIEW.test(userAgent || '')) return false;
  return !(alreadyCounted || []).includes(code);
}

/**
 * Count an open for `agent` if this request is one. Remembers the code in the session so the
 * same visitor is not counted again. Returns whether it counted.
 */
async function countOpenOnce(req, agent) {
  if (!agent) return false;
  const counted = Array.isArray(req.session.salesAgentOpens) ? req.session.salesAgentOpens : [];
  const signedIn = Boolean(req.session.user);
  if (!shouldCount({ signedIn, userAgent: req.get('user-agent') || '', alreadyCounted: counted, code: agent.code })) {
    return false;
  }
  // Capped, because a session is not somewhere to accumulate an unbounded list.
  req.session.salesAgentOpens = [...counted, agent.code].slice(-10);
  await SalesAgent.countOpen(agent.user_id);
  return true;
}

/**
 * Pure: would this request count as an open of the agent's TAX link (`/t/<code>`, 2026-11-12)?
 * The same person and preview filters, once per session per code — but a signed-in visitor
 * DOES count here, because tax optimisation is for people who already have an account. The
 * one signed-in visitor who does not count is the agent checking their own link.
 */
function shouldCountTax({ viewerId, agentUserId, userAgent, alreadyCounted, code }) {
  if (viewerId && viewerId === agentUserId) return false;
  if (!looksLikeAPerson(userAgent) || LINK_PREVIEW.test(userAgent || '')) return false;
  return !(alreadyCounted || []).includes(code);
}

/**
 * Count an open of `agent`'s tax link if this request is one. Its OWN session list
 * (`salesAgentTaxOpens`), so opening the sign-up link never uses up the tax link's open,
 * nor the other way round. Best-effort: a counting failure never stops the redirect.
 */
async function countTaxOpenOnce(req, agent) {
  try {
    if (!agent || !req.session) return false;
    const counted = Array.isArray(req.session.salesAgentTaxOpens) ? req.session.salesAgentTaxOpens : [];
    const viewerId = req.session.user ? req.session.user.id : null;
    if (!shouldCountTax({ viewerId, agentUserId: agent.user_id, userAgent: req.get('user-agent') || '', alreadyCounted: counted, code: agent.code })) {
      return false;
    }
    req.session.salesAgentTaxOpens = [...counted, agent.code].slice(-10);
    await SalesAgent.countTaxOpen(agent.user_id);
    return true;
  } catch (err) {
    console.error(`Sales agent tax-link open not counted: ${err.message}`);
    return false;
  }
}

module.exports = { LINK_PREVIEW, shouldCount, countOpenOnce, shouldCountTax, countTaxOpenOnce };
