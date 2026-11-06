'use strict';

const { countryName } = require('./geo');
const { rateUnit } = require('../config/jobTaxonomy');

/**
 * How a job card writes its figures, place, age and company mark — in one module, so the
 * board, the feed, search and the dashboard cannot each format a salary their own way.
 * Formatting only: nothing here decides a figure.
 */

const CURRENCY_SYMBOLS = Object.freeze({ EUR: '€', USD: '$', GBP: '£' });

function moneyPrefix(currency) {
  return CURRENCY_SYMBOLS[currency] || `${currency || ''} `;
}

/*
 * An annual salary reads in thousands ("€90k–132k / yr") and a day rate in units
 * ("€646–950 / day"). The unit comes from the engagement (config/jobTaxonomy.js), never from
 * the size of the number: a large day rate must not be mistaken for a salary.
 */
function compact(value, inThousands) {
  const n = Math.round(Number(value));
  if (!inThousands) return n.toLocaleString('en-GB');
  const k = n / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

/** "€646–950 / day", "€90k–132k / yr", "From €600 / day", or null when nothing is shown. */
function formatRateRange(job) {
  if (!job || !job.rate_visible) return null;
  const min = Number(job.rate_min);
  const max = Number(job.rate_max);
  const hasMin = Number.isFinite(min) && min > 0;
  const hasMax = Number.isFinite(max) && max > 0;
  if (!hasMin && !hasMax) return null;

  const unit = rateUnit(job.engagement_type).replace('/', '') || '';
  const inThousands = job.engagement_type === 'permanent';
  const prefix = moneyPrefix(job.currency);
  const suffix = unit ? ` / ${unit}` : '';

  if (hasMin && hasMax && min !== max) return `${prefix}${compact(min, inThousands)}–${compact(max, inThousands)}${suffix}`;
  if (hasMin && hasMax) return `${prefix}${compact(min, inThousands)}${suffix}`;
  if (hasMin) return `From ${prefix}${compact(min, inThousands)}${suffix}`;
  return `Up to ${prefix}${compact(max, inThousands)}${suffix}`;
}

/**
 * "London, United Kingdom", "Remote · Spain", "Remote". The country is written out: a card
 * reading "IE" asks the reader to know the code.
 */
function jobLocation(job) {
  if (!job) return '';
  const place = [job.city, countryName(job.country)].filter(Boolean).join(', ');
  if (job.work_mode === 'remote') return place ? `Remote · ${place}` : 'Remote';
  return place;
}

/**
 * "Posted today", "Posted 3 days ago", "Posted 2 weeks ago". `now` is a parameter so the
 * function stays testable; templates call it with the default, which is the render time.
 */
function postedAgo(date, now = new Date()) {
  if (!date) return null;
  const then = new Date(date);
  if (Number.isNaN(then.getTime())) return null;
  const days = Math.floor((now - then) / 86400000);
  if (days <= 0) return 'Posted today';
  if (days === 1) return 'Posted yesterday';
  if (days < 14) return `Posted ${days} days ago`;
  if (days < 60) return `Posted ${Math.floor(days / 7)} weeks ago`;
  return `Posted ${then.toISOString().slice(0, 10)}`;
}

/** Up to two initials for a company with no logo: "Northwind Cloud Partners" -> "NC". */
function companyInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

/*
 * A colour per company, stable across pages: the name hashes to one of six SOLID tones in
 * style.css (`.logo-initials.tone-N`). Not the icon-tile gradients — several of those end in
 * #00A1E0, and white initials on that stop are 2.93:1. Every tone here clears 4.5:1.
 */
const TONE_COUNT = 6;

function companyTone(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `tone-${(hash % TONE_COUNT) + 1}`;
}

/*
 * A consultant's own figure for a card: "€763 / day", else "€95 / hour", else "€90k / yr".
 * Null when there is none to print — and a HIDDEN rate arrives here as null already
 * (`ConsultantProfile.browse` selects it through `hiddenUnlessVisible`), so this cannot
 * print a figure the consultant kept back even if a caller forgets to check.
 */
function consultantRate(c) {
  if (!c || !c.rate_visible) return null;
  const prefix = moneyPrefix(c.currency);
  const n = (v) => Number(v);
  if (n(c.day_rate) > 0) return `${prefix}${compact(c.day_rate, false)} / day`;
  if (n(c.hourly_rate) > 0) return `${prefix}${compact(c.hourly_rate, false)} / hour`;
  if (n(c.annual_salary) > 0) return `${prefix}${compact(c.annual_salary, true)} / yr`;
  return null;
}

module.exports = { formatRateRange, jobLocation, postedAgo, companyInitials, companyTone, consultantRate };
