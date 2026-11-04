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
const { singleImage, singleCv, singleDocument } = require('../middleware/fileUpload');
const { extractText } = require('../utils/cvText');
const { importFromText } = require('../utils/cvImport');
const { requireIdParam } = require('../utils/ids');
const { sanitizeRichText } = require('../utils/sanitize');
const { ROLE_CATEGORIES, ROLE_SLUGS } = require('../config/roleTaxonomy');
const { CERTIFICATIONS } = require('../config/certifications');
const { AVAILABILITY, isValidAvailability } = require('../config/availability');
const countries = require('../config/all-countries.json');
const { ALL_MODULES, CLOUD_FAMILIES } = require('../config/cloudFamilies');
const { build: buildDossier } = require('../services/consultantDossier');
const ExternalIdentity = require('../models/ExternalIdentity');
const AccountErasure = require('../models/AccountErasure');
const ConsultantHiddenCompany = require('../models/ConsultantHiddenCompany');
const ConsultantDocument = require('../models/ConsultantDocument');
const { validateDocument, safeFilename, MAX_BYTES: DOCUMENT_MAX_BYTES } = require('../utils/documentUpload');
const { buildExport, filenameFor: exportFilename } = require('../services/dataExport');
const config = require('../config/config');
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

/* Trailhead's ranks, lowest first, as the form offers them. */
const TRAILHEAD_RANKS = Object.freeze([
  'Scout', 'Hiker', 'Explorer', 'Adventurer', 'Mountaineer', 'Expeditioner', 'Ranger',
  'Double Star Ranger', 'Triple Star Ranger', 'Four Star Ranger', 'Five Star Ranger', 'All Star Ranger'
]);

/* The profile page's tabs, so a save or an added row returns to the tab it came from. */
const PROFILE_TABS = Object.freeze(['basics', 'salesforce', 'work', 'projects', 'documents', 'privacy', 'account']);
function tabHash(tab) {
  return PROFILE_TABS.includes(tab) ? `#${tab}` : '';
}

/* A posted field that may be one value or several, as a list of strings. */
function listOf(value) {
  return (Array.isArray(value) ? value : value ? [value] : []).map(String);
}

/* Parallel posted arrays (name[], level[]) zipped into rows, capped. */
function rowsOf(bodyIn, keys) {
  const columns = keys.map((k) => listOf(bodyIn[k]));
  const length = Math.min(Math.max(0, ...columns.map((c) => c.length)), 50);
  return Array.from({ length }, (_, i) => columns.map((c) => c[i]));
}

function httpsUrlOrNull(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString().slice(0, 255) : null;
  } catch {
    return null;
  }
}

router.use(isAuthenticated);

router.get('/', (req, res) => res.redirect('/profile/settings'));

