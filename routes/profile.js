'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const User = require('../models/User');
const ConsultantProfile = require('../models/ConsultantProfile');
const CompanyProfile = require('../models/CompanyProfile');
const ImageBlob = require('../models/ImageBlob');
const Skill = require('../models/Skill');
const { isAuthenticated, isConsultant, isCompany } = require('../middleware/auth');
const { writeLimiter, passwordLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { singleImage } = require('../middleware/fileUpload');
const { requireIdParam } = require('../utils/ids');
const { sanitizeRichText } = require('../utils/sanitize');
const { ROLE_CATEGORIES, ROLE_SLUGS } = require('../config/roleTaxonomy');
const { CERTIFICATIONS } = require('../config/certifications');
const countries = require('../config/all-countries.json');

const router = express.Router();

router.use(isAuthenticated);

router.get('/', (req, res) => res.redirect('/profile/settings'));

router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.session.user.id);
    res.render('profile/settings', { title: 'Account settings', user, errors: [] });
  })
);

/**
 * Self-service role changes are ADD-ONLY and limited to the public roles.
 *
 * The model does the union; this route never computes a role set of its own. A form
 * post therefore cannot remove a role, cannot demote an admin, and cannot grant a
 * privileged role however it is crafted.
 */
router.post(
  '/settings/roles',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const submitted = Array.isArray(req.body.roles) ? req.body.roles : [req.body.roles].filter(Boolean);
    const roles = await User.addSelfServiceRoles(req.session.user.id, submitted);

    if (roles.includes('consultant')) await ConsultantProfile.ensureExists(req.session.user.id);
    if (roles.includes('company')) await CompanyProfile.ensureExists(req.session.user.id, req.session.user.name);

    req.flash('success', 'Roles updated. Removing a role is done by support.');
    return res.redirect('/profile/settings');
  })
);

router.post(
  '/settings/password',
  passwordLimiter,
  [
    body('current_password').notEmpty(),
    body('password')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/)
      .withMessage('Your new password needs at least 8 characters, including an uppercase letter, a lowercase letter and a number.'),
    body('confirm_password').custom((v, { req }) => v === req.body.password).withMessage('The two passwords do not match.')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect('/profile/settings');
    }

    const user = await User.findById(req.session.user.id);
    if (!(await User.verifyPassword(user, req.body.current_password))) {
      req.flash('error', 'Your current password is not correct.');
      return res.redirect('/profile/settings');
    }

    await User.updatePassword(user.id, req.body.password);
    req.flash('success', 'Password updated.');
    return res.redirect('/profile/settings');
  })
);

router.get(
  '/consultant',
  isConsultant,
  asyncHandler(async (req, res) => {
    const userId = req.session.user.id;
    const profile = await ConsultantProfile.ensureExists(userId);
    const [skills, certifications, experiences] = await Promise.all([
      Skill.forConsultant(userId),
      ConsultantProfile.listCertifications(userId),
      ConsultantProfile.listExperiences(userId)
    ]);

    res.render('profile/consultant', {
      title: 'Your consultant profile',
      profile,
      skills,
      certifications,
      experiences,
      roleCategories: ROLE_CATEGORIES,
      certificationGroups: CERTIFICATIONS,
      countries,
      minCompleteness: ConsultantProfile.MIN_COMPLETENESS_TO_PUBLISH,
      errors: []
    });
  })
);

router.post(
  '/consultant',
  isConsultant,
  writeLimiter,
  [
    body('headline').optional({ checkFalsy: true }).isLength({ max: 200 }),
    body('primary_role').optional({ checkFalsy: true }).isIn(ROLE_SLUGS),
    body('day_rate').optional({ checkFalsy: true }).isFloat({ min: 0, max: 100000 }),
    body('years_experience').optional({ checkFalsy: true }).isInt({ min: 0, max: 60 })
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg || 'Please check the form.');
      return res.redirect('/profile/consultant');
    }

    await ConsultantProfile.update(req.session.user.id, {
      headline: req.body.headline || null,
      bio: sanitizeRichText(req.body.bio || ''),
      primary_role: req.body.primary_role || null,
      seniority: req.body.seniority || null,
      years_experience: req.body.years_experience || null,
      country: /^[A-Z]{2}$/.test(req.body.country || '') ? req.body.country : null,
      city: req.body.city || null,
      work_mode: req.body.work_mode || 'remote',
      willing_to_travel: req.body.willing_to_travel === 'on' ? 1 : 0,
      day_rate: req.body.day_rate || null,
      currency: /^[A-Z]{3}$/.test(req.body.currency || '') ? req.body.currency : 'EUR',
      availability: req.body.availability || 'not_available',
      available_from: req.body.available_from || null,
      linkedin_url: req.body.linkedin_url || null,
      website_url: req.body.website_url || null,
      trailblazer_url: req.body.trailblazer_url || null
    });

    const names = String(req.body.skills || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 40);
    const skills = await Skill.findOrCreateMany(names);
    await Skill.setForConsultant(req.session.user.id, skills.map((s) => s.id));
    await ConsultantProfile.recomputeCompleteness(req.session.user.id);

    req.flash('success', 'Profile saved.');
    return res.redirect('/profile/consultant');
  })
);

