'use strict';

/**
 * Single source of truth for the policy versions stamped at registration.
 *
 * Consent rule carried over verbatim: ONLY the public registration route stamps
 * these. Admin-created, seeded and test accounts pass nothing, because consent must
 * never be fabricated on someone's behalf. Bump a version here whenever the
 * corresponding document changes materially.
 */
module.exports = {
  /*
   * Bumped when the policy was rewritten to name a controller, state a legal basis, list the
   * third parties that receive data and describe the rights people actually have — and when
   * the site gained the routes to honour two of them. Anyone who registered under
   * 2026-09-01 has their consent stamped with that version, which is the point of stamping
   * it: their record says what they were shown, not what is on the page today.
   */
  PRIVACY_VERSION: '2026-09-23',
  TERMS_VERSION: '2026-09-01'
};
