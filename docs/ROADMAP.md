# Roadmap

What exists today is the marketplace core. This file is the honest list of what is not
built, roughly in the order it would earn its place.

## Built since this file was written

Search across everything, LinkedIn verification, AI drafting for quote narratives, payments,
community, the tax advisory introduction, the daily challenge, recruiters, success stories
and reviews, the sales CRM, and the finance area. Each is described in `CLAUDE.md` under its
own heading, with what was deliberately left out and why. They are listed here only so this
file stops promising things that already exist — a roadmap nobody trims is a roadmap that
reads as a list of missing features when it is really a changelog in the wrong tense.

## Near term

**Email digests.** A weekly "roles that match you" using `utils/jobMatcher.js`, and a
"new applicants" digest for employers. The matcher is already shared and pure, so the
digest and the on-page score cannot disagree. Nothing of this is built: there is no
scheduler, no unsubscribe preference and no send. Three things it needs before a single
message goes out, and none is optional:

- **A per-digest unsubscribe that is honoured before the query, not after.** The CRM already
  has the shape — a suppression that outlives the row it came from.
- **A record of what was sent.** A digest that cannot say which roles it listed is a digest
  nobody can debug when somebody says they were not told about a job.
- **An idempotency key per recipient per period.** A scheduler that runs twice must not mail
  twice, for the same reason `points_ledger` carries a `dedupe_key`.

**A deployment.** The application runs against a real MySQL 8, every migration applies from
empty and the finance flow has been exercised end to end — but nothing is serving traffic.
See `docs/DEPLOYING.md`. This is the only item here that blocks everything else being
useful to anybody.

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