router.get(
  '/settings',
  asyncHandler(async (req, res) => (req.session.user.isConsultant ? renderProfilePage(req, res) : renderAccountOnly(req, res)))
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

    // Adding the consultant role opens the profile form on this same page, at Basics.
    // validateActiveAccount rebuilds the session's role flags on the next request.
    if (roles.includes('consultant') && !req.session.user.isConsultant) {
      req.flash('success', 'Your consultant profile is ready. Start with the basics — you can save as you go.');
      return res.redirect('/profile/settings#basics');
    }
    req.flash('success', 'Roles updated. Removing a role is done by support.');
    return res.redirect('/profile/settings#account');
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

/*
 * ONE PAGE for "Build your profile" and the account settings.
 *
 * /profile/settings is the page; /profile/consultant redirects to it, so there are never two
 * URLs for one thing. A consultant sees every section with Account last; an account without
 * the consultant role sees only Account, opened at its roles, with the way to add one.
 */
async function renderProfilePage(req, res) {
    const userId = req.session.user.id;
    const [user, linkedInIdentity] = await Promise.all([
      User.findById(userId),
      ExternalIdentity.find(ExternalIdentity.LINKEDIN, userId)
    ]);
    const profile = await ConsultantProfile.ensureExists(userId);
    const [skills, certifications, experiences, projects, clouds, languages, workCountries, hiddenCompanies, documents] = await Promise.all([
      Skill.forConsultant(userId),
      ConsultantProfile.listCertifications(userId),
      ConsultantProfile.listExperiences(userId),
      ConsultantProfile.listProjects(userId),
      ConsultantProfile.listClouds(userId),
      ConsultantProfile.listLanguages(userId),
      ConsultantProfile.listWorkCountries(userId),
      ConsultantHiddenCompany.listFor(userId),
      ConsultantDocument.listFor(userId)
    ]);

    const counts = { skillCount: skills.length, certificationCount: certifications.length, experienceCount: experiences.length };
    /*
     * Which sections are done, for the ✓ on each tab. A judgement about what a reader of the
     * profile needs from that section, not a second completeness score: the percentage is
     * still `completenessOf`, and listing is still `listingProblems`.
     */
    const sectionsDone = {
      basics: Boolean(profile.headline && profile.bio && profile.primary_role && profile.country),
      salesforce: clouds.length >= 1 && skills.length >= 3,
      work: Boolean((profile.day_rate || profile.annual_salary) && (profile.open_to_contract || profile.open_to_permanent)),
      privacy: Boolean(profile.is_public),
      projects: projects.length >= 1 || experiences.length >= 1,
      documents: documents.length >= 1,
      account: false
    };

    res.render('profile/consultant', {
      title: 'Build your profile',
      consultantMode: true,
      user,
      linkedInIdentity,
      availabilityOptions: AVAILABILITY,
      profile,
      skills,
      certifications,
      experiences,
      projects,
      clouds,
      languages,
      workCountries,
      hiddenCompanyCount: hiddenCompanies.length,
      documents,
      documentMaxMb: DOCUMENT_MAX_BYTES / 1024 / 1024,
      cloudFamilies: CLOUD_FAMILIES,
      languageLevels: ConsultantProfile.LANGUAGE_LEVELS,
      skillLevels: ConsultantProfile.SKILL_LEVELS,
      trailheadRanks: TRAILHEAD_RANKS,
      nextSteps: ConsultantProfile.nextSteps(profile, counts),
      listingProblems: ConsultantProfile.listingProblems(profile, { cloudCount: clouds.length }),
      sectionsDone,
      allModules: ALL_MODULES,
      roleCategories: ROLE_CATEGORIES,
      certificationGroups: CERTIFICATIONS,
      countries,
      minCompleteness: ConsultantProfile.MIN_COMPLETENESS_TO_PUBLISH,
      errors: []
    });
}

async function renderAccountOnly(req, res) {
  const userId = req.session.user.id;
  const [user, linkedInIdentity] = await Promise.all([
    User.findById(userId),
    ExternalIdentity.find(ExternalIdentity.LINKEDIN, userId)
  ]);
  res.render('profile/consultant', {
    title: 'Your account',
    consultantMode: false,
    user,
    linkedInIdentity,
    errors: []
  });
}

router.get('/consultant', (req, res) => res.redirect('/profile/settings'));

router.post(
  '/consultant',
  isConsultant,
  writeLimiter,
  [
    body('headline').optional({ checkFalsy: true }).isLength({ max: 200 }),
    body('primary_role').optional({ checkFalsy: true }).isIn(ROLE_SLUGS),
    // The spec's range for a day rate. Outside it is almost always a typo (an annual figure,
    // a missing digit), and a rate is the one number on a profile a company acts on.
    body('day_rate').optional({ checkFalsy: true }).isFloat({ min: 200, max: 3000 }).withMessage('Enter a day rate between 200 and 3,000.'),
    body('bio').optional({ checkFalsy: true }).isLength({ max: 1000 }).withMessage('Keep the bio to 1,000 characters.'),
    body('hourly_rate').optional({ checkFalsy: true }).isFloat({ min: 0, max: 10000 }),
    body('annual_salary').optional({ checkFalsy: true }).isFloat({ min: 0, max: 10000000 }),
    body('years_experience').optional({ checkFalsy: true }).isInt({ min: 0, max: 60 }),
    body('given_name').optional({ checkFalsy: true }).isLength({ max: 100 }),
    body('family_name').optional({ checkFalsy: true }).isLength({ max: 100 }),
    body('phone').optional({ checkFalsy: true }).isLength({ max: 40 }),
    body('trailhead_badges').optional({ checkFalsy: true }).isInt({ min: 0, max: 10000 }),
    body('trailhead_rank').optional({ checkFalsy: true }).isIn(TRAILHEAD_RANKS)
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg || 'Please check the form.');
      return res.redirect('/profile/settings');
    }
    const userId = req.session.user.id;

    if (req.body.given_name || req.body.family_name) {
      await User.updateName(req.session.user.id, `${req.body.given_name || ''} ${req.body.family_name || ''}`);
    }

    await ConsultantProfile.update(req.session.user.id, {
      headline: req.body.headline || null,
      bio: sanitizeRichText(req.body.bio || ''),
      primary_role: req.body.primary_role || null,
      seniority: req.body.seniority || null,
      years_experience: req.body.years_experience || null,
      country: /^[A-Z]{2}$/.test(req.body.country || '') ? req.body.country : null,
      city: req.body.city || null,
      phone: req.body.phone || null,
      work_mode: req.body.work_mode || 'remote',
      willing_to_travel: req.body.willing_to_travel === 'on' ? 1 : 0,
      day_rate: req.body.day_rate || null,
      // Stored as typed, never derived from each other. An hourly rate is not a day rate
      // divided by eight — the divisor is a contract term, not a constant — and a salary
      // is a different engagement, not a converted rate.
      hourly_rate: req.body.hourly_rate || null,
      annual_salary: req.body.annual_salary || null,
      currency: /^[A-Z]{3}$/.test(req.body.currency || '') ? req.body.currency : 'EUR',
      // An unticked checkbox posts nothing, so absence is "hide it" — which is the safe
      // direction for a figure. Read as a named field, like `willing_to_travel` above.
      rate_visible: req.body.rate_visible === 'on' ? 1 : 0,
      availability: isValidAvailability(req.body.availability) ? req.body.availability : 'not_available',
      available_from: req.body.available_from || null,
      linkedin_url: req.body.linkedin_url || null,
      website_url: req.body.website_url || null,
      trailblazer_url: req.body.trailblazer_url || null,
      // Named checkboxes: an unticked one posts nothing, so absence is "no".
      open_to_contract: req.body.open_to_contract === 'on' ? 1 : 0,
      open_to_permanent: req.body.open_to_permanent === 'on' ? 1 : 0,
      trailhead_rank: req.body.trailhead_rank || null,
      trailhead_badges: req.body.trailhead_badges === '' || req.body.trailhead_badges === undefined ? null : Number(req.body.trailhead_badges)
    });

    // The three lists replace themselves wholesale; the model validates every element.
    await Promise.all([
      ConsultantProfile.setClouds(userId, listOf(req.body.clouds)),
      ConsultantProfile.setWorkCountries(userId, listOf(req.body.work_countries)),
      ConsultantProfile.setLanguages(userId, rowsOf(req.body, ['language_name', 'language_level'])
        .map(([language, level]) => ({ language, level })))
    ]);

    /*
     * Skills arrive as rows (name, level, years). The comma-separated `skills` field is still
     * read when it is all that arrived, so a form posted without the row markup — or an older
     * page left open in a tab — does not wipe somebody's skills.
     */
    let skillRows = rowsOf(req.body, ['skill_name', 'skill_level', 'skill_years'])
      .map(([name, level, years]) => ({ name: String(name || '').trim().slice(0, 80), level, years }))
      .filter((r) => r.name);
    if (skillRows.length === 0 && typeof req.body.skills === 'string') {
      skillRows = req.body.skills.split(',').map((n) => ({ name: n.trim().slice(0, 80), level: 'proficient', years: null })).filter((r) => r.name);
    }
    /*
     * The same skill twice keeps the LAST row — the one somebody just typed. The table's key
     * is (user, skill) and the insert ignores duplicates, so without this the older row won
     * and a level or years entered on the new line vanished without a word.
     */
    const lastByName = new Map();
    for (const r of skillRows) lastByName.set(r.name.toLowerCase(), r);
    skillRows = [...lastByName.values()].slice(0, 40);
    const skillRecords = await Skill.findOrCreateMany(skillRows.map((r) => r.name));
    const idByName = new Map(skillRecords.map((sk) => [sk.name.toLowerCase(), sk.id]));
    await Skill.setDetailedForConsultant(userId, skillRows
      .map((r) => ({ skillId: idByName.get(r.name.toLowerCase()), level: r.level, years: r.years }))
      .filter((r) => r.skillId));
    await ConsultantProfile.recomputeCompleteness(userId);

    /*
     * Saved whatever is missing — a profile is filled in over several sittings — and then
     * told plainly what a complete one still needs. Blocking the save would lose what was
     * typed to make a point about what was not.
     */
    const missing = [];
    if (listOf(req.body.clouds).length === 0) missing.push('at least one cloud');
    if (req.body.open_to_contract !== 'on' && req.body.open_to_permanent !== 'on') missing.push('contract and/or permanent');
    if (req.body.open_to_contract === 'on' && !req.body.day_rate) missing.push('a day rate, for contract work');
    if (req.body.open_to_permanent === 'on' && !req.body.annual_salary) missing.push('an annual salary, for permanent roles');
    req.flash('success', 'Profile saved.');
    if (missing.length) req.flash('info', `Still needed for a complete profile: ${missing.join(', ')}.`);
    return res.redirect(`/profile/settings${tabHash(req.body.tab)}`);
  })
);

