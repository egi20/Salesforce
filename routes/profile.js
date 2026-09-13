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
const { ALL_MODULES } = require('../config/cloudFamilies');
const { build: buildDossier } = require('../services/consultantDossier');
const ExternalIdentity = require('../models/ExternalIdentity');
const CompanyTemplate = require('../models/CompanyTemplate');
const {
  LETTERHEAD_FIELDS,
  CLAUSE_KINDS,
  MAX_CLAUSES_PER_KIND
} = require('../config/companyTemplates');
const {
  isDocumentKind,
  PACKAGE_KIND,
  generateDocument,
  generatePackage
} = require('../services/consultantPackage');

const router = express.Router();

router.use(isAuthenticated);

router.get('/', (req, res) => res.redirect('/profile/settings'));

router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.session.user.id);
    res.render('profile/settings', {
      title: 'Account settings',
      user,
      linkedInIdentity: await ExternalIdentity.find(ExternalIdentity.LINKEDIN, req.session.user.id),
      errors: []
    });
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
    const [skills, certifications, experiences, projects] = await Promise.all([
      Skill.forConsultant(userId),
      ConsultantProfile.listCertifications(userId),
      ConsultantProfile.listExperiences(userId),
      ConsultantProfile.listProjects(userId)
    ]);

    res.render('profile/consultant', {
      title: 'Your consultant profile',
      profile,
      skills,
      certifications,
      experiences,
      projects,
      allModules: ALL_MODULES,
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

/**
 * Delivery history.
 *
 * `consultant_projects` has been in the schema since migration 002 with nothing reading or
 * writing it — which meant the CV's most useful section was always empty. For a contractor
 * this is the substance of the document: which orgs, which clouds, what shipped. The
 * employer column matters far less, and through an agency it is often the same name on
 * every line.
 */
router.post(
  '/consultant/projects',
  isConsultant,
  writeLimiter,
  [
    body('name').trim().isLength({ min: 2, max: 200 }),
    body('client').optional({ checkFalsy: true }).trim().isLength({ max: 180 })
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', 'Give the engagement a name of at least two characters.');
      return res.redirect('/profile/consultant');
    }

    await ConsultantProfile.addProject(req.session.user.id, {
      name: req.body.name.trim(),
      client: (req.body.client || '').trim() || null,
      // Both are taxonomy slugs, checked against the catalogue rather than trusted: a
      // stored value that is not in `config/cloudFamilies.js` renders as a blank label.
      cloud: ALL_MODULES.some((m) => m.value === req.body.cloud) ? req.body.cloud : null,
      role: ROLE_SLUGS.includes(req.body.role) ? req.body.role : null,
      startedOn: req.body.started_on || null,
      endedOn: req.body.ended_on || null,
      description: sanitizeRichText(req.body.description || '')
    });

    req.flash('success', 'Engagement added. It will appear on your CV.');
    return res.redirect('/profile/consultant');
  })
);

router.post(
  '/consultant/projects/:id/delete',
  isConsultant,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    await ConsultantProfile.removeProject(req.session.user.id, req.params.id);
    req.flash('success', 'Engagement removed.');
    return res.redirect('/profile/consultant');
  })
);

/**
 * GET /profile/consultant/download/:kind — cv, rate-card, or the two zipped.
 *
 * Generated on demand and never stored, exactly as the quote documents are. Storing them
 * would create a second source of truth for a profile that changes, and the stale copy is
 * the one someone would eventually send.
 *
 * A generator that fails its own validity check produces a message to the author rather
 * than a served file: it can only mean a bug here, and a .docx that downloads fine and
 * then will not open is experienced as "you sent me a corrupt file".
 */
router.get(
  '/consultant/download/:kind',
  isConsultant,
  asyncHandler(async (req, res) => {
    const { kind } = req.params;
    if (kind !== PACKAGE_KIND && !isDocumentKind(kind)) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const dossier = await buildDossier(req.session.user.id);
    if (!dossier) {
      req.flash('error', 'Build your profile first — there is nothing to put in a document yet.');
      return res.redirect('/profile/consultant');
    }

    let result;
    try {
      result = kind === PACKAGE_KIND
        ? await generatePackage(dossier)
        : await generateDocument(dossier, kind);
    } catch (err) {
      if (err.code === 'DOCUMENT_MALFORMED') {
        req.flash('error', 'That document did not generate correctly and was not sent. Please report it.');
        return res.redirect('/profile/consultant');
      }
      throw err;
    }

    res.set('Content-Type', result.contentType);
    // The filename is built from a slugified name, so it cannot inject a header.
    res.set('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.set('Content-Length', String(result.buffer.length));
    // Somebody's CV is private and must not sit in a shared cache.
    res.set('Cache-Control', 'private, no-store');
    return res.send(result.buffer);
  })
);

/**
 * GET /profile/company/template — branding and standard wording.
 *
 * Nothing here uploads a document. A company supplies its colours, its letterhead and its
 * own clauses; the Hub's validated generators render with them. See
 * `config/companyTemplates.js` for what the alternative costs.
 */
router.get(
  '/company/template',
  isCompany,
  asyncHandler(async (req, res) => {
    const [template, clauses] = await Promise.all([
      CompanyTemplate.findByUserId(req.session.user.id),
      CompanyTemplate.clausesFor(req.session.user.id)
    ]);

    res.render('profile/template', {
      title: 'Document branding',
      template: template || {},
      clauses,
      letterheadFields: LETTERHEAD_FIELDS,
      clauseKinds: CLAUSE_KINDS,
      maxClauses: MAX_CLAUSES_PER_KIND
    });
  })
);

/**
 * A rejected colour is REPORTED with its measured ratio, never silently replaced: a
 * company that picked a colour and got a different one has been lied to about what it
 * configured.
 */
router.post(
  '/company/template',
  isCompany,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const result = await CompanyTemplate.save(req.session.user.id, req.body);
    if (!result.saved) {
      req.flash('error', result.reason);
    } else {
      req.flash('success', 'Saved. New documents will carry this.');
    }
    return res.redirect('/profile/company/template');
  })
);

router.post(
  '/company/template/clauses',
  isCompany,
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await CompanyTemplate.addClause(req.session.user.id, { kind: req.body.kind, body: req.body.body });
      req.flash('success', 'Clause added.');
    } catch (err) {
      if (!['UNKNOWN_KIND', 'TOO_SHORT', 'TOO_MANY'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect('/profile/company/template');
  })
);

router.post(
  '/company/template/clauses/:id/delete',
  isCompany,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    await CompanyTemplate.removeClause(req.session.user.id, req.params.id);
    req.flash('success', 'Clause removed.');
    return res.redirect('/profile/company/template');
  })
);

router.post(
  '/company/template/clauses/:id/move',
  isCompany,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    // Already at the end is not an error — a person pressing "up" on the first item has
    // not done anything wrong — so there is nothing to report either way.
    await CompanyTemplate.moveClause(req.session.user.id, req.params.id, req.body.direction === 'up' ? 'up' : 'down');
    return res.redirect('/profile/company/template');
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
