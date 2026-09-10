# Salesforce Hub

A marketplace for the Salesforce consulting ecosystem: a job board, a talent directory,
and a day-rate index built from figures contributed by the people doing the work.

Server-rendered Express + EJS on MySQL 8. No SPA, no ORM, no build step for server code.

---

## What is here

| Area | State |
|---|---|
| Accounts, multi-role model, email verification, password reset | built |
| Consultant profiles: skills, certifications, experience, photo, completeness gate | built |
| Company profiles, logo, public directory | built |
| Job board: post, edit, publish/pause/close, bulk actions with an interlock | built |
| Applications: apply, employer pipeline, state machine, audit trail | built |
| Match scoring between a consultant and a role, with a visible breakdown | built |
| Day-rate index with an n≥3 privacy floor, percentiles and a trend | built |
| Scope estimator and quotes: phased plan, team shape, budget, timeline, lifecycle | built |
| Deliverables: SOW (.docx), work breakdown with Gantt (.xlsx), summary deck (.pptx), zipped | built |
| Community: questions, discussions, articles and wins, with votes and accepted answers | built |
| Signed-in home feed, points and levels, 30-day leaderboard | built |
| Messaging: threads anchored to an application or a role, unread counts, notifications | built |
| Notifications, saved jobs, dashboards | built |
| Payments: featured job placements, quote deposits, invoices, Stripe webhook | built |
| Admin: users and roles, jobs, error log, visitor geography, payments and refunds | built |
| SEO: canonicals, JobPosting JSON-LD, sitemap generated from the robots allowlist | built |

Deliberately not built yet, and listed so nobody mistakes the scope: AI drafting of the
narrative sections, referral commissions, record deduplication, finance/P&L reporting, a
tax service, a certification practice bank, a sales CRM, LinkedIn verification, and a
Salesforce org integration. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js ≥ 18, CommonJS, no transpilation |
| HTTP | Express 4, `express-session` with a MySQL store |
| Views | EJS, server-rendered; Bootstrap 5 served from this origin plus a hand-written design system |
| Data | MySQL 8 via `mysql2`. **No ORM** — every model is a class of static methods issuing parameterised SQL |
| Schema | Forward-only numbered `.sql` migrations, applied by `scripts/migrate.js` under an advisory lock |
| Auth | First-party email + password, `bcryptjs`, server-side sessions. No OAuth, no JWT |
| Validation | `express-validator` on the server is authoritative; HTML5 attributes are hints only |
| Uploads | `multer` in memory, re-encoded by `sharp`, stored as `MEDIUMBLOB` in MySQL |
| Email | Resend over HTTPS (many hosts block SMTP ports) |
| Tests | Jest + Supertest |

---

## Getting started

Requires **Node 18+** and **MySQL 8**.

```bash
git clone -b claude/dynamichub-webapp-clone-4cmj1w https://github.com/egi20/Salesforce.git
cd Salesforce
npm install

cp .env.example .env        # Windows: copy .env.example .env
```

Edit `.env` and set at least `DB_USER`, `DB_PASSWORD` and `SESSION_SECRET`. Leave
`DB_NAME=salesforce_hub`.

```bash
npm run setup               # creates the database, migrates, seeds
npm run dev                 # http://localhost:3000
```

`npm run setup` is `db:create` + `migrate` + `seed`; run them individually if you prefer.
Seeded sign-in: `admin@example.com` / `Password123`.

> **This application needs its own empty database.** It cannot share one with another app.
> The migration runner refuses to start against a database that already has tables but no
> migration history, rather than mixing its schema into somebody else's.

**Payments in development.** Leave the three `STRIPE_*` variables unset and payments are
switched off: the pages render, and every checkout offers a "not switched on yet" path
instead of failing. To try the real flow, set `STRIPE_SECRET_KEY` and
`STRIPE_PUBLISHABLE_KEY` to your test keys, then run `stripe listen --forward-to
localhost:3000/payments/webhook` and put the `whsec_…` it prints into
`STRIPE_WEBHOOK_SECRET`. Without that secret the webhook rejects every delivery rather
than trusting an unsigned body — which is the right way round, but it does mean fulfilment
then depends entirely on the buyer landing back on the success page.

### Scripts

| Command | Does |
|---|---|
| `npm run setup` | create the database, migrate, seed — one-off, first run |
| `npm run db:create` | create the configured database if it does not exist |
| `npm start` | migrate, then serve |
| `npm run dev` | serve with nodemon |
| `npm run migrate` | apply pending migrations |
| `npm run migrate:status` | list applied and pending migrations |
| `npm run sync:categories` | bring community categories into line with the config |
| `npm run seed` | insert development data |
| `npm run wait-for-db` | block until the database accepts connections |
| `npm run validate-boot` | config, taxonomy, module and template checks — no database needed |
| `npm test` | Jest (with VM modules enabled — see CLAUDE.md) |
| `npm run lint` | ESLint |

---

## Decisions worth knowing before you change anything

**The schema is migrations, not self-healing DDL.** Numbered files under
`scripts/migrations/`, recorded in `schema_migrations` with a checksum, applied under a
MySQL advisory lock so two instances booting together cannot both apply the same file. An
applied migration is immutable: editing one is an error, you add a new file. Models never
create or alter their own tables.

