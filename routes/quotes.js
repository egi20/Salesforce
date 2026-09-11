'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const Quote = require('../models/Quote');
const { isAuthenticated, isEmailVerified } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { calculateEstimation, reconciliationProblems } = require('../utils/sowEstimation');
const {
  ISV_SOLUTIONS,
  COMPLEXITY_MULTIPLIERS,
  CUSTOMIZATION_MULTIPLIERS,
  INDUSTRY_MULTIPLIERS,
  COMPANY_SIZE_MULTIPLIERS,
  catalogueVersion
} = require('../config/estimation');
const { CLOUD_FAMILIES, isValidFamily, isValidModule } = require('../config/cloudFamilies');
const { sanitizeRichText } = require('../utils/sanitize');
const { returnTo } = require('../utils/returnTo');
const { isDocumentKind, PACKAGE_KIND, generateDocument, generatePackage } = require('../services/quotePackage');
const CompanyProfile = require('../models/CompanyProfile');
const QuoteDraft = require('../models/QuoteDraft');
const drafting = require('../config/drafting');
const { draftSection, isConfigured: draftingConfigured } = require('../utils/quoteDrafting');
const { requireIdParam } = require('../utils/ids');
const { FORBIDDEN_TERMS } = require('../utils/draftVerification');
const Payment = require('../models/Payment');
const {
  depositForTotal,
  formatMinor,
  DEPOSIT_PERCENT,
  DEPOSIT_MIN_MINOR,
  DEPOSIT_MAX_MINOR
} = require('../config/payments');

const router = express.Router();

router.use(isAuthenticated);

const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'];

/** Everything the wizard and the result page need to render their option lists. */
function catalogueLocals() {
  return {
    cloudFamilies: CLOUD_FAMILIES,
    isvSolutions: Object.entries(ISV_SOLUTIONS).map(([id, isv]) => ({ id, ...isv })),
    complexityOptions: Object.entries(COMPLEXITY_MULTIPLIERS).map(([id, c]) => ({ id, ...c })),
    customizationOptions: Object.entries(CUSTOMIZATION_MULTIPLIERS).map(([id, c]) => ({ id, ...c })),
    industryOptions: Object.keys(INDUSTRY_MULTIPLIERS),
    companySizeOptions: Object.keys(COMPANY_SIZE_MULTIPLIERS)
  };
}

/**
 * Read the wizard form into the estimator's input shape.
 *
 * Everything the client can send is filtered against the catalogue here, so an unknown
 * slug is dropped rather than silently costed at a default. Free text survives as free
 * text and is costed explicitly as unmapped scope.
 */
function inputsFrom(form) {
  const asArray = (value) => (Array.isArray(value) ? value : [value].filter(Boolean));

  return {
    selectedFamilies: asArray(form.families).filter(isValidFamily),
    selectedModules: asArray(form.modules).filter(isValidModule),
    selectedIsvs: asArray(form.isvs).filter((id) => Object.prototype.hasOwnProperty.call(ISV_SOLUTIONS, id)),
    complexity: COMPLEXITY_MULTIPLIERS[form.complexity] ? form.complexity : 'moderate',
    customizationLevel: CUSTOMIZATION_MULTIPLIERS[form.customization_level] ? form.customization_level : 'medium',
    clientIndustry: INDUSTRY_MULTIPLIERS[form.client_industry] ? form.client_industry : '',
    companySize: COMPANY_SIZE_MULTIPLIERS[form.company_size] ? form.company_size : '',
    numberOfUsers: form.number_of_users,
    numberOfOrgs: form.number_of_orgs,
    numberOfIntegrations: form.number_of_integrations,
    integrationComplexity: ['simple', 'medium', 'complex'].includes(form.integration_complexity)
      ? form.integration_complexity
      : 'medium',
    includeTraining: form.include_training === 'on',
    includeSupport: form.include_support === 'on',
    supportDurationDays: Math.max(0, Math.min(365, parseInt(form.support_duration_days, 10) || 0)),
    otherModules: String(form.other_modules || '').slice(0, 1000),
    otherIsvs: String(form.other_isvs || '').slice(0, 1000),
    otherIntegrations: String(form.other_integrations || '').slice(0, 1000)
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = QUOTE_STATUSES.includes(req.query.status) ? req.query.status : '';
    const { page, perPage, limit, offset } = paginationFrom(req.query);

    const [{ rows, total }, stats] = await Promise.all([
      Quote.listForOwner(req.session.user.id, { status, limit, offset }),
      Quote.statsForOwner(req.session.user.id)
    ]);

    res.render('quotes/index', {
      title: 'Quotes',
      quotes: rows,
      stats,
      status,
      statuses: QUOTE_STATUSES,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/quotes', req.query, p)
    });
  })
);

