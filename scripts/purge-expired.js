#!/usr/bin/env node
'use strict';

/**
 * Delete records past their declared retention period.
 *
 * Two promises: tax-advisory enquiries, and issue-report screenshots. It exists as a script rather than only as an admin button so that
 * a deployment with a scheduler can keep the promise without anybody remembering to click
 * anything — and as a button as well, so that somebody can see the number and watch it go
 * to zero. A retention promise nobody can observe being kept is a sentence in a policy.
 */
const TaxEnquiry = require('../models/TaxEnquiry');
const { RETENTION_DAYS } = require('../config/taxAdvisory');
const IssueReport = require('../models/IssueReport');
const { SCREENSHOTS } = require('../config/issues');
const { promisePool } = require('../config/database');

(async () => {
  try {
    const due = await TaxEnquiry.dueForPurge();
    const deleted = await TaxEnquiry.purgeExpired();
    console.log(`tax_enquiries: ${due} past ${RETENTION_DAYS} days, ${deleted} deleted.`);
    const shotsDue = await IssueReport.attachmentsDueForPurge();
    const shots = await IssueReport.purgeExpiredAttachments();
    console.log(`issue_report_attachments: ${shotsDue} past ${SCREENSHOTS.retentionDaysAfterClose} days after closing, ${shots} deleted.`);
    process.exitCode = 0;
  } catch (err) {
    console.error(`Purge failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    // `promisePool.end()`, not `pool.end()`. The callback-style pool's `end` takes a
    // callback and returns undefined, so `await pool.end().catch(...)` throws a TypeError
    // AFTER the work is done — a script that succeeds and then reports failure, which on a
    // nightly cron is an alert every morning about nothing.
    await promisePool.end().catch(() => {});
  }
})();