**The role taxonomy has exactly one home.** `config/roleTaxonomy.js`. Adding or renaming a
role is one edit there. The integrity assertion runs at boot and fails the process if a
slug has no label or no base rate, because the alternative is a UI that half-works and
rate buckets that quietly flatten.

**One filter builder per browsable thing.** `Job.buildFilter` and
`ConsultantProfile.buildFilter` are used by the list view, its count, the facets and every
bulk mutation. Two builders drift, and a bulk action eventually operates on a different set
than the screen showed. The bulk endpoint additionally carries an `expectedCount`
interlock and returns 409 rather than acting on rows nobody saw.

**The rate index counts people, not rows.** De-duplication happens after filtering; a
bucket below three contributors keeps its count and loses its values; a suppressed month in
a trend is a gap, not a zero. All of it is pure functions in `utils/rateAggregation.js` and
covered by tests.

**An estimate must reconcile with itself.** `utils/sowEstimation.js` apportions man-days by
the largest-remainder method, so phase days and resource days each sum EXACTLY to the
headline total; every cost is `days × rate` on integers; and the calendar duration is the
sum of sequential phase durations rather than the whole effort divided by one fully-parallel
team. `reconciliationProblems()` re-checks all of that, and the route refuses to show or
store an estimate that fails — a quote whose own parts disagree is worse than no quote,
because the client will find the discrepancy.

**There is no open direct-message inbox.** Every conversation is anchored to a subject —
an application, or an enquiry about a specific job that one of the two parties owns. An
unanchored DM channel on a marketplace is a recruiting-spam vector, and anchoring means the
recipient always knows why they were contacted. Membership is a row in
`conversation_participants`, so "is this thread mine?" is a JOIN condition on every read
and write rather than a check a future query can forget.

**Never serve a document you have not opened.** DOCX, XLSX and PPTX are zip containers of
XML parts, and a subtly broken part produces a file that downloads fine and then fails to
open — which the recipient experiences as "you sent me a corrupt file". Every generator
runs its output through `utils/documents/validate.js`, which unzips it and strictly parses
every `.xml` and `.rels` part, before returning. A presence check for the expected parts
does not catch this; only a real parse does.

**The documents render the estimate, they never recompute it.** All three deliverables read
the same stored `quote.estimate`, so the document, the workbook, the deck and the web page
cannot disagree. A formatter that re-derives a percentage or re-rounds a cost is how a
client ends up quoting your own contradictory figure back at you.

**A saved quote is never recomputed.** The full breakdown is stored as it was presented,
with a `catalogue_version` fingerprint. Editing a base effort or a day rate later does not
rewrite what was already said to a client; the older quote is flagged as stale instead.

**Roles escalate in one direction only.** Public registration can create `consultant` and
`company` and nothing else. The self-service roles form is add-only and cannot demote an
admin. Removing a role or granting a privileged one is superadmin-only.

**Consent is never fabricated.** Only the public registration route stamps
`terms_accepted_at` and the accepted policy versions. Admin creation, seeds and tests pass
nothing. `users.created_at` is a `DATETIME` with an explicit default and no `ON UPDATE`,
so a registration date cannot be silently rewritten by an unrelated `UPDATE`.

**Durable bytes live in MySQL.** The host filesystem is assumed to be wiped on every
deploy. Images go into side tables keyed by owner, are re-encoded to WebP by sharp on the
way in, and are served ETag-cached from routes that answer a conditional request without
loading the bytes.

**`:id` params are validated as all-digits before they reach SQL.** `parseInt('44.map')`
is `44`; that is how a sourcemap probe once put a raw string into an `UPDATE`.

**Notifications are fire-and-forget with a stable dedupe key.** They can never fail the
action that triggered them, and undoing then redoing something cannot notify twice.

**A checkout price is never in the request.** `config/payments.js` holds one resolver per
product; it re-checks ownership and eligibility against the database and answers with the
amount. The route asks and never decides, so there is no submitted number to validate and
nothing to tamper with. Every amount is an integer of minor units, because a float euro
ends up a cent away from the sum of its parts.

**Payment idempotency is in the schema, not in a check.** The Stripe webhook and the
`/payments/success` page race by definition — Stripe fires the redirect and the delivery
independently — so `payments.stripe_session_id` is unique, every fulfilment table has a
unique key on `payment_id`, and an exclusive product's fulfilment table has one on its
subject too. That last key is the only thing that can catch two checkout tabs opened
against one quote, which are two different payments. Fulfilment is never gated on a
payment's own status. Money that cannot be fulfilled is flagged for a person to refund,
never reversed automatically from inside a handler.

---

## Layout

```
config/       env-derived config and the domain catalogues (roles, clouds, certifications, countries)
middleware/   auth guards, CSRF, error handling, uploads, rate limits, visitor geo
models/       one class per table group; all SQL lives here
routes/       one router per product area; guards and validation live here
services/     multi-model orchestration
utils/        pure domain logic: rate aggregation, matching, sanitising, pagination
views/        EJS templates and partials
public/       CSS design system, vanilla-JS islands, images
scripts/      migration runner, migrations, seeds, boot validation
tests/        Jest suites
docs/         roadmap and design notes
```

---

## Not affiliated with Salesforce

Salesforce, Sales Cloud, Service Cloud, MuleSoft, Tableau and Agentforce are trademarks of
Salesforce, Inc. This project is independent.