router.post(
  '/consultant/visibility',
  isConsultant,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const wantPublic = req.body.is_public === 'on';
    const { published, completeness } = await ConsultantProfile.setPublic(req.session.user.id, wantPublic);

    if (wantPublic && !published) {
      req.flash(
        'error',
        `Your profile is ${completeness}% complete. It needs ${ConsultantProfile.MIN_COMPLETENESS_TO_PUBLISH}% before it can be listed.`
      );
    } else {
      req.flash('success', published ? 'Your profile is now listed in the directory.' : 'Your profile is hidden from the directory.');
    }
    return res.redirect('/profile/consultant');
  })
);

router.post(
  '/consultant/photo',
  isConsultant,
  writeLimiter,
  singleImage('photo'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      req.flash('error', 'Please choose an image.');
      return res.redirect('/profile/consultant');
    }

    try {
      await ImageBlob.put('consultant_photos', req.session.user.id, req.file.buffer, { size: 512 });
      await ConsultantProfile.setProfilePicture(
        req.session.user.id,
        ImageBlob.pointerUrl('/consultants/photo', req.session.user.id)
      );
      req.flash('success', 'Photo updated.');
    } catch (err) {
      // A file that survived the MIME check but will not decode was never an image.
      req.flash('error', 'That file could not be read as an image.');
    }
    return res.redirect('/profile/consultant');
  })
);

router.post(
  '/consultant/certifications',
  isConsultant,
  writeLimiter,
  [body('name').trim().isLength({ min: 3, max: 180 })],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (errors.isEmpty()) {
      await ConsultantProfile.addCertification(req.session.user.id, {
        name: req.body.name.trim(),
        credentialId: req.body.credential_id || null,
        earnedOn: req.body.earned_on || null,
        expiresOn: req.body.expires_on || null
      });
      req.flash('success', 'Certification added.');
    } else {
      req.flash('error', 'Please choose a certification.');
    }
    return res.redirect('/profile/consultant');
  })
);

router.post(
  '/consultant/certifications/:id/delete',
  isConsultant,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    await ConsultantProfile.removeCertification(req.session.user.id, req.params.id);
    req.flash('success', 'Certification removed.');
    return res.redirect('/profile/consultant');
  })
);

router.post(
  '/consultant/experience',
  isConsultant,
  writeLimiter,
  [
    body('company').trim().isLength({ min: 2, max: 180 }),
    body('title').trim().isLength({ min: 2, max: 180 }),
    body('started_on').isISO8601()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', 'Please fill in the company, title and start date.');
      return res.redirect('/profile/consultant');
    }

    await ConsultantProfile.addExperience(req.session.user.id, {
      company: req.body.company.trim(),
      title: req.body.title.trim(),
      startedOn: req.body.started_on,
      endedOn: req.body.is_current === 'on' ? null : req.body.ended_on || null,
      isCurrent: req.body.is_current === 'on',
      description: sanitizeRichText(req.body.description || '')
    });
    req.flash('success', 'Experience added.');
    return res.redirect('/profile/consultant');
  })
);

router.post(
  '/consultant/experience/:id/delete',
  isConsultant,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    await ConsultantProfile.removeExperience(req.session.user.id, req.params.id);
    req.flash('success', 'Experience removed.');
    return res.redirect('/profile/consultant');
  })
);

router.get(
  '/company',
  isCompany,
  asyncHandler(async (req, res) => {
    const company = await CompanyProfile.ensureExists(req.session.user.id, req.session.user.name);
    res.render('profile/company', { title: 'Your company profile', company, countries, errors: [] });
  })
);

router.post(
  '/company',
  isCompany,
  writeLimiter,
  [body('company_name').trim().isLength({ min: 2, max: 200 }).withMessage('Please enter the company name.')],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect('/profile/company');
    }

    await CompanyProfile.update(req.session.user.id, {
      company_name: req.body.company_name.trim(),
      tagline: req.body.tagline || null,
      about: sanitizeRichText(req.body.about || ''),
      industry: req.body.industry || null,
      company_size: req.body.company_size || null,
      company_type: ['end_customer', 'consulting_partner', 'isv', 'staffing'].includes(req.body.company_type)
        ? req.body.company_type
        : 'end_customer',
      website: req.body.website || null,
      linkedin_url: req.body.linkedin_url || null,
      country: /^[A-Z]{2}$/.test(req.body.country || '') ? req.body.country : null,
      city: req.body.city || null,
      is_public: req.body.is_public === 'on' ? 1 : 0
    });

    req.flash('success', 'Company profile saved.');
    return res.redirect('/profile/company');
  })
);

router.post(
  '/company/logo',
  isCompany,
  writeLimiter,
  singleImage('logo'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      req.flash('error', 'Please choose an image.');
      return res.redirect('/profile/company');
    }
    try {
      await ImageBlob.put('company_logos', req.session.user.id, req.file.buffer, { size: 400 });
      await CompanyProfile.setLogo(req.session.user.id, ImageBlob.pointerUrl('/companies/logo', req.session.user.id));
      req.flash('success', 'Logo updated.');
    } catch (err) {
      req.flash('error', 'That file could not be read as an image.');
    }
    return res.redirect('/profile/company');
  })
);

module.exports = router;
