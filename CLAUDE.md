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

## Uploads and images

The host disk is ephemeral. `multer` keeps the file in memory, `sharp` re-encodes it to a
bounded WebP — which is also the real sanitiser, since anything that is not an image fails
to decode — and `ImageBlob.put` stores the bytes in a side table. The owning row gets only
a pointer URL with a `?v=<ts>` cache buster. Serving routes answer a conditional request
from the ETag alone.

Never store durable bytes on disk, and never inline them as a column on a table that gets
`SELECT *`'d in a list query.

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
