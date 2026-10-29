'use strict';

const express = require('express');
const { toCsv } = require('../utils/csv');

const countries = require('../config/all-countries.json');
const CrmLead = require('../models/CrmLead');
const CrmSuppression = require('../models/CrmSuppression');
const CrmDraft = require('../models/CrmDraft');
const { isAuthenticated, isSuperadmin } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');
const { returnTo } = require('../utils/returnTo');
const { readLeads } = require('../utils/crmImport');
const outreach = require('../utils/outreachDrafting');
const {
  CHANNELS,
  LEAD_SOURCES,
  LIMITS,
  OUTCOMES,
  STALE_AFTER_DAYS,
  STATUSES,
  TRANSITIONS
} = require('../config/crm');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');

const router = express.Router();

/**
 * The internal sales CRM.
 *
 * SUPERADMIN ONLY, for the same reason `/admin/rates` and `/admin/tax-advisory` are: every
 * screen here shows the contact details of people who never asked to be contacted. A
 * general admin moderating a forum has no business reading them.
 *
 * Nothing in this file sends anything. There is no mail call, no queue worker and no
 * scheduler — a draft is written, a person sends it themselves, and a person records that
 * they did.
 */
router.use(isAuthenticated, isSuperadmin);

/** The filters a screen may set, read once so the list, the count and a bulk action agree. */
function filtersFrom(query) {
  return {
    q: query.q || '',
    status: query.status || '',
    source: query.source || '',
    country: query.country || '',
    unowned: query.unowned === '1',
    stale: query.stale === '1'
  };
}

/** GET /crm — the board. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 50 });
    const filters = filtersFrom(req.query);

    const [{ rows, total }, counts, suppressed, stale] = await Promise.all([
      CrmLead.list(filters, { limit, offset }),
      CrmLead.statusCounts(),
      CrmSuppression.count(),
      CrmLead.staleCount()
    ]);

    res.render('crm/index', {
      title: 'Sales leads',
      leads: rows,
      total,
      counts,
      suppressed,
      stale,
      staleAfterDays: STALE_AFTER_DAYS,
      filters,
      statuses: STATUSES,
      sources: LEAD_SOURCES,
      countries,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/crm', req.query, p)
    });
  })
);

/** GET /crm/new — add one by hand. */
router.get('/new', (req, res) => {
  res.render('crm/edit', {
    title: 'Add a lead',
    lead: null,
    sources: LEAD_SOURCES,
    countries,
    limits: LIMITS
  });
});

router.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { id } = await CrmLead.upsert(req.body, { actorUserId: req.session.user.id });
      req.flash('success', 'Lead saved.');
      return res.redirect(`/crm/${id}`);
    } catch (err) {
      if (!['COMPANY_REQUIRED', 'SOURCE_REQUIRED', 'SOURCE_DETAIL_REQUIRED', 'EMAIL_INVALID', 'SUPPRESSED'].includes(err.code)) {
        throw err;
      }
      req.flash('error', err.message);
      return res.redirect(returnTo(req, '/crm/new'));
    }
  })
);

/**
 * GET /crm/import — the preview.
 *
 * Two steps on purpose. The file is parsed and shown with every row's problems named,
 * and NOTHING is written until the second POST. An import that reports "412 imported, 88
 * failed" afterwards is an import nobody can correct.
 */
router.get('/import', (req, res) => {
  res.render('crm/import', {
    title: 'Import leads',
    sources: LEAD_SOURCES,
    preview: null,
    maxRows: LIMITS.importRows,
    csv: ''
  });
});

router.post(
  '/import/preview',
  writeLimiter,
  asyncHandler(async (req, res) => {
    // Pasted rather than uploaded: a CSV of contact details is small, and a paste box
    // leaves no temporary file on a disk this application treats as ephemeral anyway.
    const csv = String(req.body.csv || '').slice(0, 2_000_000);

    let preview;
    try {
      preview = readLeads(csv, { source: req.body.source, sourceDetail: req.body.source_detail });
    } catch (err) {
      if (!['SOURCE_REQUIRED', 'SOURCE_DETAIL_REQUIRED', 'EMPTY_FILE', 'NO_USABLE_COLUMNS'].includes(err.code)) {
        throw err;
      }
      req.flash('error', err.message);
      return res.redirect('/crm/import');
    }

    // Suppressed addresses are marked HERE, in the preview, so the person importing sees
    // them before anything is written rather than after.
    const suppressed = await CrmSuppression.filterSuppressed(
      preview.candidates.map((c) => c.lead.contact_email).filter(Boolean)
    );
    for (const candidate of preview.candidates) {
      if (candidate.lead.contact_email && suppressed.has(candidate.lead.contact_email)) {
        candidate.problems.push('on the do-not-contact list');
      }
    }

    return res.render('crm/import', {
      title: 'Import leads',
      sources: LEAD_SOURCES,
      preview,
      maxRows: LIMITS.importRows,
      csv,
      source: req.body.source,
      sourceDetail: req.body.source_detail || ''
    });
  })
);

