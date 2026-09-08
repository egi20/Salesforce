# Working on this codebase

Operational notes for anyone — human or agent — changing this project. These are the
things that are not obvious from reading the code, and each one is here because getting it
wrong produced a real bug.

## Ground rules

- **The schema is migrations.** Never add `CREATE TABLE` or `ALTER TABLE` to a model. Add a
  numbered file under `scripts/migrations/`. An applied migration is immutable — the runner
  compares checksums and refuses to start if one changed. Correct a mistake with a new file.
- **All SQL is parameterised.** Filter clauses are assembled from fixed fragments plus a
  `params[]` array. No value is ever interpolated into a query string.
- **Never add a second filter builder.** `Job.buildFilter` and
  `ConsultantProfile.buildFilter` are the only ones. A list view and a bulk mutation must
  provably target the same rows.
- **Validate `:id` params with `requireIdParam`.** `parseInt('44.map')` is `44`.
- **Run `npm run validate-boot` before pushing.** It loads every module and compiles every
  template without needing a database.

## Auth and roles

`middleware/auth.js` answers a failed guard differently depending on the request:

- A top-level navigation (`Sec-Fetch-Dest: document`, or no such header) gets a flash
  message and a 302 to the login page.
- A background fetch gets `401 {success:false,error:...}`.

**Testing consequence:** a plain Node HTTP client sends no `Sec-Fetch-Dest`, so it is
treated as a navigation and sees **302**. A browser `fetch()` sends `Sec-Fetch-Dest: empty`
and sees **401**. Pick one deliberately in a test and say which.

`validateActiveAccount` runs on every request and rebuilds `req.session.user` from the
database, so a revoked role or a deactivated account takes effect on the next request. Do
not cache privilege flags anywhere else.

Role guards check the **flag**, not the primary `user_type`: an admin who is also a
consultant must not be refused a consultant feature.

Role escalation is one-directional and this is a security boundary, not a UI nicety:

- Public registration filters submitted roles against `User.PUBLIC_ROLES`.
- `User.addSelfServiceRoles` unions and never removes; privileged flags pass through
  untouched.
- `User.adminSetRoles` is the only path that removes a role or grants a privileged one, and
  the route behind it is superadmin-gated.

## CSRF

Every mutating form needs `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`.
Client-side fetches send `X-CSRF-Token`, which `public/js/main.js` attaches automatically
from the meta tag. A route that legitimately has no browser session (a signed webhook)
goes through the `exempt` predicate, not by removing the middleware.

## Never use `res.redirect('back')`

It reads `Referer`, and this app sends `Referrer-Policy: no-referrer`, so on a real browser
POST that header is empty and Express silently redirects to `/`. Use `returnTo(req,
fallback)` from `utils/returnTo.js`: it takes an explicit, allow-listed `redirectTo` field
the form carried, and otherwise the per-call-site fallback you pass.

## Consent and immutable dates

Only `POST /auth/register` passes a `consent` object to `User.create`. Admin creation,
seeds and tests pass nothing. Do not "helpfully" default it.

Every timestamp column is `DATETIME` with an explicit default. This is deliberate: with
`explicit_defaults_for_timestamp` disabled, MySQL gives the first `TIMESTAMP` column of a
table an implicit `ON UPDATE CURRENT_TIMESTAMP`, which would silently re-date
`users.created_at` on every unrelated `UPDATE`. `DATETIME` has no such behaviour. Keep it.

## The rate index

Everything lives in `utils/rateAggregation.js` as pure functions over already-fetched rows.
Do not push aggregation into SQL: a `GROUP BY` will quietly bypass the floor.

1. Count **people**, not rows. One person with five submissions is a sample of one.
2. De-duplicate **after** filtering, never before.
3. Below the floor: keep the **count**, null the **values**.
4. A suppressed period is a **gap**. Not a zero, not an interpolation.

`RATE_MIN_SAMPLE` is configurable, but lowering it below 3 to make a sparse index look
fuller defeats the point of having it.

## The estimator

`utils/sowEstimation.js` is pure — no database, no clock beyond one timestamp — so its
invariants are testable, and they are the whole point:

1. Phase days sum EXACTLY to the total. Resource days sum EXACTLY to the same total.
   Both come from `apportionDays` (largest remainder). Never replace it with
   `Math.round(total * pct / 100)`: each call rounds in isolation and the parts drift
   away from the headline figure.
2. Every cost is `days × rate` on integers, so the budget reconciles line by line.
3. Calendar duration is the SUM of sequential phase durations. Do not "simplify" it to
   `totalDays / teamSize / 5` — that treats the whole project as one parallel bucket and
   collapses a 400-day programme into 20 weeks.
4. Excluding training or hypercare redistributes their share into build. It does not
   shrink the project.

`reconciliationProblems(estimate)` re-checks 1–3 plus the timeline. `routes/quotes.js`
calls it before an estimate is shown or stored and throws a 500 on failure, because that
combination can only mean a bug in the engine.

The module catalogue lives in `config/cloudFamilies.js` and nowhere else. Multipliers,
phases, resources and add-ons live in `config/estimation.js`. Both are asserted at boot:
phase and resource percentages that do not sum to 100 shift every estimate by a silent few
per cent instead of failing visibly.