router.post(
  '/consultant/visibility',
  isConsultant,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const wantPublic = req.body.is_public === 'on';
    const { published, completeness, adminHidden, problems } = await ConsultantProfile.setPublic(req.session.user.id, wantPublic);

    if (wantPublic && adminHidden) {
      // Said plainly: a Publish that silently did nothing is worse than a refusal.
      req.flash('error', 'An administrator has taken your profile out of the directory, so it cannot be listed. Use Report an issue if you think that is a mistake.');
    } else if (wantPublic && !published) {
      const missing = problems && problems.length ? problems : [`reach ${ConsultantProfile.MIN_COMPLETENESS_TO_PUBLISH}% complete`];
      req.flash('error', `Your profile is ${completeness}% complete. To list it in Browse Talent, ${missing.join(', ')}.`);
    } else {
      req.flash('success', published ? 'Your profile is now listed in the directory.' : 'Your profile is hidden from the directory.');
    }
    return res.redirect('/profile/settings#privacy');
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
      return res.redirect('/profile/settings#basics');
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
    return res.redirect('/profile/settings#basics');
  })
);

router.post(
  '/consultant/photo/remove',
  isConsultant,
  writeLimiter,
  asyncHandler(async (req, res) => {
    await ImageBlob.remove('consultant_photos', req.session.user.id);
    await ConsultantProfile.setProfilePicture(req.session.user.id, null);
    req.flash('success', 'Photo removed.');
    return res.redirect('/profile/settings#basics');
  })
);

