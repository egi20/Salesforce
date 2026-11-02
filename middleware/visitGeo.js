'use strict';

const { promisePool } = require('../config/database');
const { countryFromIp, clientIp } = require('../utils/geo');

/**
 * Something that declares itself a crawler, a library or a headless browser — or sends no
 * user agent at all, which no real browser does.
 *
 * Used where a count must mean PEOPLE: a sales agent's link opens (`routes/index.js`),
 * where a chat app drawing a preview card would otherwise read as somebody clicking. It is
 * a test of what a client says about itself, not a proof of a human: a bot that lies about
 * its user agent is still counted.
 */
const NOT_A_PERSON = /bot|crawl|spider|slurp|scan|monitor|uptime|probe|preview|headless|phantom|lighthouse|curl|wget|python|httpclient|okhttp|go-http|java\/|axios|node-fetch|undici|libwww|postman|insomnia/i;

function looksLikeAPerson(userAgent) {
  return Boolean(userAgent) && !NOT_A_PERSON.test(userAgent);
}

/**
 * The Hub's own traffic, which no counter on the site measures.
 *
 * SAP Hub found its analytics screens were mostly counting the people who run the site: the
 * administrators clicking through their own admin panel and signing in to test. A number
 * that measures its own author is worse than no number, because decisions get taken from
 * it. So the admin surface, the CRM and the sign-in pages are never measured, by anybody,
 * and an administrator is not measured ANYWHERE — the same rule for the server-side count,
 * Cloudflare's beacon and GA4, so the three screens keep describing the same population.
 *
 * Cloudflare has no IP filter for a site like this, and GA4's internal-traffic filter keys
 * on an address that changes with the network; not loading the tag is the one exclusion
 * that holds wherever the administrator happens to be.
 *
 * Reads the flags `validateActiveAccount` rebuilt for this request, never a cached copy, so
 * an administrator whose role was revoked is measured again from their next page.
 */
const OWN_PATHS = /^\/(admin|auth|crm)(\/|$)/;

function isOwnTraffic(req) {
  if (OWN_PATHS.test(req.path || '')) return true;
  const user = req.session && req.session.user;
  return Boolean(user && (user.isAdmin || user.isSuperadmin));
}

/**
 * PII-free visitor geography.
 *
 * Records one increment per country per day for real page navigations only, and stores
 * nothing else — no address, no path, no identifier. Asset requests and background
 * fetches are ignored so the count means "people who looked at a page".
 *
 * Entirely fire-and-forget: analytics must never be able to fail a page render.
 */
function visitGeo(req, res, next) {
  next();

  try {
    if (req.method !== 'GET') return;
    if (req.get('sec-fetch-dest') && req.get('sec-fetch-dest') !== 'document') return;
    if (req.xhr) return;
    if (req.path === '/healthz') return;
    if (isOwnTraffic(req)) return;
    if (/\.(css|js|png|jpe?g|webp|svg|ico|txt|xml|map|woff2?)$/i.test(req.path)) return;

    const country = countryFromIp(clientIp(req));
    if (!country) return;

    promisePool
      .query(
        `INSERT INTO visit_geo_daily (day, country, visits) VALUES (CURDATE(), ?, 1)
         ON DUPLICATE KEY UPDATE visits = visits + 1`,
        [country]
      )
      .catch((err) => console.error(`visitGeo insert failed: ${err.message}`));
  } catch (err) {
    console.error(`visitGeo failed: ${err.message}`);
  }
}

module.exports = { visitGeo, looksLikeAPerson, isOwnTraffic };
