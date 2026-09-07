'use strict';

const express = require('express');

const ConsultantProfile = require('../models/ConsultantProfile');
const ImageBlob = require('../models/ImageBlob');
const Skill = require('../models/Skill');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { ROLE_CATEGORIES, isValidRole } = require('../config/roleTaxonomy');
const countries = require('../config/all-countries.json');

const router = express.Router();

const SENIORITIES = ['junior', 'mid', 'senior', 'lead'];

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = {
      q: req.query.q ? String(req.query.q).slice(0, 120) : '',
      role: isValidRole(req.query.role) ? req.query.role : '',
      seniority: SENIORITIES.includes(req.query.seniority) ? req.query.seniority : '',
      country: /^[A-Z]{2}$/.test(req.query.country || '') ? req.query.country : '',
      work_mode: ['remote', 'hybrid', 'onsite'].includes(req.query.work_mode) ? req.query.work_mode : '',
      availability: ['immediate', 'two_weeks', 'one_month'].includes(req.query.availability) ? req.query.availability : '',
      certified: req.query.certified === '1' ? '1' : '',
      rate_max: req.query.rate_max || ''
    };

    const { page, perPage, limit, offset } = paginationFrom(req.query);
    const sort = ['relevance', 'newest', 'rate_asc', 'rate_desc'].includes(req.query.sort) ? req.query.sort : 'relevance';

    const { rows, total } = await ConsultantProfile.browse(filters, { limit, offset, sort });

    res.render('consultants/index', {
      title: res.locals.seo.title,
      consultants: rows,
      filters,
      sort,
      roleCategories: ROLE_CATEGORIES,
      countries,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/consultants', req.query, p)
    });
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
    if (!profile || (!profile.is_public && !isSelf && !(viewer && viewer.isAdmin))) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const [skills, certifications, experiences] = await Promise.all([
      Skill.forConsultant(profile.user_id),
      ConsultantProfile.listCertifications(profile.user_id),
      ConsultantProfile.listExperiences(profile.user_id)
    ]);

    return res.render('consultants/show', {
      title: `${profile.name} — ${profile.headline || 'Salesforce consultant'}`,
      profile,
      skills,
      certifications,
      experiences,
      isSelf,
      // Contact details are for signed-in companies only. An open directory of
      // e-mail addresses is a scraping target, and consultants did not consent to that.
      canSeeContact: Boolean(viewer && (viewer.isCompany || viewer.isRecruiter || viewer.isAdmin))
    });
  })
);

module.exports = router;