/**
 * "Import from CV": reads the upload, extracts plain text, hands it to the model, and
 * returns the fields as JSON — it never writes to the profile itself. The browser fills
 * the form with what comes back and the consultant saves (or edits, or discards) exactly
 * like any other change on this page. Errors are JSON with a 4xx/5xx, since the caller is
 * a fetch() from the page, not a full-page form post.
 */
router.post(
  '/consultant/import-cv',
  isConsultant,
  writeLimiter,
  singleCv('cv'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Please choose a .docx or .txt file.' });
    }

    let text;
    try {
      text = extractText(req.file.buffer, req.file.mimetype);
    } catch (err) {
      return res.status(400).json({ success: false, error: 'That file could not be read.' });
    }

    const result = await importFromText(text, { userId: req.session.user.id });
    if (!result.ok) {
      return res.status(422).json({ success: false, error: result.reason });
    }
    return res.json({ success: true, fields: result.fields });
  })
);

/**
 * The second half of "Import from CV": the projects and experience the consultant TICKED in
 * the review panel. The import route itself never writes; this is the confirmation. Each
 * entry goes through the same shaping as a hand-typed one, so an imported row can hold
 * nothing a typed row could not.
 */
const IMPORT_DATE = /^\d{4}-\d{2}-\d{2}$/;
function importedEntries(list, max) {
  return (Array.isArray(list) ? list : []).slice(0, max)
    .filter((e) => e && typeof e === 'object' && !Array.isArray(e))
    .map((e) => {
      const flat = {};
      for (const key of ['name', 'client', 'company', 'title', 'location', 'description']) {
        if (typeof e[key] === 'string') flat[key] = e[key];
      }
      flat.started_on = IMPORT_DATE.test(e.started_on) ? e.started_on : null;
      flat.ended_on = IMPORT_DATE.test(e.ended_on) ? e.ended_on : null;
      flat.is_current = e.is_current === true ? 'on' : '';
      return flat;
    });
}

