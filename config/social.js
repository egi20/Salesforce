'use strict';

/**
 * The Hub's own social accounts (ported from SAP Hub), and the one place that knows them.
 *
 * WHY CONFIGURED AND NOT WRITTEN INTO THE FOOTER. A social icon is a link like any other,
 * and an icon row is the easiest place on a site to leave a link to an account that was
 * never opened — it looks finished, nobody clicks it from the inside, and the first person
 * to find out is a visitor landing on a 404 under somebody else's brand. So an account that
 * is not set is NOT RENDERED, and the row is absent until one is.
 *
 * Operational, not catalogue: the accounts change without a deploy, so each is a setting on
 * /admin/settings (config/settings.js generates one per platform from this list). Each host
 * is pinned, and checked twice — when it is saved and again where it is rendered — because
 * a pasted link with a typo in the host looks right and is wrong on every page.
 *
 * SAP Hub also reads SOCIAL_* environment variables as a fallback. This repo never had
 * them, so there is nothing to fall back to and the setting is the only source.
 */
const PLATFORMS = Object.freeze([
  { key: 'linkedin', label: 'LinkedIn', icon: 'bi-linkedin', hosts: ['www.linkedin.com', 'linkedin.com'] },
  { key: 'x', label: 'X', icon: 'bi-twitter-x', hosts: ['x.com', 'www.x.com', 'twitter.com'] },
  { key: 'youtube', label: 'YouTube', icon: 'bi-youtube', hosts: ['www.youtube.com', 'youtube.com'] },
  { key: 'instagram', label: 'Instagram', icon: 'bi-instagram', hosts: ['www.instagram.com', 'instagram.com'] },
  { key: 'tiktok', label: 'TikTok', icon: 'bi-tiktok', hosts: ['www.tiktok.com', 'tiktok.com'] }
]);

/** Why a value cannot be this platform's link, or null. `name` is the form label. */
function problemWith(platform, value, name = platform.label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return `${name} is not a web address`;
  }
  if (url.protocol !== 'https:') return `${name} must start with https://`;
  if (url.username || url.password) return `${name} must not carry a user name or password`;
  if (!platform.hosts.includes(url.hostname)) return `${name} points at ${url.hostname}, not ${platform.label}`;
  return null;
}

/** The settings key that holds a platform's link. */
function settingKeyFor(platform) {
  return `social_${platform.key}`;
}

/**
 * The links to render, in order. `settings` is `AppSetting.all()`. A value that fails the
 * host check here is dropped rather than rendered, whatever route it took into the table.
 */
function socialLinks(settings = {}) {
  return PLATFORMS
    .map((platform) => ({ platform, value: String(settings[settingKeyFor(platform)] || '').trim() }))
    .filter(({ platform, value }) => value && !problemWith(platform, value))
    .map(({ platform, value }) => ({ key: platform.key, label: platform.label, icon: platform.icon, href: value }));
}

module.exports = { PLATFORMS, problemWith, settingKeyFor, socialLinks };
