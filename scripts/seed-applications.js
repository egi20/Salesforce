'use strict';

/**
 * Demo applications for ONE consultant account, so My Applications can be looked at.
 *
 *   npm run seed:applications                         -> consultant1@example.com
 *   npm run seed:applications -- someone@example.com  -> that account
 *
 * The tracker's status bar, timeline, "Viewed by company", follow-up nudge, archived tab and
 * statistics only exist once an account has applied for things — and an account somebody
 * is reviewing with usually has not. This gives it eight applications that between them
 * show every one of those.
 *
 * The state machine is walked, never bypassed: every application goes through
 * `Application.apply`, and every status through `Application.transition` with the
 * company as the actor (the consultant for the withdrawal). Only the CLOCKS are then moved
 * back — a fixture where everything happened in the same second shows "0 days" to a
 * response and the same date on every step, which hides the timeline it is meant to show.
 *
 * Applies only to open roles this account has not applied for, so running it again adds
 * more rather than duplicating. Refuses on production, like `npm run seed`.
 */

const config = require('../config/config');

if (config.isProduction && process.env.SEED_ALLOW_PRODUCTION !== 'yes') {
  console.error('Refusing to create demo applications: NODE_ENV is production.');
  process.exit(1);
}

const { pool, promisePool } = require('../config/database');
const Application = require('../models/Application');
const Job = require('../models/Job');
const ConsultantDocument = require('../models/ConsultantDocument');

const DAY = 24 * 60 * 60 * 1000;

/*
 * One row per application: how long ago it was sent, the company's steps, when (as a
 * fraction of the gap to its first step) the company opened it, and a private note.
 */
const SCENARIOS = [
  { daysAgo: 20, path: [], viewed: false, why: 'silent for 20 days — shows the follow-up nudge' },
  { daysAgo: 2, path: [], viewed: false, why: 'just sent' },
  { daysAgo: 9, path: ['reviewing'], viewed: true },
  { daysAgo: 12, path: ['reviewing', 'shortlisted'], viewed: true },
  { daysAgo: 15, path: ['reviewing', 'shortlisted', 'interviewing'], viewed: true, note: 'Recruiter called — second interview Tuesday 10:00.' },
  { daysAgo: 25, path: ['reviewing', 'shortlisted', 'interviewing', 'offered'], viewed: true },
  { daysAgo: 30, path: ['reviewing', 'rejected'], viewed: true },
  { daysAgo: 6, path: ['withdrawn'], viewed: false, byConsultant: true }
];

async function seedApplicationsFor(userId, { now = new Date(), log = console.log } = {}) {
  const [[user]] = await promisePool.query('SELECT id, email, is_consultant FROM users WHERE id = ?', [userId]);
  if (!user || !user.is_consultant) throw new Error('That account has no consultant role, so it cannot apply.');

  const [applied] = await promisePool.query('SELECT job_id FROM applications WHERE consultant_user_id = ?', [userId]);
  const appliedIds = new Set(applied.map((r) => r.job_id));
  const { rows: openJobs } = await Job.browse({ status: 'open' }, { limit: 200, sort: 'newest' });
  // A permanent role among them if there is one, so the Contract/Permanent filter shows something.
  const candidates = openJobs.filter((j) => !appliedIds.has(j.id) && j.company_user_id !== userId);
  const permanent = candidates.filter((j) => j.engagement_type === 'permanent').slice(0, 2);
  const jobs = [...permanent, ...candidates.filter((j) => !permanent.includes(j))].slice(0, SCENARIOS.length);
  if (!jobs.length) {
    log('  No open roles left that this account has not applied for.');
    return 0;
  }

  const cvs = (await ConsultantDocument.listFor(userId)).filter((d) => d.kind === 'cv');
  const cv = cvs.find((d) => d.is_default) || cvs[0] || null;

  let created = 0;
  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    const sc = SCENARIOS[i];
    // eslint-disable-next-line no-await-in-loop -- sequential on purpose: each walks a state machine
    const { applicationId } = await Application.apply(job.id, userId, {
      coverLetter: 'I have delivered this kind of programme before and can start within the notice period on my profile.',
      dayRate: Math.round((Number(job.rate_min) || 600) * 1.05),
      currency: job.currency || 'EUR',
      cvDocumentId: cv ? cv.id : null
    });
    for (const step of sc.path) {
      // eslint-disable-next-line no-await-in-loop
      await Application.transition(applicationId, sc.byConsultant ? userId : job.company_user_id, step, { actorIsEmployer: !sc.byConsultant });
    }

    // Move the clocks back: sent `daysAgo`, each step spread evenly up to yesterday.
    const sent = new Date(now.getTime() - sc.daysAgo * DAY);
    const gap = sc.path.length ? ((sc.daysAgo - 1) * DAY) / sc.path.length : 0;
    // eslint-disable-next-line no-await-in-loop
    const [events] = await promisePool.query('SELECT id FROM application_events WHERE application_id = ? ORDER BY id ASC', [applicationId]);
    for (let e = 0; e < events.length; e += 1) {
      const at = new Date(sent.getTime() + Math.round(e * gap));
      // eslint-disable-next-line no-await-in-loop
      await promisePool.query('UPDATE application_events SET created_at = ? WHERE id = ?', [at, events[e].id]);
    }
    const last = new Date(sent.getTime() + Math.round(sc.path.length * gap));
    const viewedAt = sc.viewed ? new Date(sent.getTime() + Math.round((gap || DAY) / 2)) : null;
    // eslint-disable-next-line no-await-in-loop
    await promisePool.query('UPDATE applications SET created_at = ?, updated_at = ?, viewed_at = ? WHERE id = ?', [sent, last, viewedAt, applicationId]);
    if (sc.note) {
      // eslint-disable-next-line no-await-in-loop
      await Application.saveNote(applicationId, userId, sc.note);
    }
    created += 1;
    log(`  ${job.title} — ${sc.path.length ? sc.path[sc.path.length - 1] : 'submitted'}${sc.why ? ` (${sc.why})` : ''}`);
  }
  return created;
}

module.exports = { seedApplicationsFor, SCENARIOS };

if (require.main === module) {
  const email = (process.argv[2] || 'consultant1@example.com').trim().toLowerCase();
  (async () => {
    const [[user]] = await promisePool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (!user) throw new Error(`No account with the email ${email}.`);
    console.log(`Demo applications for ${email}:`);
    const n = await seedApplicationsFor(user.id);
    console.log(`\nDone: ${n} application(s). Open /dashboard/applications signed in as ${email}.`);
  })()
    .then(() => pool.end(() => process.exit(0)))
    .catch((err) => {
      console.error(err.message);
      pool.end(() => process.exit(1));
    });
}