router.post(
  '/consultant/import-entries',
  isConsultant,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const userId = req.session.user.id;
    const projects = importedEntries(req.body && req.body.projects, 12).map(projectFrom).filter((p) => p.name);
    const experience = importedEntries(req.body && req.body.experience, 12).map(experienceFrom)
      .filter((e) => e.company && e.startedOn);
    // Sequential on purpose: each insert takes the next sort_order, so they keep the CV's order.
    /* eslint-disable no-await-in-loop */
    for (const p of projects) await ConsultantProfile.addProject(userId, p);
    for (const e of experience) await ConsultantProfile.addExperience(userId, e);
    /* eslint-enable no-await-in-loop */
    return res.json({ success: true, projects: projects.length, experience: experience.length });
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
        // A credential link must be a web address; anything else is dropped, not stored.
        credentialUrl: httpsUrlOrNull(req.body.credential_url),
        earnedOn: req.body.earned_on || null,
        expiresOn: req.body.expires_on || null
      });
      req.flash('success', 'Certification added.');
    } else {
      req.flash('error', 'Please choose a certification.');
    }
    return res.redirect('/profile/settings#salesforce');
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
    return res.redirect('/profile/settings#salesforce');
  })
);

router.post(
  '/consultant/experience',
  isConsultant,
  writeLimiter,
  [
    body('company').trim().isLength({ min: 2, max: 180 }),
    body('title').optional({ checkFalsy: true }).trim().isLength({ max: 180 }),
    body('started_on').isISO8601()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', 'Please fill in the company and the start date.');
      return res.redirect('/profile/settings#projects');
    }

    await ConsultantProfile.addExperience(req.session.user.id, {
      company: req.body.company.trim(),
      title: (req.body.title || '').trim(),
      location: (req.body.location || '').trim().slice(0, 120) || null,
      startedOn: req.body.started_on,
      endedOn: req.body.is_current === 'on' ? null : req.body.ended_on || null,
      isCurrent: req.body.is_current === 'on',
      description: sanitizeRichText(req.body.description || '')
    });
    req.flash('success', 'Experience added.');
    return res.redirect('/profile/settings#projects');
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
    return res.redirect('/profile/settings#projects');
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
      return res.redirect('/profile/settings#projects');
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
      isCurrent: req.body.is_current === 'on',
      description: sanitizeRichText(req.body.description || '')
    });

    req.flash('success', 'Engagement added. It will appear on your CV.');
    return res.redirect('/profile/settings#projects');
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
    return res.redirect('/profile/settings#projects');
  })
);

/* ----------------------------------------------- editing and ordering projects and experience */

/** The fields of a project or experience form, shaped the same way Add shapes them. */
function projectFrom(b) {
  return {
    name: String(b.name || '').trim().slice(0, 200),
    client: String(b.client || '').trim().slice(0, 180) || null,
    cloud: ALL_MODULES.some((m) => m.value === b.cloud) ? b.cloud : null,
    role: ROLE_SLUGS.includes(b.role) ? b.role : null,
    startedOn: b.started_on || null,
    endedOn: b.ended_on || null,
    isCurrent: b.is_current === 'on',
    description: sanitizeRichText(b.description || '')
  };
}

function experienceFrom(b) {
  return {
    company: String(b.company || '').trim().slice(0, 180),
    title: String(b.title || '').trim().slice(0, 180),
    location: String(b.location || '').trim().slice(0, 120) || null,
    startedOn: b.started_on,
    endedOn: b.ended_on || null,
    isCurrent: b.is_current === 'on',
    description: sanitizeRichText(b.description || '')
  };
}

// Declared before `/:id` so "order" is never read as an id.
for (const kind of ['projects', 'experience']) {
  router.post(
    `/consultant/${kind}/order`,
    isConsultant,
    writeLimiter,
    asyncHandler(async (req, res) => {
      const ok = await ConsultantProfile.setEntryOrder(kind, req.session.user.id, listOf(req.body.ids));
      return res.status(ok ? 200 : 409).json({ success: ok });
    })
  );

  router.post(
    `/consultant/${kind}/:id/move`,
    isConsultant,
    requireIdParam('id'),
    writeLimiter,
    asyncHandler(async (req, res) => {
      await ConsultantProfile.moveEntry(kind, req.session.user.id, req.params.id, req.body.direction === 'up' ? 'up' : 'down');
      return res.redirect('/profile/settings#projects');
    })
  );
}

