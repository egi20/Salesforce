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
| Notifications, saved jobs, dashboards | built |
| Admin: users and roles, jobs, error log, visitor geography | built |
| SEO: canonicals, JobPosting JSON-LD, sitemap generated from the robots allowlist | built |

Deliberately not built yet, and listed so nobody mistakes the scope: AI document
generation, payments and invoicing, referral commissions, a community forum, record
deduplication, finance/P&L reporting, a tax service, a certification practice bank, a
sales CRM, LinkedIn verification, and a Salesforce org integration. See
[`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js ≥ 18, CommonJS, no transpilation |
| HTTP | Express 4, `express-session` with a MySQL store |
| Views | EJS, server-rendered; Bootstrap 5 from CDN plus a hand-written design system |
| Data | MySQL 8 via `mysql2`. **No ORM** — every model is a class of static methods issuing parameterised SQL |
| Schema | Forward-only numbered `.sql` migrations, applied by `scripts/migrate.js` under an advisory lock |
| Auth | First-party email + password, `bcryptjs`, server-side sessions. No OAuth, no JWT |
| Validation | `express-validator` on the server is authoritative; HTML5 attributes are hints only |
| Uploads | `multer` in memory, re-encoded by `sharp`, stored as `MEDIUMBLOB` in MySQL |
| Email | Resend over HTTPS (many hosts block SMTP ports) |
| Tests | Jest + Supertest |

---

## Getting started

```bash
git clone <this repo>
cd Salesforce
npm install

cp .env.example .env
# Fill in DB_* and SESSION_SECRET.

mysql -u root -e "CREATE DATABASE salesforce_hub CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

npm run migrate        # apply the schema
npm run seed           # optional: demo data
npm run dev            # http://localhost:3000
```

Seeded sign-in: `admin@example.com` / `Password123`.

### Scripts

| Command | Does |
|---|---|
| `npm start` | migrate, then serve |
| `npm run dev` | serve with nodemon |
| `npm run migrate` | apply pending migrations |
| `npm run migrate:status` | list applied and pending migrations |
| `npm run seed` | insert development data |
| `npm run wait-for-db` | block until the database accepts connections |
| `npm run validate-boot` | config, taxonomy, module and template checks — no database needed |
| `npm test` | Jest |
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
