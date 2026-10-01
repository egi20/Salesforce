'use strict';

const { sanitizeRichText, toPlainText, jsonForScript } = require('./sanitize');
const { roleLabel, seniorityLabel } = require('../config/roleTaxonomy');
const { moduleLabel, familyLabel } = require('../config/cloudFamilies');
const { engagementLabel, workModeLabel, rateUnit } = require('../config/jobTaxonomy');

/**
 * The functions every template may call, in ONE place.
 *
 * They used to be assigned one line at a time in `server.js`, and an integration test that
 * builds its own Express app stubbed them one line at a time to match. Adding a helper
 * therefore broke a test in a file that had nothing to do with the change, with
 * "seniorityLabel is not defined" thrown from inside a partial — a failure that says
 * nothing about what is wrong.
 *
 * Every entry is a PURE function of its argument. Nothing here reads the request, the
 * session or the database: a helper that did would be per-request state living on a
 * module-level object, which is one request's data answering another's.
 */
const VIEW_HELPERS = Object.freeze({
  sanitizeRichText,
  toPlainText,
  jsonForScript,
  roleLabel,
  seniorityLabel,
  moduleLabel,
  familyLabel,
  engagementLabel,
  workModeLabel,
  rateUnit
});

/** Copy them onto a response's locals. */
function attachViewHelpers(res) {
  Object.assign(res.locals, VIEW_HELPERS);
}

module.exports = { VIEW_HELPERS, attachViewHelpers };
