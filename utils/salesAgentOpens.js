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

module.exports = { LINK_PREVIEW, shouldCount, countOpenOnce };
