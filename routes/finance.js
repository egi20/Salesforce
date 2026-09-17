'use strict';

const express = require('express');

const config = require('../config/config');
const countries = require('../config/all-countries.json');
const FinanceClient = require('../models/FinanceClient');
const FinanceInvoice = require('../models/FinanceInvoice');
const FinanceCost = require('../models/FinanceCost');
const { statementFor } = require('../services/profitAndLoss');
const { generateInvoiceDocx, filenameFor } = require('../utils/documents/invoiceDocx');
const { isAuthenticated, isSuperadmin } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');
const { returnTo } = require('../utils/returnTo');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const {
  COST_CATEGORIES,
  COST_INTERVALS,
  CURRENCIES,
  INVOICE_STATUSES,
  INVOICE_TRANSITIONS,
  LIMITS
} = require('../config/finance');

const router = express.Router();

/**
 * The finance area.
 *
 * SUPERADMIN ONLY. It shows what the business earns and what it owes, which is not
 * something a general administrator moderating a forum needs.
 *
 * Every write path here obeys one rule the rest of the application does not need: an
 * ISSUED invoice cannot be edited or deleted. There is no handler below that does either,
 * and a test asserts it — see `config/finance.js` for the reference implementation's
 * `CompanyInvoice.remove(id)`, a hard DELETE at any status reachable from a list button.
 */
router.use(isAuthenticated, isSuperadmin);

/** The error codes these handlers turn into a flash rather than a 500. */
const EXPECTED = [
  'NAME_REQUIRED', 'NOT_FOUND', 'NO_CLIENT', 'NO_LINES', 'TOO_MANY_LINES',
  'LINE_QUANTITY', 'LINE_PRICE', 'LINE_VAT', 'BAD_CURRENCY', 'BAD_STATUS',
  'BAD_TRANSITION', 'IMMUTABLE', 'NOT_A_DRAFT', 'REASON_REQUIRED',
  'DESCRIPTION_REQUIRED', 'BAD_CATEGORY', 'BAD_AMOUNT', 'BAD_DATE', 'BAD_INTERVAL', 'TOO_OLD'
];

function handled(err) {
  return EXPECTED.includes(err.code);
}

function seller() {
  return {
    name: config.finance.sellerName,
    address: config.finance.sellerAddress.replace(/\\n/g, '\n'),
    taxId: config.finance.sellerTaxId,
    email: config.finance.sellerEmail,
    iban: config.finance.sellerIban
  };
}

/* ------------------------------------------------------------------ overview */

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [statement, outstanding, invoices, costs] = await Promise.all([
      statementFor(),
      FinanceInvoice.outstanding(),
      FinanceInvoice.list({}, { limit: 8, offset: 0 }),
      FinanceCost.list({ active: true }, { limit: 8, offset: 0 })
    ]);

    res.render('finance/index', {
      title: 'Finance',
      statement,
      outstanding,
      recentInvoices: invoices.rows,
      costs: costs.rows,
      sellerConfigured: Boolean(config.finance.sellerName)
    });
  })
);

/* ------------------------------------------------------------------ clients */

router.get(
  '/clients',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 50 });
    const filters = { q: req.query.q || '', include_archived: req.query.archived === '1' };
    const { rows, total } = await FinanceClient.list(filters, { limit, offset });

    res.render('finance/clients', {
      title: 'Clients',
      clients: rows,
      filters,
      countries,
      limits: LIMITS,
      editing: req.query.edit ? await FinanceClient.findById(parseInt(req.query.edit, 10) || 0) : null,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/finance/clients', req.query, p)
    });
  })
);

router.post(
  '/clients',
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await FinanceClient.create(req.body);
      req.flash('success', 'Client saved.');
    } catch (err) {
      if (!handled(err)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect('/admin/finance/clients');
  })
);

router.post(
  '/clients/:id',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await FinanceClient.update(req.params.id, req.body);
      // Note what this does NOT do: it does not touch any invoice already issued to them.
      // Those carry their own copy of the name, address and tax id, frozen at issue.
      req.flash('success', 'Client saved. Invoices already issued keep the details they were issued with.');
    } catch (err) {
      if (!handled(err)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, '/admin/finance/clients'));
  })
);

