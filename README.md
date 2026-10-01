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
| In-site assistant: site help on every page, with rate limits and a spend cap | built |
| Consultant tooling: delivery history, generated CV and rate card, contract rate calculator | built |
| Referrals: shareable link, append-only commission ledger, admin payouts | built |
| LinkedIn: confirm control of an account, link-only, no token stored | built |
| AI drafting of quote narratives, with every draft checked against the figures | built |
| Company document branding: colours, letterhead and standard clauses — no uploads | built |
| Search across jobs, consultants, companies and the community, through the same builders | built |
| Tax advisory: an introduction to a specialist, with consent and a retention period. No calculator | built |
| Daily challenge: five questions a day, graded on the server, with streaks and leaderboards | built |
| Recruitment agencies: a third account role, agency profiles and a public directory | built |
| Success stories and member reviews, moderated and never deleted | built |
| Sales CRM: leads with a required source, a permanent do-not-contact list, drafted outreach | built |
| Finance: invoices numbered under a lock and never deleted, costs, and a profit and loss | built |
| Moderation: hide and restore community content, void a bad rate submission, audit log | built |
| Admin: users, jobs, moderation, analytics, settings, error log, payments, AI spend | built |
| SEO: canonicals, JobPosting JSON-LD, sitemap generated from the robots allowlist | built |

Deliberately not built yet, and listed so nobody mistakes the scope: record
deduplication, email digests, a certification practice bank, and a Salesforce org
integration. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

Deliberately not built at all: a tax savings calculator, an invoice template anybody can
upload, and any path that sends a message to a sales lead on its own. The CRM drafts; a
person sends. The tax advisory pages introduce people to a specialist and say so; they
compute nothing, and neither does the finance area — a VAT rate on an invoice is one the
issuer stated. See **Tax advisory** in
[`CLAUDE.md`](CLAUDE.md) for why a number that looks like tax advice but is a guess is
worse than no number.

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

**The assistant in development.** Leave `ANTHROPIC_API_KEY` unset and it is switched off
completely: no widget is emitted into any page, and `/assistant/chat` answers 503. To try
it, set the key and — importantly — set `AI_MONTHLY_BUDGET_USD` to a number you would be
willing to see on an invoice. `/admin/ai` shows spend against that cap.

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
| `npm run purge:expired` | delete records past their declared retention period |
| `npm run seed` | insert development data |
| `npm run wait-for-db` | block until the database accepts connections |
| `npm run validate-boot` | config, taxonomy, module and template checks — no database needed |
| `npm run preflight` | what this deployment is NOT doing, and whether that is survivable — run it before deploying |
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

**The rate calculator does not compute tax, and that is the point.** Tax depends on
jurisdiction, entity type, VAT status and how someone pays themselves. A figure that looks
like tax advice but is a guess is worse than none, because people act on it. Everything it
shows is before tax and says so; a test asserts the module exposes nothing tax-shaped. Its
two directions — rate to net, and target to required rate — are one formula, so they cannot
drift, and the whole projection is reconciled before it renders.

**A generated CV renders the profile; it never writes prose.** No summary, no rephrasing,
no invented profile statement. The reference implementation put a language model here; what
that buys is fluent text about a career the model does not know, and what it costs is a
sentence the consultant never wrote in a document they send to a client.

**Search adds no filter builder.** It calls the same `browse` each list view calls, so a
row hidden on `/jobs` is hidden in search without the search code knowing why — and the
count next to "see all 43" is the count that page delivers. Results are grouped by type
with no cross-type relevance score, because a match on a company name and a match inside a
long post are not comparable and a blended ranking would be invented precision.

**Company branding is configured, never uploaded.** A company sets its colours, letterhead
and standard clauses; the Hub's own validated generators render with them. Accepting a Word
template would mean serving back a file we did not build — one that can carry macros and
remote references — and usually storing a real person's CV as the "sample". A brand colour
must clear 4.5:1 against white or it is refused with its measured ratio, which is
`DESIGN.md`'s contrast rule enforced rather than remembered.

**A generated narrative may not contain a figure the estimate does not.** AI drafting
writes the prose sections of a quote — summary, approach, assumptions, risks — and every
draft is checked before anyone sees it: any numeral absent from the stored estimate fails
it, and a failing draft is discarded with its reasons shown rather than silently retried.
The model is never handed a day count, a cost or a rate, so it cannot repeat one. Drafts
live in their own table with no code path to `quotes.estimate`, and nothing reaches a
document until the author reads it, edits it and accepts it.

**The LinkedIn badge says exactly what was checked.** LinkedIn's userinfo response carries
a name and no vanity URL, headline or positions, so the badge reads "LinkedIn confirmed" —
control of an account — and the profile link stays labelled as a claim. The integration
links only, never signs anyone in, and the access token is discarded after one call because
the site never posts to LinkedIn.

**A commission balance is a SUM, never a stored number.** `commission_ledger` is
append-only and signed, in minor units, with a unique dedupe key per entry; the balance is
derived from it. A cached total alongside the rows that produced it is unauditable the
moment the two disagree, and this is money somebody is owed. Commission is credited when a
payment is actually received, attribution is first-touch and permanent, and a refund never
claws one back automatically — that takes a person and a reason the referrer can read.

**Content is hidden, never deleted.** A hide is reversible, keeps the row so counters and
foreign keys stay consistent, and is written to an append-only log — so "who took this down
and why" always has an answer. Hiding a reply corrects `posts.reply_count`, un-solves the
question if it was the accepted answer, and reverses the points, all in one transaction.
Points adjustments key on the moderation event rather than the content, because the ledger
is idempotent on its dedupe key and a content-keyed restore would be silently ignored.

**A voided rate submission is excluded from every aggregate, with no way to turn that
off.** One figure entered in the wrong unit moves a published percentile for everybody, and
nothing raises. There is deliberately no path to correct a value.

**A public endpoint that spends money needs a cap that is not a rate limiter.** The
assistant answers anonymous visitors, so it carries three independent bounds: per-IP rate
limiting keyed on the IP (never the session id — with `saveUninitialized: false` a
cookie-less flood gets a fresh session per request and a session-keyed counter protects
nothing), a process-wide backstop, and a month-to-date spend cap read from the `ai_usage`
ledger. Only the last one bounds the aggregate. It fails open and logs loudly, because an
unreadable ledger must not be an outage.

**A model reply is never parsed as markup.** `public/js/assistant.js` builds every node
with `createElement` and validates each link against a same-origin relative-path
allowlist. Model output is attacker-influenceable text; rendering it through `innerHTML`
— even "just for the links" — turns a prompt-injected reply into stored XSS on every page.

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
docs/         roadmap, design notes, and the assistant's knowledge base
```

---

## Not affiliated with Salesforce

Salesforce, Sales Cloud, Service Cloud, MuleSoft, Tableau and Agentforce are trademarks of
Salesforce, Inc. This project is independent.