router.post(
  '/import',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const csv = String(req.body.csv || '').slice(0, 2_000_000);

    let preview;
    try {
      // Re-read rather than trusting a hidden field carrying the parsed rows: the browser
      // would then be choosing what gets written, including the source.
      preview = readLeads(csv, { source: req.body.source, sourceDetail: req.body.source_detail });
    } catch (err) {
      if (!err.code) throw err;
      req.flash('error', err.message);
      return res.redirect('/crm/import');
    }

    let written = 0;
    let skipped = 0;
    for (const candidate of preview.candidates) {
      if (candidate.problems.length) {
        skipped += 1;
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await CrmLead.upsert(candidate.lead, { actorUserId: req.session.user.id });
        written += 1;
      } catch (err) {
        // A suppressed address refuses here too, even though the preview marked it — the
        // list may have grown between the two requests, and the model is the last word.
        if (!err.code) throw err;
        skipped += 1;
      }
    }

    req.flash('success', `${written} lead${written === 1 ? '' : 's'} written, ${skipped} skipped.`);
    return res.redirect('/crm');
  })
);

/** GET /crm/export.csv — the same rows the screen showed, through the same builder. */
router.get(
  '/export.csv',
  asyncHandler(async (req, res) => {
    const rows = await CrmLead.exportRows(filtersFrom(req.query));

    const headers = [
      'company', 'contact_name', 'contact_email', 'contact_phone', 'job_title',
      'country', 'website', 'linkedin_url', 'source', 'source_detail', 'status',
      'last_activity_at', 'created_at'
    ];

    // Formula-injection escaping lives in utils/csv.js, shared with the error-log export.
    const csv = toCsv(headers, rows);

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="leads.csv"');
    return res.send(csv);
  })
);

/**
 * GET /crm/suppressions — the do-not-contact list.
 *
 * Shows reasons and dates. It cannot show addresses because it does not hold any: the
 * table stores a hash, so a copy of it is not a copy of the addresses.
 */
router.get(
  '/suppressions',
  asyncHandler(async (req, res) => {
    const [entries, total] = await Promise.all([CrmSuppression.recent({ limit: 100 }), CrmSuppression.count()]);
    res.render('crm/suppressions', { title: 'Do not contact', entries, total });
  })
);

router.post(
  '/suppressions',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const added = await CrmSuppression.add(req.body.email, {
      reason: 'requested',
      note: req.body.note || null,
      actorUserId: req.session.user.id
    });
    req.flash(
      added ? 'success' : 'info',
      added ? 'Added. It stays on the list even if the lead is deleted.' : 'That address was already on the list.'
    );
    return res.redirect('/crm/suppressions');
  })
);

/**
 * POST /crm/bulk — delete what the current filter matches.
 *
 * `expectedCount` is the number the screen showed, and the model aborts on a mismatch.
 * THE REFERENCE GOT THIS RIGHT and it is ported deliberately — worth saying, because most
 * of what this codebase takes from there it takes as a correction.
 */
router.post(
  '/bulk',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const expected = Number.parseInt(req.body.expected_count, 10);

    try {
      const { deleted } = await CrmLead.deleteFiltered(
        filtersFrom(req.body),
        Number.isInteger(expected) ? expected : null
      );
      req.flash(
        'success',
        `${deleted} lead${deleted === 1 ? '' : 's'} deleted. Any suppressions they carried are untouched.`
      );
      return res.redirect('/crm');
    } catch (err) {
      if (err.code !== 'BULK_COUNT_MISMATCH') throw err;
      req.flash('error', err.message);
      return res.status(409).redirect('/crm');
    }
  })
);