router.post(
  '/clients/:id/archive',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const archive = req.body.archived === 'true';
    await FinanceClient.setArchived(req.params.id, archive);
    // Archiving, never deleting: the foreign key from `finance_invoices` has no cascade,
    // so the database refuses to remove a customer an invoice was addressed to.
    req.flash('success', archive ? 'Client archived. Their invoices are untouched.' : 'Client restored.');
    return res.redirect(returnTo(req, '/admin/finance/clients'));
  })
);

/* ------------------------------------------------------------------ invoices */

router.get(
  '/invoices',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 40 });
    const filters = {
      q: req.query.q || '',
      status: req.query.status || '',
      year: req.query.year || '',
      overdue: req.query.overdue === '1'
    };

    const [{ rows, total }, years, clients] = await Promise.all([
      FinanceInvoice.list(filters, { limit, offset }),
      FinanceInvoice.years(),
      FinanceClient.list({}, { limit: 500, offset: 0 })
    ]);

    res.render('finance/invoices', {
      title: 'Invoices',
      invoices: rows,
      filters,
      years,
      clients: clients.rows,
      statuses: INVOICE_STATUSES,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/finance/invoices', req.query, p)
    });
  })
);

router.get(
  '/invoices/new',
  asyncHandler(async (req, res) => {
    const clients = await FinanceClient.list({}, { limit: 500, offset: 0 });
    res.render('finance/invoiceEdit', {
      title: 'New invoice',
      invoice: null,
      clients: clients.rows,
      currencies: CURRENCIES,
      limits: LIMITS
    });
  })
);

router.post(
  '/invoices',
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { id } = await FinanceInvoice.createDraft({
        clientId: req.body.client_id,
        currency: req.body.currency,
        reference: req.body.reference,
        notes: req.body.notes,
        dueDate: req.body.due_date || null,
        lines: req.body.lines,
        actorUserId: req.session.user.id
      });
      req.flash('success', 'Draft saved. It has no number until you issue it.');
      return res.redirect(`/admin/finance/invoices/${id}`);
    } catch (err) {
      if (!handled(err)) throw err;
      req.flash('error', err.message);
      return res.redirect('/admin/finance/invoices/new');
    }
  })
);

router.get(
  '/invoices/:id',
  requireIdParam('id'),
  asyncHandler(async (req, res, next) => {
    const invoice = await FinanceInvoice.findById(req.params.id);
    if (!invoice) return next();

    const clients = await FinanceClient.list({ include_archived: true }, { limit: 500, offset: 0 });

    return res.render('finance/invoiceShow', {
      title: invoice.label ? `Invoice ${invoice.label}` : 'Draft invoice',
      invoice,
      clients: clients.rows,
      currencies: CURRENCIES,
      limits: LIMITS,
      transitions: INVOICE_TRANSITIONS[invoice.status] || [],
      // Re-checked before it is shown, exactly as routes/quotes.js re-checks an estimate.
      problems: FinanceInvoice.problemsWith(invoice),
      seller: seller(),
      sellerConfigured: Boolean(config.finance.sellerName)
    });
  })
);

router.post(
  '/invoices/:id',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await FinanceInvoice.updateDraft(req.params.id, {
        clientId: req.body.client_id,
        currency: req.body.currency,
        reference: req.body.reference,
        notes: req.body.notes,
        dueDate: req.body.due_date || null,
        lines: req.body.lines
      });
      req.flash('success', 'Draft saved.');
    } catch (err) {
      if (!handled(err)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(`/admin/finance/invoices/${req.params.id}`);
  })
);

/**
 * Issue it: allocate the number under a lock and freeze the customer's details.
 *
 * After this the invoice cannot be edited by any path in this application.
 */
router.post(
  '/invoices/:id/issue',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      const result = await FinanceInvoice.issue(req.params.id, {
        issueDate: req.body.issue_date || null,
        actorUserId: req.session.user.id
      });
      req.flash('success', `Issued as ${result.label}. It cannot be edited from here on — only cancelled.`);
    } catch (err) {
      if (!handled(err)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(`/admin/finance/invoices/${req.params.id}`);
  })
);

router.post(
  '/invoices/:id/status',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      const result = await FinanceInvoice.setStatus(req.params.id, req.body.status, { reason: req.body.reason });
      req.flash(
        'success',
        result.to === 'cancelled'
          ? 'Cancelled. The number stays used — a gap in the sequence is the thing an auditor looks for.'
          : `Marked ${result.to}.`
      );
    } catch (err) {
      if (!handled(err)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, `/admin/finance/invoices/${req.params.id}`));
  })
);

