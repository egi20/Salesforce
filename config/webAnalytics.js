'use strict';

/**
 * Third-party web analytics: Google Analytics 4 AND Cloudflare Web Analytics, side by side.
 *
 * WHY BOTH. Until now this site loaded nothing from anybody and counted visits itself
 * (`visit_geo_daily`, one number per country per day — still there, still the yardstick).
 * The two providers run beside it, each with its own screen under /admin/analytics, the
 * arrangement SAP Hub settled on. They are not equivalent, and every rule below follows
 * from the difference:
 *
 *   - Cloudflare Web Analytics sets NO cookie and keeps no identifier. It is disclosed in
 *     the privacy policy and needs nobody's consent, so its beacon loads for everybody.
 *   - GA4 sets `_ga` cookies and sends the visit to Google. In the EU that needs consent
 *     BEFORE it loads, so with GA4 configured the site asks a real question — "Allow
 *     analytics" / "Decline", equal weight — and gtag is never requested until the visitor
 *     allows it. Declining loads nothing at all. The choice can be changed from the footer
 *     at any time, because consent nobody can withdraw is not consent.
 *
 * Everything is OFF unless configured, and each half is independent: the tag needs only its
 * public id, the admin screen needs the API credentials as well. Nothing is rendered for a
 * provider that is not configured — no script, no CSP host, no sentence in the policy. That
 * is what keeps "the CSP allows no third-party host" true for every deployment that has not
 * deliberately chosen otherwise.
 *
 * Removing one provider is deleting its environment variables. With them unset the code
 * does nothing and says nothing.
 */

const GA4_ID_RE = /^G-[A-Z0-9]{4,20}$/;
const GA4_PROPERTY_RE = /^\d{6,15}$/;
const CF_HEX_RE = /^[a-f0-9]{32}$/;

function readServiceAccount(raw) {
  if (!raw) return null;
  // Raw JSON or base64 of it: a private key's newlines do not survive every dashboard's
  // environment-variable box, and base64 has none.
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const parsed = JSON.parse(text);
  return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
}

function load(env = process.env) {
  const ga4 = {
    measurementId: (env.GA4_MEASUREMENT_ID || '').trim(),
    propertyId: (env.GA4_PROPERTY_ID || '').trim(),
    serviceAccountRaw: env.GA4_SERVICE_ACCOUNT_JSON || ''
  };
  const cloudflare = {
    beaconToken: (env.CF_WEB_ANALYTICS_TOKEN || '').trim(),
    // Optional. The GraphQL API's site tag is NOT the snippet's token, so nothing defaults
    // it: without it the report filters on the host the site is served from, which this
    // application knows. Set it only to use the dashboard's own key.
    explicitSiteTag: (env.CF_WEB_ANALYTICS_SITE_TAG || '').trim(),
    accountId: (env.CF_ACCOUNT_ID || '').trim(),
    apiToken: (env.CF_API_TOKEN || '').trim()
  };
  return { ga4, cloudflare };
}

const settings = load();

function problems(s = settings) {
  const out = [];
  const { ga4, cloudflare } = s;
  if (ga4.measurementId && !GA4_ID_RE.test(ga4.measurementId)) {
    out.push('GA4_MEASUREMENT_ID must look like G-XXXXXXXXXX (the web stream id, not the property number)');
  }
  if (ga4.propertyId && !GA4_PROPERTY_RE.test(ga4.propertyId)) {
    out.push('GA4_PROPERTY_ID must be the numeric property id, not the G- measurement id');
  }
  if (ga4.serviceAccountRaw) {
    try {
      const sa = readServiceAccount(ga4.serviceAccountRaw);
      if (!sa.clientEmail || !sa.privateKey) out.push('GA4_SERVICE_ACCOUNT_JSON has no client_email or private_key');
    } catch {
      out.push('GA4_SERVICE_ACCOUNT_JSON is neither JSON nor base64-encoded JSON');
    }
  }
  if (cloudflare.beaconToken && !CF_HEX_RE.test(cloudflare.beaconToken)) {
    out.push('CF_WEB_ANALYTICS_TOKEN must be the 32-character token from the snippet, without quotes');
  }
  if (cloudflare.explicitSiteTag && !CF_HEX_RE.test(cloudflare.explicitSiteTag)) {
    out.push('CF_WEB_ANALYTICS_SITE_TAG must be 32 hexadecimal characters');
  }
  if (cloudflare.accountId && !CF_HEX_RE.test(cloudflare.accountId)) {
    out.push('CF_ACCOUNT_ID must be the 32-character account id');
  }
  return out;
}

/**
 * A malformed id is not an error anywhere else: the tag loads, sends to nobody, and the
 * screen says "no data" for a month. That is the measurement answering the wrong question,
 * so it stops the boot instead.
 */
function assertWebAnalyticsIntegrity(s = settings) {
  const found = problems(s);
  if (found.length) throw new Error(`Web analytics configuration: ${found.join('; ')}`);
}

const ga4TagEnabled = (s = settings) => GA4_ID_RE.test(s.ga4.measurementId);
const ga4ReportingEnabled = (s = settings) =>
  GA4_PROPERTY_RE.test(s.ga4.propertyId) && Boolean(s.ga4.serviceAccountRaw);
const cloudflareTagEnabled = (s = settings) => CF_HEX_RE.test(s.cloudflare.beaconToken);
const cloudflareReportingEnabled = (s = settings) =>
  CF_HEX_RE.test(s.cloudflare.accountId) && Boolean(s.cloudflare.apiToken);

/*
 * The ONLY third-party hosts the policy can ever name for scripts and connections, and only
 * while their provider is configured. Declared here, once, so the CSP and the test that
 * guards it read the same list — the reason `EMBED_HOSTS` is shared from
 * `utils/videoEmbed.js` rather than written out twice.
 */
const GA4_HOSTS = Object.freeze({
  script: ['https://www.googletagmanager.com'],
  connect: [
    'https://www.google-analytics.com',
    'https://*.google-analytics.com',
    'https://*.analytics.google.com',
    'https://www.googletagmanager.com'
  ]
});
const CLOUDFLARE_HOSTS = Object.freeze({
  script: ['https://static.cloudflareinsights.com'],
  connect: ['https://cloudflareinsights.com']
});

/** Hosts the CSP must add — only for a provider whose tag is actually rendered. */
function cspAdditions(s = settings) {
  const script = [];
  const connect = [];
  if (ga4TagEnabled(s)) {
    script.push(...GA4_HOSTS.script);
    connect.push(...GA4_HOSTS.connect);
  }
  if (cloudflareTagEnabled(s)) {
    script.push(...CLOUDFLARE_HOSTS.script);
    connect.push(...CLOUDFLARE_HOSTS.connect);
  }
  return { script, connect };
}

/** What the views need, and nothing secret. */
function publicTags(s = settings) {
  return {
    ga4Id: ga4TagEnabled(s) ? s.ga4.measurementId : null,
    cloudflareToken: cloudflareTagEnabled(s) ? s.cloudflare.beaconToken : null
  };
}

module.exports = {
  settings,
  load,
  problems,
  readServiceAccount,
  assertWebAnalyticsIntegrity,
  ga4TagEnabled,
  ga4ReportingEnabled,
  cloudflareTagEnabled,
  cloudflareReportingEnabled,
  cspAdditions,
  publicTags,
  GA4_HOSTS,
  CLOUDFLARE_HOSTS
};