// Declared before `/:reference` so "new" is never read as a quote reference.
router.get(
  '/new',
  isEmailVerified,
  asyncHandler(async (req, res) => {
    // Pre-fill nothing from the authoring company: the client is the subject of the quote,
    // and defaulting their name to the author's own company is a confusing wrong answer.

    res.render('quotes/new', {
      title: 'New estimate',
      ...catalogueLocals(),
      values: { include_training: 'on', include_support: 'on', support_duration_days: 30, number_of_users: 50, number_of_orgs: 1 },
      errors: []
    });
  })
);

const quoteValidators = [
  body('client_company').trim().isLength({ min: 2, max: 200 }).withMessage('Who is this estimate for? Enter the client company.'),
  body('client_name').trim().isLength({ min: 2, max: 200 }).withMessage('Enter a contact name.'),
  body('client_email').optional({ checkFalsy: true }).isEmail().withMessage('That contact email is not valid.'),
  body('project_name').trim().isLength({ min: 3, max: 200 }).withMessage('Give the project a name.'),
  body('number_of_users').optional({ checkFalsy: true }).isInt({ min: 1, max: 1000000 }),
  body('number_of_orgs').optional({ checkFalsy: true }).isInt({ min: 1, max: 50 }),
  body('number_of_integrations').optional({ checkFalsy: true }).isInt({ min: 0, max: 200 })
];

router.post(
  '/',
  isEmailVerified,
  writeLimiter,
  quoteValidators,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);

    const inputs = inputsFrom(req.body);
    const nothingSelected =
      inputs.selectedFamilies.length === 0 &&
      inputs.selectedModules.length === 0 &&
      inputs.selectedIsvs.length === 0 &&
      !inputs.otherModules.trim();

    const problems = errors.array();
    if (nothingSelected) {
      problems.push({ msg: 'Choose at least one cloud, module or add-on — an estimate needs a scope.' });
    }

    if (problems.length) {
      return res.status(422).render('quotes/new', {
        title: 'New estimate',
        ...catalogueLocals(),
        values: req.body,
        errors: problems
      });
    }

    const estimate = calculateEstimation(inputs, {
      contingencyPercentage: Math.max(0, Math.min(50, parseInt(req.body.contingency_percentage, 10) || 15)),
      currency: /^[A-Z]{3}$/.test(req.body.currency || '') ? req.body.currency : 'EUR'
    });

    // An estimate whose own parts do not add up must never be shown to a client. This is
    // the guard that makes the invariants in utils/sowEstimation.js real rather than
    // aspirational: a failure here is a bug in the engine, not user error.
    const mismatches = reconciliationProblems(estimate);
    if (mismatches.length) {
      const err = new Error(`Estimate failed its own reconciliation checks: ${mismatches.join('; ')}`);
      err.status = 500;
      throw err;
    }

    const quote = await Quote.create(req.session.user.id, {
      client: {
        name: req.body.client_name.trim(),
        company: req.body.client_company.trim(),
        email: req.body.client_email || null,
        industry: inputs.clientIndustry || null,
        size: inputs.companySize || null
      },
      project: {
        name: req.body.project_name.trim(),
        summary: sanitizeRichText(req.body.project_summary || '')
      },
      inputs,
      estimate,
      catalogueVersion: catalogueVersion()
    });

    req.flash('success', `Estimate ${quote.reference} saved.`);
    return res.redirect(`/quotes/${quote.reference}`);
  })
);

/**
 * Produce a deliverable from a stored quote.
 *
 * Documents are generated on demand rather than stored, because storing them would mean
 * two sources of truth for the same figures. Each generator validates its own output
 * before returning it, so a file that cannot be opened never reaches the response.
 */
