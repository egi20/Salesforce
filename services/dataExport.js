'use strict';

const { promisePool } = require('../config/database');

/**
 * Everything this site holds about one account, as JSON the person can keep.
 *
 * GDPR Article 15 is the right to see it and Article 20 is the right to take it somewhere
 * else; one machine-readable file answers both, and answering it in code rather than by hand
 * is the difference between a right and a promise.
 *
 * THREE RULES, and the second is the one that is easy to get wrong.
 *
 * 1. EVERY query is scoped to the one account. No export may reach a row belonging to
 *    anybody else — that would turn a privacy feature into a data breach with a download
 *    button, which is a worse outcome than not having built it.
 * 2. NO PASSWORD HASH, no token, no session. A hash is not useful to the person and is
 *    useful to whoever gets hold of the file — and these files end up in inboxes. The
 *    column list for `users` is written out EXPLICITLY for that reason: `SELECT *` here
 *    would export `password_hash` the moment somebody adds a column and forgets this file
 *    exists.
 * 3. OTHER PEOPLE'S WORDS STAY OUT. A conversation the person took part in is exported as
 *    their own messages, never the replies: the other party's text is the other party's
 *    personal data, and their right does not weaken because somebody they once messaged
 *    asked for a download.
 */

/** Written out rather than `SELECT *` — see rule 2. */
const USER_COLUMNS = [
  'id', 'email', 'name', 'user_type',
  'is_consultant', 'is_company', 'is_recruiter', 'is_partner',
  'is_active', 'email_verified',
  'terms_accepted_at', 'terms_version', 'privacy_policy_version',
  'gender', 'date_of_birth', 'signup_country',
  'onboarded_at', 'last_login_at', 'created_at', 'updated_at'
].join(', ');

/**
 * `table -> the column naming this account`. A plain list, so adding a table that holds
 * somebody's data is one line here and a test can compare it against the schema.
 */
const OWNED = Object.freeze({
  consultant_profiles: 'user_id',
  consultant_work_experiences: 'user_id',
  consultant_certifications: 'user_id',
  consultant_projects: 'user_id',
  consultant_skills: 'user_id',
  company_profiles: 'user_id',
  recruiter_profiles: 'user_id',
  jobs: 'company_user_id',
  applications: 'consultant_user_id',
  saved_jobs: 'user_id',
  rate_submissions: 'user_id',
  posts: 'author_user_id',
  post_replies: 'author_user_id',
  post_votes: 'user_id',
  challenge_attempts: 'user_id',
  quotes: 'owner_user_id',
  payments: 'user_id',
  invoices: 'user_id',
  site_reviews: 'user_id',
  referrers: 'user_id'
});

/** Columns never exported from any table, whatever it is called there. */
const NEVER = new Set(['password_hash', 'token', 'token_hash', 'signup_ip', 'bytes', 'stripe_session_id']);

function scrub(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (NEVER.has(key)) continue;
    // A Buffer is either an image or an IP. Neither belongs in a JSON file; the size is
    // enough to tell somebody it exists.
    out[key] = Buffer.isBuffer(value) ? `<${value.length} bytes, not included>` : value;
  }
  return out;
}

async function rowsFor(table, column, userId) {
  try {
    const [rows] = await promisePool.query(`SELECT * FROM ${table} WHERE ${column} = ?`, [userId]);
    return rows.map(scrub);
  } catch (err) {
    // A table that is not there yet must not fail the whole export — the person still gets
    // everything else, and the gap is named rather than silently missing.
    return { error: `Could not be read: ${err.code || err.message}` };
  }
}

async function buildExport(userId) {
  const [[account]] = await promisePool.query(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = ?`,
    [userId]
  );
  if (!account) {
    const err = new Error('That account no longer exists.');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const data = {};
  for (const [table, column] of Object.entries(OWNED)) {
    // eslint-disable-next-line no-await-in-loop -- one account, a handful of small queries
    const rows = await rowsFor(table, column, userId);
    if (Array.isArray(rows) ? rows.length : rows) data[table] = rows;
  }

  // Only what this person wrote. See rule 3.
  const [messages] = await promisePool.query(
    `SELECT m.id, m.conversation_id, m.body, m.created_at, c.kind
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.sender_user_id = ?
      ORDER BY m.created_at`,
    [userId]
  );

  return {
    exported_at: new Date().toISOString(),
    about: [
      'Everything this site holds about your account.',
      'It does not include your password, which is stored only as a hash nobody can read back.',
      'Messages are the ones you sent. Replies from other people are their data, not yours, so they are not here.',
      'Rate figures you contributed are listed, but once published they are part of an aggregate that cannot single you out and is not recomputed.'
    ],
    account: scrub(account),
    messages_you_sent: messages.map(scrub),
    ...data
  };
}

/** `salesforce-hub-data-2026-09-23.json` — no name, no id: this lands in a Downloads folder. */
function filenameFor(appName = 'salesforce-hub') {
  const slug = String(appName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account';
  return `${slug}-data-${new Date().toISOString().slice(0, 10)}.json`;
}

module.exports = { buildExport, filenameFor, OWNED, USER_COLUMNS, NEVER };