/** Discard a DRAFT. The only deletion here, safe because a draft never held a number. */
router.post(
  '/invoices/:id/discard',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await FinanceInvoice.discardDraft(req.params.id);
      req.flash('success', 'Draft discarded.');
      return res.redirect('/admin/finance/invoices');
    } catch (err) {
      if (!handled(err)) throw err;
      req.flash('error', err.message);
      return res.redirect(`/admin/finance/invoices/${req.params.id}`);
    }
  })
);

/**
 * The document, generated on demand and never stored.
 *
 * Storing it would create a second source of truth for the same figures — the same reason
 * a quote's SOW is not stored. The generator re-checks that the invoice reconciles and
 * refuses to produce a file if it does not.
 */
router.get(
  '/invoices/:id/download',
  requireIdParam('id'),
  asyncHandler(async (req, res, next) => {
    const invoice = await FinanceInvoice.findById(req.params.id);
    if (!invoice) return next();

    try {
      const buffer = await generateInvoiceDocx(invoice, seller());
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.set('Content-Disposition', `attachment; filename="${filenameFor(invoice)}"`);
      return res.send(buffer);
    } catch (err) {
      if (!['INVOICE_DOES_NOT_RECONCILE', 'NOT_ISSUED', 'DOCUMENT_MALFORMED'].includes(err.code)) throw err;
      // Turned into a message to the author rather than a 500: each of these can only mean
      // a bug in this application, and the person needs to know which.
      req.flash('error', err.message);
      return res.redirect(`/admin/finance/invoices/${req.params.id}`);
    }
  })
);

/* ------------------------------------------------------------------ costs */

router.get(
  '/costs',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 60 });
    const filters = {
      q: req.query.q || '',
      category: req.query.category || '',
      recurring: req.query.recurring || '',
      active: req.query.active === '1'
    };
    const { rows, total } = await FinanceCost.list(filters, { limit, offset });

    res.render('finance/costs', {
      title: 'Costs',
      costs: rows,
      filters,
      categories: COST_CATEGORIES,
      intervals: COST_INTERVALS,
      currencies: CURRENCIES,
      limits: LIMITS,
      editing: req.query.edit ? await FinanceCost.findById(parseInt(req.query.edit, 10) || 0) : null,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/admin/finance/costs', req.query, p)
    });
  })
);

router.post(
  '/costs',
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await FinanceCost.create(req.body, { actorUserId: req.session.user.id });
      req.flash('success', 'Cost saved.');
    } catch (err) {
      if (!handled(err)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect('/admin/finance/costs');
  })
);

router.post(
  '/costs/:id',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await FinanceCost.update(req.params.id, req.body);
      req.flash('success', 'Cost saved.');
    } catch (err) {
      if (!handled(err)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, '/admin/finance/costs'));
  })
);

/**
 * End a recurring cost rather than deleting it.
 *
 * Deleting a subscription paid for eleven months removes eleven months of real expense
 * from every past P&L. `remove` exists but refuses anything that already applies to a past
 * month.
 */
router.post(
  '/costs/:id/end',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      if (req.body.action === 'delete') {
        await FinanceCost.remove(req.params.id);
        req.flash('success', 'Removed. It had not reached a past month.');
      } else {
        await FinanceCost.end(req.params.id, req.body.ends_on);
        req.flash('success', 'Ended. Past months keep it, future months do not.');
      }
    } catch (err) {
      if (!handled(err)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, '/admin/finance/costs'));
  })
);

/* ------------------------------------------------------------------ reports */

router.get(
  '/pl',
  asyncHandler(async (req, res) => {
    const statement = await statementFor({ from: req.query.from, to: req.query.to });
    res.render('finance/pl', {
      title: 'Profit and loss',
      statement,
      categories: COST_CATEGORIES
    });
  })
);

/**
 * The sequence check.
 *
 * There should never be a gap: numbers are allocated under a lock and an issued invoice is
 * cancelled rather than deleted. This page exists so that claim is CHECKABLE rather than
 * asserted in a comment — it is the first thing anybody auditing the books looks for.
 */
router.get(
  '/sequence',
  asyncHandler(async (req, res) => {
    const years = await FinanceInvoice.years();
    const checks = await Promise.all(years.map((year) => FinanceInvoice.sequenceGaps(year)));
    res.render('finance/sequence', { title: 'Invoice numbering', checks });
  })
);

module.exports = router;