router.get(
  '/:reference/download/:kind',
  isEmailVerified,
  asyncHandler(async (req, res) => {
    const quote = await Quote.findByReference(req.params.reference);
    if (!quote || quote.owner_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const kind = req.params.kind;
    if (kind !== PACKAGE_KIND && !isDocumentKind(kind)) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    // The company name on the cover is the AUTHOR's, not the client's: the document is
    // issued by whoever produced it.
    const company = req.session.user.isCompany ? await CompanyProfile.findByUserId(req.session.user.id) : null;
    const options = { preparedBy: company ? company.company_name : req.session.user.name };

    let result;
    try {
      result = kind === PACKAGE_KIND ? await generatePackage(quote, options) : await generateDocument(quote, kind, options);
    } catch (err) {
      // A document that failed its own validity check is an engine bug, not user error,
      // and the author gets told rather than handed a file that will not open.
      if (err.code === 'DOCUMENT_MALFORMED') {
        console.error(`Document generation rejected for ${quote.reference}: ${err.message}`);
        req.flash('error', 'That document could not be produced correctly and was not sent. This has been logged.');
        return res.redirect(`/quotes/${quote.reference}`);
      }
      throw err;
    }

    Quote.recordDownload(quote.id, req.session.user.id, kind, quote.catalogue_version, result.buffer.length);

    res.set('Content-Type', result.contentType);
    // The filename is built from slugified values, so it cannot inject a header.
    res.set('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.set('Content-Length', String(result.buffer.length));
    // A quote's documents are private and must not sit in a shared cache.
    res.set('Cache-Control', 'private, no-store');
    return res.send(result.buffer);
  })
);

router.get(
  '/:reference',
  asyncHandler(async (req, res) => {
    const quote = await Quote.findByReference(req.params.reference);
    if (!quote || quote.owner_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const [events, downloads, deposit, drafts, draftUsage] = await Promise.all([
      Quote.events(quote.id),
      Quote.downloads(quote.id),
      Payment.depositForQuote(quote.id),
      QuoteDraft.listFor(quote.id),
      QuoteDraft.countFor(quote.id)
    ]);

    // Derived from THIS quote's stored total by the same function the checkout uses, so
    // the figure on the page and the figure charged cannot disagree.
    const depositMinor = depositForTotal(quote.total_budget);

    return res.render('quotes/show', {
      title: `${quote.reference} — ${quote.project_name}`,
      quote,
      estimate: quote.estimate,
      events,
      downloads,
      deposit,
      drafts,
      draftUsage,
      draftSections: drafting.SECTIONS,
      draftingEnabled: draftingConfigured(),
      depositAmount: depositMinor === null ? '—' : formatMinor(depositMinor, quote.currency),
      depositPercent: DEPOSIT_PERCENT,
      depositFloor: formatMinor(DEPOSIT_MIN_MINOR),
      depositCap: formatMinor(DEPOSIT_MAX_MINOR),
      transitions: Quote.TRANSITIONS[quote.status] || [],
      // A quote priced under an older catalogue is flagged rather than silently trusted.
      catalogueIsCurrent: quote.catalogue_version === catalogueVersion(),
      ...catalogueLocals()
    });
  })
);

router.post(
  '/:reference/status',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const quote = await Quote.findByReference(req.params.reference);
    if (!quote || quote.owner_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    try {
      const updated = await Quote.transition(quote.id, req.session.user.id, req.body.to_status, {
        note: req.body.note ? String(req.body.note).slice(0, 500) : null
      });
      req.flash('success', `Quote is now "${updated.status}".`);
    } catch (err) {
      if (['INVALID_TRANSITION', 'FORBIDDEN', 'NOT_FOUND'].includes(err.code)) {
        req.flash('error', err.message);
      } else {
        throw err;
      }
    }

    return res.redirect(`/quotes/${quote.reference}`);
  })
);

router.post(
  '/:reference/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const quote = await Quote.findByReference(req.params.reference);
    if (!quote || quote.owner_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const removed = await Quote.remove(quote.id, req.session.user.id);
    req.flash(
      removed ? 'success' : 'error',
      removed
        ? 'Draft deleted.'
        : 'Only a draft can be deleted. A quote that has been sent is withdrawn by changing its status.'
    );
    return res.redirect(removed ? '/quotes' : returnTo(req, `/quotes/${quote.reference}`));
  })
);

/* ------------------------------------------------------------------- drafting */

/**
 * POST /quotes/:reference/draft/:section — ask for a first draft of a narrative section.
 *
 * The route does three things and refuses at each one: it re-checks ownership, it enforces
 * the per-quote cap, and it stores NOTHING unless the draft passed
 * `utils/draftVerification.js`. A draft that invented a figure comes back with its reasons
 * shown to the author rather than being retried out of sight — that failure is the one
 * thing this feature has to be watched for, and hiding it would defeat the check.
 */
router.post(
  '/:reference/draft/:section',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const quote = await Quote.findByReference(req.params.reference);
    if (!quote || quote.owner_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const back = `/quotes/${quote.reference}#drafting`;

    if (!drafting.isSection(req.params.section)) {
      req.flash('error', 'That is not a section this can draft.');
      return res.redirect(back);
    }
    if (!draftingConfigured()) {
      req.flash('error', 'Drafting is not switched on for this deployment. The sections are yours to write.');
      return res.redirect(back);
    }

    const { used, limit } = await QuoteDraft.countFor(quote.id);
    if (used >= limit) {
      // A cost control, not a quality one. Regenerating is the natural response to a draft
      // you dislike, and an unbounded "try again" button on an Opus-priced call is a bill.
      req.flash('error', `This quote has used all ${limit} drafts. Edit what you have, or write the section yourself.`);
      return res.redirect(back);
    }

    const result = await draftSection(quote, req.params.section, { userId: req.session.user.id });

    if (!result.ok) {
      req.flash('error', result.problems && result.problems.length
        ? `${result.reason} What went wrong: ${result.problems.join('; ')}.`
        : result.reason);
      return res.redirect(back);
    }

    await QuoteDraft.create(quote.id, {
      section: req.params.section,
      body: result.body,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      // The catalogue the estimate was priced under WHEN this was drafted, so a draft
      // written against one set of figures beside another is detectable later.
      catalogueVersion: quote.catalogue_version
    });

    req.flash('success', 'Draft ready. Read it, edit it, and accept it if you want it in the document.');
    return res.redirect(back);
  })
);