router.post(
  '/consultant/projects/:id',
  isConsultant,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const project = projectFrom(req.body);
    if (project.name.length < 2) {
      req.flash('error', 'A project needs a name.');
    } else {
      const ok = await ConsultantProfile.updateProject(req.session.user.id, req.params.id, project);
      req.flash(ok ? 'success' : 'error', ok ? 'Project updated.' : 'Nothing to update.');
    }
    return res.redirect('/profile/settings#projects');
  })
);

router.post(
  '/consultant/experience/:id',
  isConsultant,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const exp = experienceFrom(req.body);
    if (exp.company.length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(exp.startedOn || '')) {
      req.flash('error', 'Experience needs a company and a start date.');
    } else {
      const ok = await ConsultantProfile.updateExperience(req.session.user.id, req.params.id, exp);
      req.flash(ok ? 'success' : 'error', ok ? 'Experience updated.' : 'Nothing to update.');
    }
    return res.redirect('/profile/settings#projects');
  })
);

/* ------------------------------------------------------------ uploaded CVs and cover letters */

router.post(
  '/consultant/documents',
  isConsultant,
  writeLimiter,
  singleDocument('document'),
  asyncHandler(async (req, res) => {
    if (req.uploadError || !req.file) {
      req.flash('error', req.uploadError || 'Please choose a file.');
      return res.redirect('/profile/settings#documents');
    }
    const check = validateDocument(req.file);
    if (!check.ok) {
      req.flash('error', check.reason);
      return res.redirect('/profile/settings#documents');
    }
    const result = await ConsultantDocument.add(req.session.user.id, {
      kind: req.body.kind,
      title: String(req.body.title || '').trim().slice(0, 120) || null,
      filename: req.file.originalname,
      contentType: check.contentType,
      bytes: req.file.buffer,
      isDefault: req.body.is_default === 'on'
    });
    req.flash(result.ok ? 'success' : 'error', result.ok ? 'Document uploaded.' : result.reason);
    return res.redirect('/profile/settings#documents');
  })
);

/*
 * The owner's own file, back to the owner. Always an attachment and never rendered inline,
 * with nosniff and no caching: whatever the validator could not see inside a PDF stays a
 * download, not a page on this origin.
 */