`catalogueVersion()` is a hash of every number that can move an estimate. It is derived
rather than hand-maintained, because a version someone has to remember to bump is a version
that is wrong. A stored quote keeps the version it was priced under and is NEVER
recomputed on read — it is a statement made to a client on a date.

## Generated documents

`utils/documents/` holds one generator per format plus a shared validator, and
`services/quotePackage.js` assembles and zips them.

Two rules, and neither is negotiable:

1. **Render, never recompute.** A generator formats `quote.estimate` and derives nothing.
   All three deliverables read the same stored breakdown, which is why they cannot
   contradict each other or the web page. If you find yourself writing arithmetic in a
   formatter, the number belongs in `utils/sowEstimation.js` instead.
2. **Open it before anyone else has to.** Every generator ends with
   `assertDocumentOpens(buffer, kind)`, which unzips the package and strictly parses every
   `.xml`/`.rels` part. A file that fails is never served; the route turns it into a
   message to the author, because it can only mean a bug in the generator.

Download filenames come from `filenameFor()`, which slugifies the client and project
names. They land in a `Content-Disposition` header, so an unslugified name is header
injection as well as a file the recipient's OS refuses to save.

Documents are generated on demand and not stored. Storing them would create a second
source of truth for the same figures; `quote_downloads` records that one was produced,
along with the catalogue version it was priced under.

**Test runner note:** `npm test` sets `NODE_OPTIONS=--experimental-vm-modules`.
`pptxgenjs` lazily does `await import('node:fs')`, which Jest cannot execute inside a CJS
module without VM modules. It works fine in production; the flag is a test-only
accommodation, not a runtime requirement.

## Uploads and images

The host disk is ephemeral. `multer` keeps the file in memory, `sharp` re-encodes it to a
bounded WebP — which is also the real sanitiser, since anything that is not an image fails
to decode — and `ImageBlob.put` stores the bytes in a side table. The owning row gets only
a pointer URL with a `?v=<ts>` cache buster. Serving routes answer a conditional request
from the ETag alone.

Never store durable bytes on disk, and never inline them as a column on a table that gets
`SELECT *`'d in a list query.

## Messaging

Conversations are ANCHORED. There is no route that opens an unanchored thread, and adding
one would turn this into a channel for contacting arbitrary accounts. A thread is either:

- `application` — both parties are already in that application, or
- `enquiry` — about a specific job, where one of the two owns it. An employer may only
  approach a consultant whose profile is public; a consultant may only approach the
  advertiser of an OPEN role.

`dedupeKeyFor()` derives the thread's identity from the subject, and the unique index on
`conversations.dedupe_key` makes `findOrCreate` an idempotent upsert. Two people clicking
"message" at the same moment get one thread, not two.

The reference implementation keyed one conversation per PAIR of users, which merges every
topic between two people into a single thread. Do not go back to that.

Membership lives in `conversation_participants`. Every read and write joins on it —
`forParticipant()` returns null for a non-member, and `postMessage()` re-checks membership
inside the transaction, so there is no window between "are you in this?" and the insert.

Read state is per participant (`last_read_at`), not a flag on the message: a single
`is_read` is wrong the moment a thread has more than two people. A message you sent never
counts as unread to you.

Bodies are PLAIN TEXT and rendered with `<%= %>`. Do not add rich text here — markup buys
nothing in a chat message and costs an XSS surface.

The display name for the other party falls back to a neutral label, never the email local
part. That fallback is a real finding from the reference implementation: an account with no
profile would otherwise leak a `firstname.lastname` email prefix.

## Notifications

`Notification.emit` never throws and never awaits anything the caller depends on. Every
emitter passes a deterministic `dedupeKey`; the unique index makes the insert idempotent.
If you add a notification, work out its stable key first.

## Bulk operations

`Job.bulkSetStatus` takes an `expectedCount` — the number the screen showed — and aborts
with `BULK_COUNT_MISMATCH` when the filtered set has changed. The route surfaces that as a
409 and changes nothing. Do not "fix" this by removing the interlock when it fires.

## Adding a role or a cloud module

One edit each:

- Role: `config/roleTaxonomy.js` — add to `ROLE_CATEGORIES`, `BASE_DAY_RATES` and,
  ideally, `ROLE_ALIASES`. `assertTaxonomyIntegrity()` fails the boot if you miss one.
- Module: `config/cloudFamilies.js` — add to a family with a `baseEffortDays`.

Nothing else hardcodes a slug list. Keep it that way.

## Email

With no `RESEND_API_KEY`, `utils/email.js` logs instead of sending, which is what makes
local development and CI work without credentials. `send()` returns failures rather than
throwing, because every call site is a side effect of an action that must succeed anyway.

## Style

- CommonJS, `'use strict'`, no transpilation.
- Comments explain **why**, not what. If a rule exists because something broke, say so.
- `<%= %>` escapes, `<%- %>` does not. Only ever pass `sanitizeRichText()` output to `<%- %>`.
- Server-side validation is authoritative. Client-side JavaScript is a convenience and the
  page must work without it.
