'use strict';

const express = require('express');

const ConsultantProfile = require('../models/ConsultantProfile');
const ConsultantHiddenCompany = require('../models/ConsultantHiddenCompany');
const ImageBlob = require('../models/ImageBlob');
const Skill = require('../models/Skill');
const Job = require('../models/Job');
const Application = require('../models/Application');
const CompanyShortlist = require('../models/CompanyShortlist');
const { asyncHandler } = require('../middleware/errorHandler');
const { isHiring } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { requireIdParam } = require('../utils/ids');
const { returnTo } = require('../utils/returnTo');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { countryName } = require('../utils/geo');
const { ROLE_CATEGORIES, SENIORITY_LEVELS, isValidRole, roleLabel, seniorityLabel } = require('../config/roleTaxonomy');
const { CLOUD_FAMILIES, isValidFamily, familyLabel } = require('../config/cloudFamilies');
const { ALL_CERTIFICATIONS, isKnownCertification, shortCertificationName } = require('../config/certifications');
const { AVAILABILITY, isValidAvailability, availabilityLabel } = require('../config/availability');
const { workModeLabel } = require('../config/jobTaxonomy');
const linkedin = require('../config/linkedin');
const countries = require('../config/all-countries.json');

const router = express.Router();

const SENIORITIES = SENIORITY_LEVELS.map((s) => s.value);
const WORK_MODES = ['remote', 'hybrid', 'onsite'];
const COUNTRY_CODES = new Set(countries.map((c) => c.code));
const SORTS = ['relevance', 'newest', 'rate_asc', 'rate_desc'];
/** "Minimum years of experience" choices. A fixed set, so a count can sit beside each. */
const MIN_YEARS = [2, 5, 8, 10, 15];

/*
 * A checkbox group posts one value per ticked box, so a field arrives as a string or an
 * array. Every element is checked and anything else dropped — the builder re-checks, but a
 * value that is not ours should not survive this far, or it would show up as a chip.
 */
function listFrom(value, isValid) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(raw.map(String))].filter(isValid).slice(0, 30);
}

function filtersFrom(query, { canShortlist }) {
  const rateMax = Number(query.rate_max);
  return {
    q: query.q ? String(query.q).slice(0, 120) : '',
    role: listFrom(query.role, isValidRole),
    seniority: listFrom(query.seniority, (v) => SENIORITIES.includes(v)),
    country: listFrom(query.country, (v) => COUNTRY_CODES.has(v)),
    work_mode: listFrom(query.work_mode, (v) => WORK_MODES.includes(v)),
    availability: listFrom(query.availability, isValidAvailability),
    clouds: listFrom(query.clouds, isValidFamily),
    certifications: listFrom(query.certifications, isKnownCertification),
    min_years: MIN_YEARS.includes(Number(query.min_years)) ? String(Number(query.min_years)) : '',
    rate_max: Number.isFinite(rateMax) && rateMax > 0 ? String(Math.round(rateMax)) : '',
    linkedin_verified: query.linkedin_verified === '1' ? '1' : '',
    trailhead: query.trailhead === '1' ? '1' : '',
    // Only an account that HAS a shortlist can filter on one; for anybody else it is dropped.
    shortlist: canShortlist && query.shortlist === '1' ? '1' : ''
  };
}

/*
 * The filters in force as removable chips above the list, built from the VALIDATED filters
 * (a value the route dropped must not look applied). Each link is the current URL minus that
 * one value, so it works without scripting — the same shape as /jobs.
 */
const CHIP_FIELDS = [
  ['role', roleLabel],
  ['clouds', familyLabel],
  ['certifications', shortCertificationName],
  ['country', countryName],
  ['seniority', (v) => seniorityLabel(v, { full: true })],
  ['work_mode', workModeLabel],
  ['availability', availabilityLabel]
];
const SINGLE_CHIPS = {
  min_years: (v) => `${v}+ years`,
  rate_max: (v) => `Up to ${v} / day`,
  linkedin_verified: () => 'LinkedIn verified',
  trailhead: () => 'On Trailhead',
  shortlist: () => 'My shortlist'
};

