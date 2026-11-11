'use strict';

/**
 * How long the error log keeps a row. It holds the signed-in user's id and the browser's
 * user agent beside each failure, which makes it personal data with one purpose — finding
 * and fixing what broke — and the privacy policy states this period. `npm run purge:expired`
 * enforces it, so the promise does not depend on somebody pressing the button on
 * /admin/errors (which can still clear a shorter window).
 */
const ERROR_LOG_RETENTION_DAYS = 90;

module.exports = { ERROR_LOG_RETENTION_DAYS };
