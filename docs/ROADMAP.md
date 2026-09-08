# Roadmap

What exists today is the marketplace core. This file is the honest list of what is not
built, roughly in the order it would earn its place.

## Near term

**Search across everything.** One search box that spans jobs, consultants and companies,
with the same filter builders behind it. Today each directory has its own search.

**Email digests.** A weekly "roles that match you" using `utils/jobMatcher.js`, and a
"new applicants" digest for employers. The matcher is already shared and pure, so the
digest and the on-page score cannot disagree.

**Messaging.** Direct conversations between an employer and an applicant, scoped to an
application so it has a subject and an audit trail.

**LinkedIn verification.** OAuth used only to prove identity, not as a sign-in method,
setting `consultant_profiles.linkedin_verified`. Note that LinkedIn has no API for sending
connection requests or DMs — any feature that implies automated outreach would be a lie.

## Medium term

**Document generation on top of the estimator.** The estimator itself now exists
(`utils/sowEstimation.js`, `/quotes`): it produces the phased plan, team shape, budget and
timeline, and refuses to present an estimate that does not reconcile with itself. What is
still missing is turning that into deliverables — a branded SOW in DOCX, a work-breakdown
XLSX with a Gantt, and a summary PPTX, packaged as one download.

Two constraints from experience, worth writing down before anyone starts:

- Validate every generated file before serving it. A template splice that produces
  unbalanced XML must fall back to a known-good layout rather than ship a corrupt document.
- Keep every displayed figure reconcilable with the stored estimate. The documents must not
  re-derive anything; they render `quotes.estimate` verbatim. Largest-remainder
  apportionment, `cost = days × rounded rate` and percentages summing to exactly 100 are
  already guaranteed upstream — do not undo them in a formatter.

**AI drafting.** Narrative sections (scope, assumptions, risks, commercials) drafted around
the deterministic numbers, never replacing them. Required sections must be guaranteed
structurally rather than by re-prompting until they appear, and no AI-supplied figure may
enter the budget without going back through the estimator.

**Payments.** Featured job posts and placement fees. Two rules: put idempotency in the
webhook handler itself (an invoice row means fulfilled) rather than gating on payment
status, and add a second guard for two checkout sessions against the same quote.

**Community.** Questions, answers and articles per cloud, reusing the module taxonomy as
the category tree.

## Longer term

**Salesforce org integration.** Optional, per-company: sync companies to Accounts, job
posts to a custom `Job_Posting__c`, applications to `Job_Application__c`, using
`SalesforceHub_Id__c` as an external id so every write is an idempotent upsert.

Mechanics that are non-negotiable if this gets built:

- JWT bearer flow with a Connected App for server-to-server; web server flow with PKCE for
  a user-delegated connection.
- `instance_url` comes from the token response and is never hardcoded — My Domain changes
  and org migrations move it.
- Retry exactly once on `401 INVALID_SESSION_ID` after refreshing; sessions can be
  invalidated by admin policy at any time.
- Batch through the Composite API (25 subrequests) and Bulk API 2.0, and treat
  `403 REQUEST_LIMIT_EXCEEDED` and `UNABLE_TO_LOCK_ROW` as distinct, differently-handled
  failures.
- Keep telemetry out of Salesforce. Error logs and API usage stay in MySQL rather than
  burning org storage and API allowance.

**Certification practice questions.** Only with originally authored questions written
against the official exam guides. Exam dumps are both a licence violation and useless
preparation, and this is not a feature worth having dishonestly.