/** GET /crm/:id — one lead, its history and its drafts. */
router.get(
  '/:id',
  requireIdParam('id'),
  asyncHandler(async (req, res, next) => {
    const lead = await CrmLead.findById(req.params.id);
    if (!lead) return next();

    const [activities, drafts, suppressed] = await Promise.all([
      CrmLead.activitiesFor(lead.id),
      CrmDraft.forLead(lead.id),
      lead.contact_email ? CrmSuppression.has(lead.contact_email) : Promise.resolve(false)
    ]);

    return res.render('crm/show', {
      title: lead.company,
      lead,
      activities,
      drafts,
      suppressed,
      transitions: TRANSITIONS[lead.status] || [],
      channels: CHANNELS,
      outcomes: OUTCOMES,
      sources: LEAD_SOURCES,
      draftingEnabled: outreach.isConfigured(),
      limits: LIMITS
    });
  })
);

router.post(
  '/:id',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await CrmLead.upsert({ ...req.body, id: req.params.id }, { actorUserId: req.session.user.id });
      req.flash('success', 'Lead saved.');
    } catch (err) {
      if (!err.code) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, `/crm/${req.params.id}`));
  })
);

router.post(
  '/:id/status',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      const result = await CrmLead.setStatus(req.params.id, req.body.status, {
        actorUserId: req.session.user.id,
        note: req.body.note || null,
        channel: req.body.channel || null
      });
      req.flash(
        'success',
        result.to === 'unsubscribed'
          ? 'Marked unsubscribed, and the address is now on the do-not-contact list permanently.'
          : `Moved from ${result.from} to ${result.to}.`
      );
    } catch (err) {
      if (!['NOT_FOUND', 'BAD_STATUS', 'BAD_TRANSITION'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, `/crm/${req.params.id}`));
  })
);

router.post(
  '/:id/activity',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await CrmLead.addActivity(req.params.id, {
        outcome: req.body.outcome,
        channel: req.body.channel || null,
        note: req.body.note || null,
        actorUserId: req.session.user.id
      });
      req.flash('success', 'Recorded.');
    } catch (err) {
      if (!['NOT_FOUND', 'BAD_OUTCOME'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, `/crm/${req.params.id}`));
  })
);

/**
 * POST /crm/:id/draft — write a first message.
 *
 * REFUSED for a suppressed address, and refused for a lead already past the point of being
 * written to. Checking at draft time rather than at send time matters because there is no
 * send time here: the draft IS the artefact somebody acts on.
 */
router.post(
  '/:id/draft',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const lead = await CrmLead.findById(req.params.id);
    if (!lead) {
      req.flash('error', 'That lead no longer exists.');
      return res.redirect('/crm');
    }

    if (lead.contact_email && (await CrmSuppression.has(lead.contact_email))) {
      req.flash('error', 'That address is on the do-not-contact list. Nothing was drafted.');
      return res.redirect(`/crm/${lead.id}`);
    }
    if (['unsubscribed', 'disqualified', 'lost', 'won'].includes(lead.status)) {
      req.flash('error', `This lead is ${lead.status}. Reopen it first if that is wrong.`);
      return res.redirect(`/crm/${lead.id}`);
    }

    const result = await outreach.draftFor(lead, { userId: req.session.user.id });

    if (!result.ok) {
      // The problems are shown, not swallowed: somebody should see that the model invented
      // a relationship, because that is the failure this feature has to be watched for.
      req.flash('error', [result.reason, ...(result.problems || [])].join(' '));
      return res.redirect(`/crm/${lead.id}`);
    }

    await CrmDraft.create(lead.id, {
      body: result.body,
      channel: req.body.channel || 'email',
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      actorUserId: req.session.user.id
    });

    req.flash('success', 'Draft written. Read it, edit it, and send it yourself — nothing here sends anything.');
    return res.redirect(`/crm/${lead.id}`);
  })
);

/** POST /crm/:id/draft/:draftId — save an edit, or record that it was sent by hand. */
router.post(
  '/:id/draft/:draftId',
  requireIdParam('id'),
  requireIdParam('draftId'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    if (req.body.action === 'sent') {
      await CrmDraft.markSent(req.params.draftId, req.params.id);
      await CrmLead.addActivity(req.params.id, {
        outcome: 'sent',
        channel: req.body.channel || 'email',
        note: 'Recorded as sent by hand.',
        actorUserId: req.session.user.id
      });
      req.flash('success', 'Recorded. This is a note somebody made, not a delivery receipt.');
    } else {
      await CrmDraft.saveEdit(req.params.draftId, req.params.id, req.body.edited_body);
      req.flash('success', 'Your edit is saved. The original stays beside it.');
    }
    return res.redirect(returnTo(req, `/crm/${req.params.id}`));
  })
);

module.exports = router;