/**
 * POST /quotes/:reference/draft/:id/accept — put it in the document, as edited.
 *
 * The edited text is what is stored and what a client reads; the model's original is kept
 * beside it. That is the whole ethical basis of the feature: what goes out is what a
 * person put their name to, and they could change every word of it first.
 */
router.post(
  '/:reference/draft/:id/accept',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const quote = await Quote.findByReference(req.params.reference);
    if (!quote || quote.owner_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const edited = (req.body.edited_body || '').trim();

    /*
     * The author's own edit is checked too, and the check is deliberately looser: the
     * numeral rule is dropped, because a consultant quoting a figure in their own words is
     * exactly what they are entitled to do. What still applies is the commitment rule —
     * nothing this application stores should promise a warranty on their behalf.
     */
    if (edited) {
      const promised = FORBIDDEN_TERMS.filter((term) => edited.toLowerCase().includes(term));
      if (promised.length) {
        req.flash('error', `That text commits to something a scope document should not: ${promised.join(', ')}.`);
        return res.redirect(`/quotes/${quote.reference}#drafting`);
      }
    }

    try {
      await QuoteDraft.accept(req.params.id, quote.id, { editedBody: edited || null });
      req.flash('success', 'Accepted. It will appear in the statement of work.');
    } catch (err) {
      if (err.code !== 'NOT_FOUND') throw err;
      req.flash('error', err.message);
    }

    return res.redirect(`/quotes/${quote.reference}#drafting`);
  })
);

router.post(
  '/:reference/draft/:id/withdraw',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const quote = await Quote.findByReference(req.params.reference);
    if (!quote || quote.owner_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    await QuoteDraft.withdraw(req.params.id, quote.id);
    req.flash('success', 'Withdrawn. It will no longer appear in the document.');
    return res.redirect(`/quotes/${quote.reference}#drafting`);
  })
);

module.exports = router;
