'use strict';

const config = require('./config');

/**
 * Per-page canonical URL + meta description, plus a JobPosting JSON-LD builder.
 *
 * Rule carried over: the sitemap and the canonical set must never advertise a URL
 * that robots.txt disallows. `PUBLIC_PATHS` is the allowlist both consult.
 */
const PAGE_META = {
  '/': {
    title: 'Salesforce Hub — jobs, talent and day rates for the Salesforce ecosystem',
    description:
      'Find Salesforce contract and permanent roles, hire certified consultants, and see real day-rate benchmarks across Sales Cloud, Service Cloud, Revenue Cloud, Data Cloud and Agentforce.'
  },
  '/jobs': {
    title: 'Salesforce jobs and contracts',
    description:
      'Browse Salesforce jobs by cloud, role, seniority, country and day rate. Sales Cloud, Service Cloud, CPQ, MuleSoft, Data Cloud, Agentforce and more.'
  },
  '/consultants': {
    title: 'Hire Salesforce consultants',
    description:
      'Search certified Salesforce consultants by cloud specialism, certification, availability and day rate.'
  },
  '/companies': {
    title: 'Companies hiring on Salesforce Hub',
    description: 'Partners, ISVs and end customers hiring Salesforce talent.'
  },
  '/rates': {
    title: 'Salesforce day rate index',
    description:
      'Aggregated day rates for Salesforce roles, contributed anonymously by the community. Aggregates below three contributors are suppressed.'
  },
  '/tax-advisory': {
    title: 'Tax advisory for Salesforce contractors',
    description:
      'An introduction to a specialist who works in your country. Salesforce Hub does not calculate your tax, your take-home pay or a saving.'
  },
  '/auth/login': { title: 'Sign in', description: 'Sign in to Salesforce Hub.' },
  '/auth/register': { title: 'Create an account', description: 'Join Salesforce Hub as a consultant or a hiring company.' }
};

/** Paths that may appear in the sitemap and carry a canonical URL. */
// `/tax-advisory` is indexable; `/tax-advisory/enquire` deliberately is not. A form page
// carries no content a search result can usefully show, and the page above it already
// links to it.
const PUBLIC_PATHS = ['/', '/jobs', '/consultants', '/companies', '/rates', '/tax-advisory', '/faq', '/contact', '/legal/privacy', '/legal/terms'];

function canonicalUrl(path) {
  const clean = String(path || '/').split('?')[0];
  return `${config.app.baseUrl}${clean === '/' ? '' : clean}`;
}

/**
 * Express middleware: expose `seo` on res.locals for every render.
 */
function seoLocals(req, res, next) {
  const meta = PAGE_META[req.path] || {};
  res.locals.seo = {
    title: meta.title || config.app.name,
    description: meta.description || PAGE_META['/'].description,
    canonical: canonicalUrl(req.path),
    ogImage: `${config.app.baseUrl}/images/og-default.svg`,
    indexable: PUBLIC_PATHS.includes(req.path)
  };
  next();
}

/**
 * schema.org JobPosting. Returns null when the job lacks the fields Google requires,
 * so we never emit structured data that fails validation.
 */
function jobPostingJsonLd(job) {
  if (!job || !job.title || !job.created_at) return null;

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    description: job.description || '',
    datePosted: new Date(job.created_at).toISOString(),
    employmentType: job.engagement_type === 'permanent' ? 'FULL_TIME' : 'CONTRACTOR',
    hiringOrganization: {
      '@type': 'Organization',
      name: job.company_name || 'Confidential',
      sameAs: job.company_website || undefined
    },
    jobLocationType: job.work_mode === 'remote' ? 'TELECOMMUTE' : undefined,
    jobLocation: job.country
      ? { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: job.country } }
      : undefined
  };

  if (job.expires_at) ld.validThrough = new Date(job.expires_at).toISOString();

  if (job.rate_min && job.rate_max) {
    ld.baseSalary = {
      '@type': 'MonetaryAmount',
      currency: job.currency || 'EUR',
      value: {
        '@type': 'QuantitativeValue',
        minValue: Number(job.rate_min),
        maxValue: Number(job.rate_max),
        unitText: job.engagement_type === 'permanent' ? 'YEAR' : 'DAY'
      }
    };
  }

  return ld;
}

module.exports = { PAGE_META, PUBLIC_PATHS, canonicalUrl, seoLocals, jobPostingJsonLd };