router.get(
  '/consultant/documents/:id/download',
  isConsultant,
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const doc = await ConsultantDocument.findForOwner(req.session.user.id, req.params.id);
    if (!doc) return res.status(404).render('errors/404', { title: 'Not found' });
    res.set({
      'Content-Type': doc.content_type,
      'Content-Disposition': `attachment; filename="${safeFilename(doc.title || doc.filename, doc.content_type)}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store'
    });
    return res.send(doc.bytes);
  })
);

router.post(
  '/consultant/documents/:id/default',
  isConsultant,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const ok = await ConsultantDocument.setDefault(req.session.user.id, req.params.id);
    req.flash(ok ? 'success' : 'error', ok ? 'Default updated.' : 'Nothing to update.');
    return res.redirect('/profile/settings#documents');
  })
);

router.post(
  '/consultant/documents/:id/delete',
  isConsultant,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const ok = await ConsultantDocument.remove(req.session.user.id, req.params.id);
    req.flash(ok ? 'success' : 'error', ok ? 'Document deleted.' : 'Nothing to delete.');
    return res.redirect('/profile/settings#documents');
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
      return res.redirect('/profile/settings');
    }

    let result;
    try {
      result = kind === PACKAGE_KIND
        ? await generatePackage(dossier)
        : await generateDocument(dossier, kind);
    } catch (err) {
      if (err.code === 'DOCUMENT_MALFORMED') {
        req.flash('error', 'That document did not generate correctly and was not sent. Please report it.');
        return res.redirect('/profile/settings');
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

/* --------------------------------------------------- hiding from named companies */

/**
 * "Hide my profile from these companies."
 *
 * For the consultant looking for their next contract while still in their current one. The
 * page is careful about what it promises: see `models/ConsultantHiddenCompany.js` on why a
 * signed-out visitor cannot be filtered, and why saying so plainly is the difference between
 * a privacy feature and a false one.
 */
router.get(
  '/hidden-companies',
  isAuthenticated,
  isConsultant,
  asyncHandler(async (req, res) => {
    const [blocks, companies] = await Promise.all([
      ConsultantHiddenCompany.listFor(req.session.user.id),
      CompanyProfile.browse({}, { limit: 500, offset: 0 })
    ]);

    res.render('profile/hiddenCompanies', {
      title: 'Hide from companies',
      blocks,
      companies: companies.rows,
      maxBlocks: ConsultantHiddenCompany.MAX_BLOCKS
    });
  })
);

router.post(
  '/hidden-companies',
  isAuthenticated,
  isConsultant,
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { kind } = await ConsultantHiddenCompany.add(req.session.user.id, {
        companyUserId: req.body.company_user_id,
        companyName: req.body.company_name
      });
      req.flash(
        'success',
        kind === 'registered'
          ? 'Hidden. That company will not see your profile while they are signed in.'
          : 'Saved. If that employer signs up under this name, your profile will be hidden from them.'
      );
    } catch (err) {
      if (!['TOO_MANY', 'SELF', 'NOT_FOUND', 'NAME_REQUIRED'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect('/profile/hidden-companies');
  })
);

router.post(
  '/hidden-companies/:id/remove',
  isAuthenticated,
  isConsultant,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    // Scoped to the owner inside the model, so an id from somebody else's list removes
    // nothing rather than removing their block.
    const removed = await ConsultantHiddenCompany.remove(req.session.user.id, req.params.id);
    req.flash(removed ? 'success' : 'error', removed ? 'Removed. That company can see your profile again.' : 'Nothing to remove.');
    return res.redirect('/profile/hidden-companies');
  })
);

/* ------------------------------------------------- your data, and getting rid of it */

/**
 * The two rights the privacy policy has to be able to honour.
 *
 * Before this existed the policy said "ask us and your account and its data are removed"
 * and there was no route, no form and no address to ask at. A promise a system cannot keep
 * is worse than one it does not make: it is the sentence somebody relies on.
 */

/**
 * Article 15 and Article 20 in one file: see everything, and take it elsewhere.
 *
 * Rate-limited like any other write even though it reads, because it is an expensive query
 * fan-out behind a session and there is no reason to let it be held open in a loop.
 */
router.get(
  '/data',
  isAuthenticated,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const data = await buildExport(req.session.user.id);

    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${exportFilename(config.app.name)}"`);
    // Generated on demand and never stored. A second copy of somebody's personal data,
    // sitting on disk waiting to be asked for, is the thing the feature exists to reduce.
    return res.send(JSON.stringify(data, null, 2));
  })
);

router.get(
  '/close',
  isAuthenticated,
  asyncHandler(async (req, res) => {
    res.render('profile/close', {
      title: 'Close your account',
      retained: AccountErasure.RETAINED,
      purged: AccountErasure.PURGE
    });
  })
);

/**
 * Erasure. Irreversible, and confirmed by TYPING rather than by clicking.
 *
 * A checkbox next to a red button is dismissed by muscle memory; an account somebody erased
 * by accident cannot be handed back, because the point of the feature is that the data is
 * gone. The typed word is the one interaction that cannot happen without reading.
 */
router.post(
  '/close',
  isAuthenticated,
  writeLimiter,
  asyncHandler(async (req, res) => {
    if (String(req.body.confirm || '').trim().toUpperCase() !== 'ERASE') {
      req.flash('error', 'Type ERASE to confirm. Nothing has been changed.');
      return res.redirect('/profile/close');
    }

    try {
      await AccountErasure.erase(req.session.user.id, { reason: 'self-service' });
    } catch (err) {
      if (!['NOT_FOUND', 'ALREADY_ERASED', 'SUPERADMIN'].includes(err.code)) throw err;
      req.flash('error', err.message);
      return res.redirect('/profile/close');
    }

    // Destroy the session rather than clearing a field on it: `validateActiveAccount`
    // rebuilds req.session.user from the database on every request, and the row it would
    // rebuild from no longer describes anybody.
    return req.session.destroy(() => {
      res.clearCookie('connect.sid');
      return res.redirect('/?erased=1');
    });
  })
);

module.exports = router;