function urlWithout(filters, sort, key, value) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    for (const item of Array.isArray(v) ? v : [v]) {
      if (item === '' || item === null || item === undefined) continue;
      if (k === key && (value === undefined || String(item) === String(value))) continue;
      params.append(k, item);
    }
  }
  if (sort && sort !== 'relevance') params.set('sort', sort);
  const qs = params.toString();
  return qs ? `/consultants?${qs}` : '/consultants';
}

function activeChipsFor(filters, sort) {
  const chips = [];
  if (filters.q) chips.push({ label: `“${filters.q}”`, href: urlWithout(filters, sort, 'q') });
  for (const [key, label] of CHIP_FIELDS) {
    for (const value of filters[key]) chips.push({ label: label(value), href: urlWithout(filters, sort, key, value) });
  }
  for (const [key, label] of Object.entries(SINGLE_CHIPS)) {
    if (filters[key]) chips.push({ label: label(filters[key]), href: urlWithout(filters, sort, key) });
  }
  return chips;
}

const countsOf = (rows) => Object.fromEntries(rows.map((r) => [r.value, r.count]));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.session.user || null;
    const canShortlist = Boolean(user && (user.isCompany || user.isRecruiter));
    const filters = filtersFrom(req.query, { canShortlist });
    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const sort = SORTS.includes(req.query.sort) ? req.query.sort : 'relevance';

    /*
     * The viewer, resolved once and handed to the builder. Everything about who can see what
     * lives inside `buildFilter`; this line is the only thing the route decides. It goes into
     * EVERY query below — the counts and the hero figures as well as the list, because a
     * count that includes a consultant who hid from this company is a measurement of them.
     */
    const viewer = await ConsultantHiddenCompany.viewerFor(user);
    const query = {
      ...filters,
      viewer,
      shortlisted_by: filters.shortlist ? user.id : null
    };
    const everyone = { viewer };

    const [
      { rows, total },
      roleFacets, countryFacets, allCountries, seniorityFacets, modeFacets, availabilityFacets,
      cloudFacets, allClouds, certFacets, allCerts, yearCounts,
      listedTotal, availableNow, shortlistTotal, hiringJobs
    ] = await Promise.all([
      ConsultantProfile.browse(query, { limit, offset, sort }),
      ConsultantProfile.facet('role', query),
      ConsultantProfile.facet('country', query),
      // Every country, cloud and credential somebody listed actually has: the list a reader
      // picks from does not shrink because another group is ticked.
      ConsultantProfile.facet('country', everyone),
      ConsultantProfile.facet('seniority', query),
      ConsultantProfile.facet('work_mode', query),
      ConsultantProfile.facet('availability', query),
      ConsultantProfile.facet('clouds', query),
      ConsultantProfile.facet('clouds', everyone),
      ConsultantProfile.facet('certifications', query),
      ConsultantProfile.facet('certifications', everyone),
      ConsultantProfile.yearsFacet(query, MIN_YEARS),
      ConsultantProfile.count(everyone),
      ConsultantProfile.count({ viewer, availability: ['immediate'] }),
      canShortlist ? ConsultantProfile.count({ viewer, shortlisted_by: user.id }) : Promise.resolve(0),
      // "Invite to apply" needs an open role to invite somebody to — a conversation is always
      // anchored to one — so the button goes to that form only when there is one.
      canShortlist ? Job.browse({ company_user_id: user.id, status: 'open' }, { limit: 1 }) : Promise.resolve({ total: 0 })
    ]);

    const shortlistedIds = canShortlist ? await CompanyShortlist.idsFor(user.id, rows.map((r) => r.user_id)) : null;

    // Countries: only those with a listed consultant, by name, each counted under the OTHER
    // filters. A ticked country is kept even at zero so it can always be unticked.
    const countryCounts = countsOf(countryFacets);
    const countryOptions = allCountries.map((f) => ({ code: f.value, count: countryCounts[f.value] || 0 }));
    for (const code of filters.country) {
      if (!countryOptions.some((c) => c.code === code)) countryOptions.push({ code, count: 0 });
    }
    countryOptions.sort((a, b) => countryName(a.code).localeCompare(countryName(b.code)));

    // Credentials: official names somebody listed holds, in the catalogue's own order.
    const heldCerts = new Set(allCerts.map((c) => c.value).concat(filters.certifications));
    const certCounts = countsOf(certFacets);
    const certOptions = ALL_CERTIFICATIONS.filter((n) => heldCerts.has(n)).map((n) => ({ name: n, count: certCounts[n] || 0 }));

    const chips = activeChipsFor(filters, sort);

    res.render('consultants/index', {
      title: res.locals.seo.title,
      consultants: rows,
      filters,
      sort,
      roleCategories: ROLE_CATEGORIES,
      cloudFamilies: CLOUD_FAMILIES,
      countryOptions,
      certOptions,
      minYearsOptions: MIN_YEARS,
      availabilityOptions: AVAILABILITY,
      counts: {
        role: countsOf(roleFacets),
        seniority: countsOf(seniorityFacets),
        work_mode: countsOf(modeFacets),
        availability: countsOf(availabilityFacets),
        clouds: countsOf(cloudFacets),
        years: yearCounts
      },
      /*
       * The hero's figures, each a count of what this viewer can actually browse: listed
       * consultants, those who said "available now", and the clouds at least one of them
       * works in — not the size of the catalogue, which would be a claim about nobody.
       */
      stats: {
        consultants: listedTotal,
        availableNow,
        clouds: allClouds.filter((c) => c.count > 0).length
      },
      linkedinEnabled: linkedin.isConfigured(),
      canShortlist,
      shortlistedIds,
      shortlistTotal,
      canInvite: canShortlist && hiringJobs.total > 0,
      returnUrl: req.originalUrl,
      activeChips: chips,
      activeFilterCount: chips.length,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/consultants', req.query, p)
    });
  })
);

