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
  PRIVACY_VERSION: '2026-11-11',
  TERMS_VERSION: '2026-09-01',

  /*
   * What changed in each version of the privacy policy, newest first, shown under "What
   * changed" on the policy itself. A version stamp without a list of changes tells somebody
   * the text moved but not whether it matters to them.
   */
  PRIVACY_CHANGES: Object.freeze([
    {
      version: '2026-11-11',
      changes: [
        'Every purpose now names its legal basis and how long the data is kept.',
        'New sections for the Albania tax optimization programme, uploaded CVs and documents, and the business contacts our sales team keeps.',
        'The list of service providers now says where each one processes data, and that Import from CV sends the CV’s text to the AI provider.',
        'Gender and date of birth are no longer asked for, and the answers given before were deleted.',
        'The data protection authorities are named.'
      ]
    },
    {
      version: '2026-09-23',
      changes: [
        'Named who is responsible, the reason for each kind of data and the services that receive it.',
        'Added the download and account-closing pages that let you exercise two rights yourself.'
      ]
    }
  ])
};
