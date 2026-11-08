'use strict';

const express = require('express');

const ConsultantProfile = require('../models/ConsultantProfile');
const ConsultantDocument = require('../models/ConsultantDocument');
const GeneratedDocument = require('../models/GeneratedDocument');
const Application = require('../models/Application');
const { isConsultant } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { build: buildDossier } = require('../services/consultantDossier');
const { PACKAGE_KIND, generateDocument, generatePackage } = require('../services/consultantPackage');
const { OPTIONAL_SECTIONS, optionsFrom, cvBlocks, sectionHasData, cvMissing } = require('../utils/documents/cvLayout');

const router = express.Router();

/**
 * The CV Generator: the consultant half of what used to be one "document generator" page.
 *
 * That page served two audiences with one button. A consultant arriving from "CV Generator"
 * in the menu found a page whose only action was "Start a quote" — the SOW pack, which is
 * for a company buying work. The SOW pack keeps /services/document-generator; this page is
 * the consultant's, and its only actions are about their own CV.
 *
 * The whole state is in the query string (document, sections), like the rate calculator:
 * the preview, the download and a reload all read the same URL, and nothing about a
 * choice of sections is worth storing.
 *
 * Documents are generated on demand and never stored (CLAUDE.md, "Generated documents"), so
 * "My documents" lists the files the consultant UPLOADED and offers fresh generated ones —
 * there is no history of generated files because there are no generated files to keep.
 */

const DOCUMENTS = Object.freeze([
  { value: 'cv', label: 'CV', format: '.docx', text: 'Your profile as a one-column CV, ready to edit in Word.' },
  { value: PACKAGE_KIND, label: 'CV + rate card', format: '.zip', text: 'The CV and a one-page rate card, zipped together.' }
]);
const DOCUMENT_VALUES = DOCUMENTS.map((d) => d.value);

/** A CV below this is thin enough to say so; the same floor a profile needs to be listed. */
const COMPLETE_ENOUGH = ConsultantProfile.MIN_COMPLETENESS_TO_PUBLISH || 60;

function documentFrom(query) {
  return DOCUMENT_VALUES.includes(query.doc) ? query.doc : 'cv';
}

/** The selection as a query string, so links (download, preview) carry exactly what is shown. */
function queryFor(doc, options, application = null) {
  const params = new URLSearchParams({ doc, opts: '1' });
  for (const section of OPTIONAL_SECTIONS) if (options[section.key]) params.append('include', section.key);
  if (application) params.set('application', String(application.id));
  return params.toString();
}

/**
 * `?application=ID` — a CV made for one application, so "My documents" can say who it was for.
 * Honoured only for the consultant's OWN application: anybody else's id is treated as absent,
 * never as an error that confirms the id exists.
 */
async function ownApplication(userId, raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== String(raw)) return null;
  const app = await Application.findById(id);
  return app && app.consultant_user_id === userId ? app : null;
}

const includedSections = (options) => OPTIONAL_SECTIONS.filter((s) => options[s.key]).map((s) => s.key);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.session.user || null;
    const base = {
      title: 'CV Generator',
      documents: DOCUMENTS,
      sections: OPTIONAL_SECTIONS,
      mode: !user ? 'visitor' : user.isConsultant ? 'consultant' : 'no-role'
    };
    if (base.mode !== 'consultant') return res.render('cv/index', base);

    const userId = user.id;
    const [dossier, profile, uploads, application] = await Promise.all([
      buildDossier(userId),
      ConsultantProfile.findByUserId(userId),
      ConsultantDocument.listFor(userId),
      req.query.application ? ownApplication(userId, req.query.application) : null
    ]);
    const doc = documentFrom(req.query);
    const options = optionsFrom(req.query, dossier || {});

    return res.render('cv/index', {
      ...base,
      completeness: profile ? profile.completeness : 0,
      completeEnough: COMPLETE_ENOUGH,
      doc,
      options,
      query: queryFor(doc, options, application),
      application,
      blocks: dossier ? cvBlocks(dossier, options) : [],
      // Sections the profile has nothing for: shown greyed out and unticked, never ticked-but-empty.
      emptySections: OPTIONAL_SECTIONS.map((s) => s.key).filter((key) => !sectionHasData(dossier || {}, key)),
      uploads,
      missing: cvMissing(dossier)
    });
  })
);

/** The preview alone, for the page to refresh in place when a box is ticked. */
router.get(
  '/preview',
  isConsultant,
  asyncHandler(async (req, res) => {
    const dossier = await buildDossier(req.session.user.id);
    if (!dossier) return res.status(404).send('');
    res.set('Cache-Control', 'private, no-store');
    return res.render('cv/_preview', { blocks: cvBlocks(dossier, optionsFrom(req.query, dossier)), layout: false });
  })
);

/**
 * The download, with the sections the preview showed. Same standing as the profile's own
 * download route: a document that fails its own validity check becomes a message, never a
 * served file.
 */
router.get(
  '/download',
  isConsultant,
  asyncHandler(async (req, res) => {
    const dossier = await buildDossier(req.session.user.id);
    const missing = cvMissing(dossier);
    if (missing.length) {
      req.flash('error', `Add ${missing.join(' and ')} to your profile first — a CV with only a name and an email is not one to send.`);
      return res.redirect('/cv-generator');
    }
    const doc = documentFrom(req.query);
    const options = optionsFrom(req.query, dossier);
    const application = req.query.application ? await ownApplication(req.session.user.id, req.query.application) : null;

    let result;
    try {
      result = doc === PACKAGE_KIND ? await generatePackage(dossier, options) : await generateDocument(dossier, doc, options);
    } catch (err) {
      if (err.code === 'DOCUMENT_MALFORMED') {
        req.flash('error', 'That document did not generate correctly and was not sent. Please report it.');
        return res.redirect('/cv-generator');
      }
      throw err;
    }

    // The log behind "Recently generated" — what and when, never the file.
    await GeneratedDocument.log(req.session.user.id, {
      kind: doc === PACKAGE_KIND ? 'cv_rate_card' : 'cv',
      sections: includedSections(options),
      applicationId: application ? application.id : null
    });

    res.set('Content-Type', result.contentType);
    // The filename is built from a slugified name, so it cannot inject a header.
    res.set('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.set('Content-Length', String(result.buffer.length));
    res.set('Cache-Control', 'private, no-store');
    return res.send(result.buffer);
  })
);

module.exports = router;
module.exports.DOCUMENTS = DOCUMENTS;