/**
 * ★ Shortlist — add or remove, for company and recruiter accounts.
 *
 * Adding refuses a profile this account could not find in the directory (private, taken
 * down, or hidden from this company): a shortlist must not become a way to hold on to a
 * profile somebody has since withdrawn. Removing is always allowed. A fetch gets JSON; a
 * plain form post comes back to the list it came from.
 */
router.post(
  '/:id/shortlist',
  requireIdParam('id'),
  isHiring,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = req.session.user;
    const consultantId = req.params.id;
    const remove = req.body.shortlisted === 'true';
    const isFetch = req.get('sec-fetch-dest') && req.get('sec-fetch-dest') !== 'document';

    if (remove) {
      await CompanyShortlist.remove(user.id, consultantId);
    } else {
      const viewer = await ConsultantHiddenCompany.viewerFor(user);
      const visible = consultantId !== user.id && (await ConsultantProfile.count({ viewer, user_ids: [consultantId] })) === 1;
      if (!visible) {
        if (isFetch) return res.status(404).json({ success: false, error: 'Not found' });
        return res.status(404).render('errors/404', { title: 'Not found' });
      }
      await CompanyShortlist.add(user.id, consultantId);
    }

    if (isFetch) return res.json({ success: true, shortlisted: !remove });
    return res.redirect(returnTo(req, '/consultants'));
  })
);

/**
 * Profile photo.
 *
 * ETag-cached and served straight from the database, because the disk is ephemeral.
 * A conditional request is answered from the ETag alone, without loading the bytes.
 */
router.get(
  '/photo/:id',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const etag = await ImageBlob.getEtag('consultant_photos', req.params.id);
    if (!etag) return res.redirect('/images/avatar-placeholder.svg');

    res.set('ETag', `"${etag}"`);
    res.set('Cache-Control', 'public, max-age=86400');
    if (req.get('if-none-match') === `"${etag}"`) return res.status(304).end();

    const blob = await ImageBlob.get('consultant_photos', req.params.id);
    if (!blob) return res.redirect('/images/avatar-placeholder.svg');

    res.type(blob.content_type);
    return res.send(blob.bytes);
  })
);

