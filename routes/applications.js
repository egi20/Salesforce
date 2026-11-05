'use strict';

const express = require('express');
const { body } = require('express-validator');

const Application = require('../models/Application');
const Job = require('../models/Job');
const Notification = require('../models/Notification');
const email = require('../utils/email');
const config = require('../config/config');
const { returnTo } = require('../utils/returnTo');
const { statusLabel } = require('../utils/applicationStats');
const { safeFilename } = require('../utils/documentUpload');
const { isAuthenticated } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');

const router = express.Router();

router.use(isAuthenticated);

/** The employer's pipeline for one job. */
router.get(
  '/job/:slug',
  asyncHandler(async (req, res) => {
    const job = await Job.findBySlug(req.params.slug);
    if (!job) return res.status(404).render('errors/404', { title: 'Not found' });

    const user = req.session.user;
    if (job.company_user_id !== user.id && !user.isAdmin) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const status = ['submitted', 'reviewing', 'shortlisted', 'interviewing', 'offered', 'hired', 'rejected', 'withdrawn'].includes(
      req.query.status
    )
      ? req.query.status
      : '';

    const { rows, total } = await Application.listForJob(job.id, { status });

    return res.render('applications/pipeline', {
      title: `Applicants — ${job.title}`,
      job,
      applications: rows,
      total,
      status,
      transitions: Application.TRANSITIONS
    });
  })
);

router.get(
  '/:id',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const application = await Application.findById(req.params.id);
    if (!application) return res.status(404).render('errors/404', { title: 'Not found' });

    const user = req.session.user;
    const isEmployer = application.company_user_id === user.id;
    const isApplicant = application.consultant_user_id === user.id;
    if (!isEmployer && !isApplicant && !user.isAdmin) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    /*
     * "Viewed by company": the first time the employer opens the application. Not when an
     * administrator or the applicant opens it — only the company's attention is the news.
     */
    if (isEmployer && !isApplicant) await Application.markViewed(application.id);

    const events = await Application.events(application.id);

    return res.render('applications/show', {
      title: `Application — ${application.job_title}`,
      application,
      events,
      isEmployer,
      isApplicant,
      transitions: Application.TRANSITIONS[application.status] || []
    });
  })
);

/**
 * The CV that went with an application, for its two parties only. Same standing as the
 * owner's own download: attachment only, nosniff, never cached — this is somebody's CV
 * leaving to a company they chose, and it must not go anywhere else on the way.
 */
router.get(
  '/:id/cv',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const application = await Application.findById(req.params.id);
    const user = req.session.user;
    if (!application || (application.company_user_id !== user.id && application.consultant_user_id !== user.id)) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }
    const doc = await Application.sentCv(application.id);
    if (!doc) return res.status(404).render('errors/404', { title: 'Not found' });
    res.set('Content-Type', doc.content_type);
    res.set('Content-Disposition', `attachment; filename="${safeFilename(doc.title || doc.filename, doc.content_type)}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    return res.send(doc.bytes);
  })
);

/** The applicant's private note on their own application. */
router.post(
  '/:id/note',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const ok = await Application.saveNote(Number(req.params.id), req.session.user.id, req.body.note);
    if (!ok) return res.status(404).render('errors/404', { title: 'Not found' });
    req.flash('success', String(req.body.note || '').trim() ? 'Note saved.' : 'Note removed.');
    return res.redirect(returnTo(req, '/dashboard/applications'));
  })
);

router.post(
  '/:id/transition',
  requireIdParam('id'),
  writeLimiter,
  [body('to_status').notEmpty()],
  asyncHandler(async (req, res) => {
    const application = await Application.findById(req.params.id);
    if (!application) return res.status(404).render('errors/404', { title: 'Not found' });

    const user = req.session.user;
    const isEmployer = application.company_user_id === user.id || user.isAdmin;
    const isApplicant = application.consultant_user_id === user.id;
    if (!isEmployer && !isApplicant) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    try {
      const updated = await Application.transition(application.id, user.id, req.body.to_status, {
        note: req.body.note ? String(req.body.note).slice(0, 500) : null,
        actorIsEmployer: isEmployer
      });

      // Notify the other party. Fire and forget, keyed on the exact transition so a
      // retried submit cannot notify twice.
      const recipientId = isEmployer ? application.consultant_user_id : application.company_user_id;
      Notification.emit({
        userId: recipientId,
        type: 'application_status',
        title: `Application for ${application.job_title} is now "${updated.status}"`,
        link: `/applications/${application.id}`,
        dedupeKey: `application-status:${application.id}:${updated.previousStatus}:${updated.status}`
      });

      /*
       * An email to the consultant when the COMPANY moves the application — the change they
       * are waiting for. Not on their own withdraw. `send` returns failures rather than
       * throwing, and nothing waits on it: a mail outage must not undo a hiring decision.
       */
      if (isEmployer && application.consultant_user_id !== user.id && application.consultant_email) {
        email.send({
          to: application.consultant_email,
          subject: `Your application for ${application.job_title}: ${statusLabel(updated.status)}`,
          template: 'application-status',
          locals: {
            name: application.consultant_name || 'there',
            jobTitle: application.job_title,
            companyName: application.company_name || null,
            statusLabel: statusLabel(updated.status),
            note: req.body.note ? String(req.body.note).slice(0, 500) : null,
            link: `${config.app.baseUrl}/dashboard/applications`
          }
        });
      }

      const answer = updated.previousStatus === 'offered' && !isEmployer
        ? { hired: 'Offer accepted — congratulations.', withdrawn: 'Offer declined. The company has been told.' }[updated.status]
        : null;
      req.flash('success', answer || `Application moved to "${statusLabel(updated.status)}".`);
    } catch (err) {
      if (['INVALID_TRANSITION', 'FORBIDDEN', 'NOT_FOUND'].includes(err.code)) {
        req.flash('error', err.message);
      } else {
        throw err;
      }
    }

    // A withdraw from the consultant's list returns to that list (allow-listed redirectTo).
    return res.redirect(returnTo(req, `/applications/${application.id}`));
  })
);

module.exports = router;