router.get(
  '/:id',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const profile = await ConsultantProfile.findByUserId(req.params.id);
    const viewer = req.session.user;
    const isSelf = viewer && viewer.id === req.params.id;

    // A profile that is not public is visible to its owner and to admins only.
    /*
     * TWO switches, not one. `is_public` is the member's; `admin_hidden_at` is a
     * moderator's (migration 033). Either one closes the page to everybody but its owner
     * and an administrator.
     */
    const publiclyVisible = profile && profile.is_public && !profile.admin_hidden_at;
    /*
     * A company the consultant APPLIED to sees the profile they were sent, even while it is
     * private or that company is on the consultant's hidden list — applying is the consultant
     * choosing to show it to them, and the Build-your-profile page says so. A moderator's
     * takedown still wins: that is not the consultant's switch.
     */
    const appliedHere = Boolean(profile && !profile.admin_hidden_at && viewer && viewer.isCompany && !isSelf
      && await Application.consultantAppliedToCompany(profile.user_id, viewer.id));
    if (!profile || (!publiclyVisible && !isSelf && !appliedHere && !(viewer && viewer.isAdmin))) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    /*
     * The same block the directory applies, applied to the page itself.
     *
     * A company excluded from every list could otherwise still open the profile by its URL —
     * which is exactly where a link from a colleague or a search result puts them, so
     * filtering only the lists would protect the consultant from browsing and from nothing
     * else. The owner and an admin are exempt for the same reason they are above.
     *
     * Answered as 404, not 403: "you are not allowed to see this consultant" tells the
     * company that a consultant they can name has blocked them, which is information the
     * consultant was trying not to give them.
     */
    if (!isSelf && !appliedHere && !(viewer && viewer.isAdmin)) {
      const hiddenFrom = await ConsultantHiddenCompany.viewerFor(viewer);
      if (await ConsultantHiddenCompany.blocks(profile.user_id, hiddenFrom)) {
        return res.status(404).render('errors/404', { title: 'Not found' });
      }
    }

    /*
     * Whether the figure is printed at all.
     *
     * A consultant can publish a profile and keep the number they negotiate with to
     * themselves — `rate_visible`, migration 029. The owner and an admin always see it,
     * because the owner is the person it belongs to and an admin is who answers when
     * somebody asks what is stored about them.
     */
    /*
     * "Preview public profile" (?preview=company, owner only): the page exactly as a signed-in
     * company sees it — the rate hidden when it is "on request", contact details shown, no
     * edit controls — with a banner saying it is a preview.
     */
    const preview = Boolean(isSelf && req.query.preview === 'company');
    const showRate = Boolean(profile.rate_visible) || isSelf || (viewer && viewer.isAdmin);

    const [skills, certifications, experiences, projects, clouds, languages, workCountries] = await Promise.all([
      Skill.forConsultant(profile.user_id),
      ConsultantProfile.listCertifications(profile.user_id),
      ConsultantProfile.listExperiences(profile.user_id),
      ConsultantProfile.listProjects(profile.user_id),
      ConsultantProfile.listClouds(profile.user_id),
      ConsultantProfile.listLanguages(profile.user_id),
      ConsultantProfile.listWorkCountries(profile.user_id)
    ]);

    // A conversation is always anchored to a role, so an employer can only approach this
    // consultant if they actually have one open. No open role, no approach button.
    const hiringJobs =
      viewer && viewer.isCompany && !isSelf
        ? (await Job.browse({ company_user_id: viewer.id, status: 'open' }, { limit: 50 })).rows
        : [];

    return res.render('consultants/show', {
      title: `${profile.name} — ${profile.headline || 'Salesforce consultant'}`,
      profile,
      skills,
      certifications,
      experiences,
      projects,
      clouds,
      languages,
      workCountries,
      isSelf: isSelf && !preview,
      preview,
      appliedHere,
      // A preview shows the rate exactly as a company would: not at all when it is on request.
      showRate: preview ? Boolean(profile.rate_visible) : showRate,
      hiringJobs,
      // Contact details are for signed-in companies only. An open directory of
      // e-mail addresses is a scraping target, and consultants did not consent to that.
      canSeeContact: preview || Boolean(viewer && (viewer.isCompany || viewer.isRecruiter || viewer.isAdmin))
    });
  })
);

module.exports = router;
