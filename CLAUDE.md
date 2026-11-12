# Working on this codebase

Operational notes for anyone — human or agent — changing this project. These are the
things that are not obvious from reading the code, and each one is here because getting it
wrong produced a real bug.

## Ground rules

- **The schema is migrations.** Never add `CREATE TABLE` or `ALTER TABLE` to a model. Add a
  numbered file under `scripts/migrations/`. An applied migration is immutable — the runner
  compares checksums and refuses to start if one changed. Correct a mistake with a new file.
  Two files share the number 042 (`042_admin_test_cases`, `042_tax_program`): two branches
  each took the next number and both were applied before they met. The runner orders by full
  filename and records each by name, so that is harmless — and renaming either would make it
  run again where it is already applied. Do not "fix" it; just take the next free number.
- **All SQL is parameterised.** Filter clauses are assembled from fixed fragments plus a
  `params[]` array. No value is ever interpolated into a query string.
- **Never add a second filter builder.** `Job.buildFilter` and
  `ConsultantProfile.buildFilter` are the only ones. A list view and a bulk mutation must
  provably target the same rows.
- **Validate `:id` params with `requireIdParam`.** `parseInt('44.map')` is `44`.
- **Salesforce Hub owns its database.** It does not share a schema with any other
  application. `scripts/migrate.js` refuses to run when the target database already has
  tables but no migration history, because that means DB_NAME points somewhere else — and
  the bare "Table 'users' already exists" it would otherwise produce reads like a bug in the
  migration rather than a misconfigured connection.
- **The error handler must never respond twice.** `middleware/errorHandler.js` checks
  `res.headersSent` and delegates to Express when the response has already started.
  Writing a second status line throws ERR_HTTP_HEADERS_SENT and buries the original error.
  This is reachable whenever something fails mid-stream — a download, or a session store
  failing asynchronously after the response is out.
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

**A CSRF refusal from a scanner is answered and NOT logged** (2026-11-06, ported from SAP
Hub, whose production log was nothing else). `isScannerCsrfRefusal` in the error handler: a
refusal on a path no route answers is never recorded (`utils/routeExists.js` walks Express's
own router and answers YES when unsure); nor one without the `sfhub.sid` cookie; nor one with
the cookie from somebody not signed in whose browser sent no `Sec-Fetch-Site`. Headless-browser
scanners send the cookie AND the header, which is why the route check comes first. A real form
failing for a real person is still recorded.

**Fixed errors are deleted by filter** (`POST /admin/errors/delete-matching`, superadmin). The
error log has ONE filter builder, `ErrorLog.buildFilter`, used by the list, its count, the
export and the delete, so the rows deleted are provably the rows listed. An unfiltered delete
is refused (the age-window purge is for that), a count that no longer matches what the page
showed deletes nothing, and the delete is bounded by the highest id counted.

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

**`/rates` shows three kinds of figure and labels every one** (2026-11-08): the EDITORIAL
benchmark, COMMUNITY data and JOB POSTINGS. They are never blended.

- **The editorial model is `config/rateModel.js` + `utils/rateBenchmark.js`**, ours, under
  version control and printed in full under Methodology: `BASE_DAY_RATES` × the seniority
  multiplier (the experience brackets ARE the seniority bands) × a region multiplier ×
  (1 + basis-point adjustments), to €5, ∓ `SPREAD_BPS`. `benchmarkProblems` re-checks the
  working shown against the figure shown and the route throws a 500 on failure, as quotes do.
  None of Dynamics Hub's figures are reused; a test pins the ones that must differ. Monthly,
  annual and equivalent salary come from `contractorEconomics.project` — never `rate × 220`.
- **Trend windows** (`TREND_WINDOWS`): 12 months reads the stored `period`; 12 weeks and 30
  days bucket by `updated_at`. Every bucket still goes through `trendSeries`, so a short
  window has more gaps, never zeros. The chart is server-drawn SVG (`utils/rateCharts.js`)
  and a gap BREAKS the line. "Asked on applications" is `meanOfPeople`: one figure per
  consultant, same floor.
- **Job figures go through `Job.buildFilter`** with `rate_published`, so a closed, expired,
  taken-down or rate-hidden advert is never counted. They are public already, so no floor —
  but every figure has its posting count beside it.
- **Sharing is inline** (`POST /rates/submit`, `GET /rates/submit` → `/rates#share`): five
  answers; the seniority is DERIVED from the years with `seniorityForYears`; country is
  optional and work mode no longer asked (migration 043 made both nullable rather than let
  a default record "remote" for everybody). A contract figure above €5,000/day or a permanent
  one below €5,000/year is refused by name — the wrong-unit figure is the one that moves a
  percentile for everybody.
- Every GET form on the page carries the others' state through `keepExcept`, built only from
  validated values, so changing one filter never resets another and nothing raw is echoed.
- **The trend's axis starts at the first period with any contributor**, and below two
  published points the card says "Trend appears after two months of data" and lists the
  periods so far. Leading periods with NO contributors are not gaps (there was nothing to
  suppress), so trimming them hides nothing; a period with contributors below the floor is
  still a gap. The count axis has headroom so a full bar never sits on the € axis label.
- **Equiv. salary is labelled "before employer contributions"** wherever it appears. It is
  revenue less a contractor's running costs; an employer would add its country's social
  contributions on top, and those vary by country, so they are named, not guessed.
- "Rate benchmarks by role" shows ten chips ranked by open jobs + contributors, the rest
  behind "All roles". Day-rate budgets say per row how many postings they come from: with
  one posting the range is that advert's own, which is public but is not an aggregate.

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

**The running total on `/quotes/new` is the engine, asked.** `POST /quotes/preview` reads the
form with the same `inputsFrom` and `optionsFrom` the save uses and runs `calculateEstimation`,
reconciliation check included; it stores nothing and has its own limiter. There is no copy of
the formula in `public/js/quote-form.js`, and a test asserts the file holds no multiplier, no
effort figure and no rate: a second implementation in the browser is the one place the figure
on screen and the figure in the stored quote could disagree, and the first change to
`config/estimation.js` would make them. The four steps are a reading aid over ONE form —
without scripting every step shows and the button at the bottom submits all of it. The form
sits under `#wizard`, below the page's own introduction; a refused save or a reused quote
re-renders the whole page, so the script scrolls back to the form (`data-focus-wizard`).

The form is read in `utils/quoteFormInputs.js`, both ways: `inputsFrom` (form → estimator
input) and `valuesFromQuote` (stored quote → form), and a test round-trips a quote through
both. That is what "Reuse details from your last quote" stands on — it reloads the form from
the author's OWN quote (any other reference is treated as absent) and saves a NEW quote; the
original, a statement made on a date, is never touched. Catalogue lookups there use
`hasOwnProperty`: `COMPLEXITY_MULTIPLIERS['__proto__']` is truthy.

"Download SOW pack" on the Review step SAVES first and then lands on the quote's page, which
starts the download once (and drops the query string so a reload does not repeat it). A pack
is always generated from a stored quote, never from a form; landing on the page means the
author sees what was saved and a second click does not save a second copy.

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

## Salesforce news of the day

**It leads the first page of the home feed** (owner, 2026-11-08; ported from SAP Hub). It is
READ from the Salesforce Newsroom's feed (`services/salesforceNews.js`, `SALESFORCE_NEWS_FEED_URL`,
default `https://www.salesforce.com/news/feed/`), never written here: a news card the Hub typed
would be a second newsroom nobody owns. The page never waits on Salesforce — a render reads the
cache, and a stale or empty cache starts a background refresh (also once at boot, never in
tests); a failed refresh keeps the last good copy. Links are host-pinned to salesforce.com over
https (an item pointing elsewhere is dropped); tags are stripped and entities decoded in the
service and the template escapes the rest, so no HTML from somebody else's feed reaches the
front page. One pick a day, rotating through the ten newest by the server's UTC date, so
everybody sees the same one; the others are a carousel (`public/js/news.js`, a list of links
without scripting). A refresh failure is one `Salesforce news:` line in the log.

**The fallback is a pointer, not a headline.** SAP Hub keeps three checked, dated headlines in
its fallback; `config/salesforceNews.js` keeps none — one item that links to the newsroom itself
and carries no date, and the card then says "Salesforce news", never "of the day". A headline
written from memory is the thing most easily remembered wrong, and on the front page it is a
claim made in somebody else's name. A test holds the fallback to that shape.

## Community and points

One `posts` table with a `kind` discriminator — article, question, discussion, win. They
differ in presentation and affordances (only a question can be solved), not in what they
store. Four near-identical tables would mean four of every query and a feed built on a
UNION no index serves well.

Counters (`reply_count`, `vote_score`, `last_activity_at`) are maintained in the SAME
transaction as the row they count. That is what lets the feed render without aggregating.

**Voting recomputes the score, it does not increment it.** An increment is wrong the moment
a vote is CHANGED rather than added — the delta is 2, not 1 — and that error drifts
silently forever. `Post.vote` re-sums `post_votes` inside the transaction.

**The points ledger is append-only.** A `points` column on the user row would be
unauditable: nobody could say where a total came from, and a double award could never be
found. Reversals write a compensating entry rather than deleting the original, so a total
CAN go negative — `levelFor` clamps for that, and its "next level" is the one above the
current band, not the first threshold above the total.

Every award carries a `dedupe_key`, so an event can never pay twice however many times its
emitter runs. The scheme deliberately pays far more for an accepted answer than for a post:
one that pays for volume gets volume.

The category tree is DERIVED from `config/cloudFamilies.js`, so adding a cloud adds a
category. `npm run sync:categories` reconciles them and runs from `npm start` beside the
migrations; a category dropped from the config is deactivated, never deleted, because posts
point at it.

## Payments

Two products, and the shape is what matters more than either: a payment names a PRODUCT
and a SUBJECT, and the subject is a row the payer demonstrably owns.

**The price is never in the request.** `config/payments.js` holds a resolver per product;
it re-checks ownership and eligibility against the database and answers with the amount.
A route asks; a route never decides. This is the reference implementation's "C3"
price-tampering finding, closed structurally rather than by validating a submitted number.

Every amount is MINOR UNITS as an integer — Stripe speaks minor units, invoices reconcile
line by line, and a float euro ends up a cent away from the sum of its parts.

**Idempotency lives in the schema, not in a code path.** The webhook and the `/success`
page race by definition, because Stripe fires the redirect and the delivery independently.
So:

- `payments.stripe_session_id` is UNIQUE — one checkout, one payment.
- every fulfilment table has a UNIQUE key on `payment_id` — fulfilling twice for one
  payment is a duplicate-key no-op.
- a fulfilment table for an EXCLUSIVE product also has a unique key on its SUBJECT
  (`quote_deposits.quote_id`). That is the guard the per-payment key cannot give: two
  checkout tabs against one quote are two DIFFERENT payments, and only one may settle it.

**`billingDetailsFor` selected two columns that have never existed.** It asked for
`u.first_name, u.last_name` when `users` has one `name` column, which MySQL answers with
ER_BAD_FIELD_ERROR — inside the transaction every invoice is raised in. Every payment would
have failed at the invoice step the first time one was taken for real. Nothing caught it: the
suite mocks the database so the query never ran, no live payment has been taken because
Stripe is not configured, and a unit test asserted `displayName({first_name, last_name})` and
passed for an unrelated reason. It surfaced the first time a fulfilment was driven end to end
against a real MySQL. A test now scans `models/`, `services/` and `routes/` for either column.

`Payment.markPaid` is a CLAIM, not a setter: a conditional UPDATE that reports whether
this call moved the row. It decides who sends the receipt and nothing else. **Never gate
fulfilment on a payment's status** — that was the reference's worst payment bug, where the
success page flipped the row to complete without creating anything and the webhook then
skipped fulfilment because the row already looked done.

A payment that arrives for a subject someone else already settled is flagged
`needs_refund` and appears in `/admin/payments`. It is **never** auto-refunded: reversing
a charge from inside a webhook handler is an irreversible act on a partial view of the
world.

The webhook route is arranged in `server.js`, not in `routes/payments.js`, and all three
parts are load-bearing: `express.raw` mounted BEFORE the body parsers (the signature
covers the exact bytes Stripe sent), the CSRF `exempt` predicate (it has no browser and no
session; the signature is the stronger check), and `WEBHOOK_PATH` shared from
`config/payments.js` so the two can never point at different paths. It answers **200 for
events it ignores** — a non-2xx tells Stripe to retry, so an error for "not interesting"
is an infinite redelivery loop.

With no `STRIPE_SECRET_KEY` the module loads, `isConfigured()` is false and checkout
offers a "not switched on" path, the same way `utils/email.js` degrades to logging.
`STRIPE_WEBHOOK_SECRET` is different: unset means the webhook refuses every delivery
rather than trusting an unsigned body.

Featured job windows are ADDITIVE — buying again extends rather than collides — which is
why `job_features` deliberately has no unique key on `job_id`. Whether a job is featured
is asked at read time with an EXISTS over the window, never cached in a column on `jobs`:
a boolean would need something to come round and unset it, and the day that job fails to
run is the day someone keeps a placement they stopped paying for.

## The in-site assistant

Open to anonymous visitors on purpose — most of what it answers is asked before anyone
signs up. That makes it a PUBLIC endpoint that spends money per request, and everything
about its design follows from that.

**Three independent bounds, and only one of them caps the bill.**

1. Per-IP rate limiting. Keyed on the IP and **never** on the session id: with
   `saveUninitialized: false` a cookie-less flood gets a fresh session id per request, so
   a session-keyed counter never accumulates. On a paid endpoint that is not a
   rate-limiting bug, it is a way to run up someone else's bill.
2. A process-wide backstop (`globalLimiter`), because a distributed flood keeps every
   individual address politely under the per-IP limit.
3. `utils/aiBudget.js` — month-to-date spend against a cap, read from the shared
   `ai_usage` ledger. This is the only one that bounds the aggregate.

The budget check **fails OPEN** and says so in the log. An unreadable ledger must not
become a site-wide outage of the feature; the failure mode of failing closed is worse than
a few minutes uncapped. And because a call's cost is only known once it returns, the cap
is always crossed by at most one exchange — which is why the caps are set well below the
number that would hurt.

**Token counts come from the API response, never from a local estimate.** A
character-count guess ignores the cached prefix and the tokeniser, and a budget built on a
guess cuts off at a number nobody can reconcile with the invoice. `ai_usage.cost_usd` is
`DECIMAL`, not `FLOAT`: the column is summed to decide whether to stop spending.

**The system prompt is split in two, and the split is the point.**
`utils/assistantPrompt.js` composes the long half ONCE at module load and it must stay
byte-identical — it is sent with `cache_control` and anything interpolated per request
(a timestamp, a path, a name) misses the cache on every exchange and multiplies the input
cost of the whole feature. The per-viewer half is appended after it. Only the account's
SHAPE goes in that half — signed in or not, which roles — never a name, an email or an id:
none of it improves an answer about how the site works, and all of it would be personal
data leaving for a third party on every message.

`docs/assistant-knowledge.md` is the only thing it knows about the site. **Edit it in the
same commit that adds or moves a page.** An assistant confidently sending people to a
route that no longer exists is worse than one that says it does not know.

**A reply is rendered from DOM nodes only — never `innerHTML`.** Model output is
attacker-influenceable text: whatever a visitor types can steer it. Parsing it as markup
turns a prompt-injected reply into stored XSS on every page, and rendering markdown "just
for the links" through `innerHTML` is exactly how that happens. `public/js/assistant.js`
builds each anchor with `createElement` and validates its `href` against a same-origin
relative-path allowlist; anything that fails renders as plain text. A test asserts the
file contains no `innerHTML` at all.

**There are no conversation tables.** History lives in the visitor's `sessionStorage` and
is posted back with each message, then capped and re-validated server-side — the array is
cut BEFORE it is walked, because a hostile request can carry tens of thousands of entries
inside the JSON body limit. A `role` that is not `user` or `assistant` is dropped, not
repaired: it is someone probing for a way to write into the system prompt.

With no `ANTHROPIC_API_KEY` the widget is **not emitted into the markup at all** — not
hidden with CSS, not gated by a flag the client could flip — and `/assistant/chat` answers
503. Unlike the Stripe webhook, this endpoint is NOT CSRF-exempt: it is an ordinary POST
from a page on this origin.

## Moderation

Content is **HIDDEN, never deleted**, and `models/Moderation.js` is the only module that
touches the flags. Three reasons, in order of how much they cost when ignored:

1. A hide is reversible. Deleting is not a decision anyone should be able to take in one
   click from a list view, and a moderator who cannot undo will not act at all.
2. The row survives, so denormalised counters, foreign keys and the points ledger stay
   consistent. A reply that vanished from under `posts.reply_count` would leave the counter
   permanently wrong, and nothing recomputes it.
3. `moderation_events` is append-only. "Who did this, when and why" must always have an
   answer; an undo is another row.

**Hiding a reply moves three things in the same transaction** — `posts.reply_count`, the
accepted-solution mark (a question must never point at content nobody can read), and the
points. That is why there is no bare `UPDATE post_replies SET hidden_at` anywhere.

**Points adjustments are keyed on the moderation EVENT id, not on the content id.**
`points_ledger.dedupe_key` is unique and every insert is an `INSERT IGNORE`, so a key
derived from the post id would make hide → restore take the points away once and never
give them back — the restore's insert would be silently ignored. A new event id per action
makes each half of each cycle its own ledger entry.

The exclusion of hidden posts lives **inside `Post.buildFilter`**, with `include_hidden`
as the single explicit opt-in used only by the moderation screens. Same rule as ever: one
builder, so a list and its count cannot disagree about what is in scope.

**A voided rate submission is a different thing from a hidden post.** It is not moderation
of speech, it is excluding a figure from an average: one annual salary typed into a
day-rate field moves a published percentile for everybody, silently.
`RateSubmission.rowsFor` hard-codes `voided_at IS NULL` with **no option to turn it off**,
and there is deliberately no path to correct a value — an aggregate whose inputs an
administrator can retype is an aggregate nobody should trust. `/admin/rates` is
superadmin-gated because it is the one screen that shows individual figures next to the
people who gave them.

## Settings

`config/settings.js` declares every runtime-editable setting, and that list is provably
the whole surface: `AppSetting.setMany` iterates the DECLARED keys, never the submitted
body. That also fixes the checkbox problem — an unticked box posts nothing, so a
body-driven loop would leave every switch that was turned off silently on forever.

Look up definitions with `isValidKey`, never with a truthiness check on the lookup:
`DEFINITIONS['__proto__']` is `Object.prototype`, which is truthy, and a plain
`if (!definition)` guard lets a request carrying `__proto__` through to the write path.

**A setting is an operational switch, never a catalogue value.** Roles, cloud modules,
phase percentages, day rates and prices stay in `config/*.js` under version control, where
a change has an author, a diff and a review. `RATE_MIN_SAMPLE` is an environment variable
for the same reason: lowering the privacy floor should be a deployment decision, not a
checkbox that makes a sparse index look fuller.

`AppSetting.all()` falls back to the declared defaults instead of throwing — the site
notice is read on nearly every request, and a hiccup in a table holding three rows must
not take down every page. The switches are enforced as middleware
(`middleware/settingsGates.js`) so that turning one off closes every door at once; a gate
written into three of four write handlers is a gate that is off.

## Consultant documents and the rate calculator

`utils/contractorEconomics.js` is pure, for the same reason `utils/sowEstimation.js` is,
and it carries one refusal that shapes everything else: **it does not compute tax.** The
reference implementation shipped a `calculateTaxSavings` that compared a hard-coded 30%
against a hard-coded 5% and presented the difference as a saving. Tax depends on
jurisdiction, entity type, VAT status and how someone pays themselves; a number that looks
like tax advice but is a guess is worse than no number, because people act on it. A test
asserts the module's surface exposes nothing tax-shaped, so nobody adds one in passing.

Its invariants, re-checked by `reconciliationProblems()` before the page renders, exactly
as `routes/quotes.js` re-checks an estimate:

1. Billable days = working days − every named non-billable category, EXACTLY.
2. Net = revenue − costs, on integers.
3. `rateForTarget` is the exact inverse of `project` under the same assumptions. A rate
   round-tripped through both must come back unchanged — two directions, one formula.

Non-billable days are NAMED (holiday, illness, bench, admin, training) rather than rolled
into one utilisation percentage: 80% sounds fine until you notice what it has to cover.
The market comparison READS the index's own answer so the privacy floor is applied once,
in `utils/rateAggregation.js`; a suppressed bucket arrives as a null median and is shown as
"not enough contributors", never as a zero.

The calculator is public and **stateless**. Its inputs are somebody's private financial
assumptions and there is no reason to hold them; the whole state is in the query string,
which also makes a working-through shareable.

`utils/documents/cvDocx.js` and `rateCardDocx.js` follow the same two rules as the quote
generators: **render, never recompute**, and **open it before anyone else has to**. The CV
formats the dossier from `services/consultantDossier.js` and writes no prose of its own —
no summary, no rephrasing, no "profile statement". The reference put an LLM here across
four thousand lines; what that buys is fluent text about a career the model does not know,
and what it costs is a sentence the consultant never wrote in a document they send to a
client.

Layout decisions that are deliberate: delivery history before employment (for a contractor
the engagements are the substance and the employing entity is often an agency), no photo or
date of birth (discrimination surface, and the Hub has the photo and chooses not to use
it), one column (two-column CVs are what shred in a recruiter's parser). An expired
certification is LABELLED, never dropped — hiding it conceals from the consultant exactly
what a client is about to check.

`filenameFor()` slugifies the consultant's NAME. Unlike a client name typed into one form,
this lands in a `Content-Disposition` header on every download they make.

Documents are generated on demand and never stored: a profile changes, and the stale copy
is the one someone would eventually send.

**The CV preview IS the document.** `utils/documents/cvLayout.js` decides what a CV contains
— sections, order, every line — as plain blocks, and both renderers only lay them out:
`cvDocx.js` as Word paragraphs, `views/cv/_preview.ejs` as HTML. Two renderers each deciding
content would drift the first time one gained a line, and the consultant would download
something other than what they approved. A test asserts every previewed string reaches the
.docx. The rate is off by default when the profile keeps it "on request".

The dossier turns the stored bio and descriptions back into plain text with
`richTextToEditable`: they are sanitised HTML since the profile form escapes and paragraphs
them, and the generator was printing `<p>` into every CV.

`/cv-generator` is the consultant's page and `/services/document-generator` the company's SOW
pack. They were one page whose only button was "Start a quote", which is where a consultant
following "CV Generator" landed. The Hub writes no cover letter — that is prose, and a
generator that writes prose stops rendering the consultant's own claims.

The SOW pack is introduced in ONE place: `/quotes/new`, above the form — How it works,
Supported Salesforce clouds and What's included in the SOW, as partials (`views/partials/sow/`)
fed by `config/sowPack.js`. `/services/document-generator` keeps only what is its own: the three
file cards, why they agree, and a sample timeline. Both pages once carried the same three
sections, which was two places to disagree; a test asserts the pack page restates none of
them. "Get SOW Quote" links to `/quotes/new#wizard` (the form); "SOW Generator" to the top. Each line of `SOW_SECTIONS` names the heading in
`sowDocx.js` that produces it; a test asserts every heading is really there. "Acceptance criteria" is listed because section 2.2 now WRITES it — the phase, its
milestone from the stored timeline and `PHASE_ACCEPTANCE` from `config/estimation.js` (words,
no figures, asserted for every phase at boot). It was added to the document before it was added
to the page; the other order is a page promising a section the download does not have. 2.2 is
a sub-section so nothing after it is renumbered. Optional sections say when they appear. The
three cloud cards are `CLOUD_GROUPS` in `config/cloudFamilies.js`, and `cloudGroupProblems()`
fails a test if a cloud is in no group or two.

The SOW pack page names what is IN each file rather than counting it — a count with no list
behind it ("seven slides") is a claim a reader cannot check, and it was. `PACK_CARDS` lists each
file's contents, and a test reads the SOW's numbered headings, `addWorksheet` and `addSlide`
from the generators and fails if a card stops naming one. Its sample timeline is computed at load by
`calculateEstimation` and held to `reconciliationProblems`, the same as a real quote. A
product page that draws its own Gantt by hand is a promise the download does not have to
keep. A CV section with nothing in it (no Trailhead, no rate) is shown unticked and disabled,
and a thin profile previews as grey bars, never as sample words.

## Referrals and commissions

**The ledger IS the balance.** There is no cached total on the referrer row —
`Referral.balanceFor` is a SUM over `commission_ledger`, exactly as a points total is a SUM
over `points_ledger`, and here the reason is stronger because this is money somebody is
owed. The reference implementation kept `pending_earnings`, `total_earnings` and
`paid_earnings` alongside the rows that produced them; the first time a crash lands between
two statements, nobody can say which number is right.

**Integers, minor units, basis points.** A rate is `rate_bps` (1000 = 10.00%), so
`amount_minor * rate_bps / 10000` is exact. The reference stored a DECIMAL percentage and
reconciled payouts with `parseFloat` plus a `+ 0.001` tolerance in every comparison — that
tolerance is the bug made visible. `commissionMinor` is strict about the TYPE, not just the
value: a numeric string means a caller handed it unvalidated request data, and coercing it
is how a form field becomes a liability. It rounds DOWN, because rounding a debt up by
default puts a balance above what the ledger can cover.

**Commission is credited on money RECEIVED.** `Referral.credit` is called from
`services/paymentFulfilment.js` and nowhere else, outside the fulfilment transaction: a
bookkeeping failure must not roll back what the customer paid for. It never throws and is
idempotent on `earn:<payment id>`, so the webhook and the success page racing produce one
entry.

**A zero entry is still written** when the product pays nothing. "Your introduction bought
something and it earned nothing" is information the referrer is owed; a gap is what
produces the email asking where their money went.

**Attribution is first touch and permanent** — `UNIQUE (referred_user_id)` makes a second
attribution a no-op. Last touch would let anyone claim someone else's introduction by
getting a link in front of them the day before they pay. The rate and the earning window
are SNAPSHOT on the attribution row, so renegotiating a rate or extending the window never
reprices an introduction made under different terms. Self-referral is refused before
anything is written; there is no path that creates one to clean up later.

**A payout settles the whole unpaid balance**, never an amount someone types. The reference
matched a requested figure against unpaid rows FIFO and produced refusals like "requested
€3 cannot be matched exactly by unpaid commissions" — a problem created entirely by that
design. `payout_id` is the one column on the ledger that is ever updated, and only from
NULL, inside the transaction that locks the rows.

**No automatic clawback.** A refund does not silently reverse a commission. `Referral.adjust`
writes a compensating entry and requires a human and a reason the referrer will see, for
the same reason `needs_refund` on a payment is a queue rather than an API call.

Which products pay is named in `config/referrals.js`, not inferred: adding a product to
`config/payments.js` must not silently create a liability.

## The referrals page and the sales agent dashboard (2026-11-09)

**`/referrals`** shows what a member's link did, never WHO it brought: an introduction is a date,
a role and an amount. `Referral.introductionsFor` selects the role flags from `users` and nothing
else of theirs, and a test reads the query and the view for name, email or country. Link opens are
counted in `/referrals/go/:code` by the agent link's rule — `looksLikeAPerson`, `LINK_PREVIEW` (now
both in `middleware/visitGeo.js`), once per session — into `referrers.link_opens` (migration 046).
The two tabs are server-side (`?tab=earnings`), so they work without scripting and keep their own
pagination.

**Each agent also has a TAX link, `/t/<code>`** (owner, 2026-11-12, on all three hubs): the
SAME code as the sign-up link, landing on `/tax-optimization`. It remembers the code in the
session exactly as `/s/` does (so a later registration is still credited) and an unknown or
paused code still lands on `/tax-optimization`. Opens go to `sales_agent_tax_opens` (migration
047, agent + `opened_at` only) via `countTaxOpenOnce` in `utils/salesAgentOpens.js` — the same
person/preview filters, once per session per agent in its OWN session list
(`salesAgentTaxOpens`), so one link never uses up the other's open. **Unlike `/s/`, a signed-in
visitor counts** (the programme is for people who already have an account) — except the agent
themselves (`shouldCountTax`). There is no lifetime counter: the table IS the count, and
`SalesAgent.listAll`/`statsFor` read `tax_opens` + `tax_opens_24h`. Shown as "Tax opens" /
"Tax opens (24h)" on the agents tab (copyable `/t/` link under the sign-up one), in each agent's
modal, and on `/referrals/agent`. Pinned by `tests/unit/agentTaxLink.test.js` and
`tests/unit/salesAgentCountries.test.js`.

**Sales agents now earn commission, and that is the owner's decision, not drift.** Migration 031
said an agent's link "pays nothing"; on 2026-11-09 the owner decided agents earn a share of what
their sign-ups PAY for tax optimization or a SOW quote. Everything about it follows the referral
rules: credited on money received by `SalesAgent.credit`, called beside `Referral.credit` in
`services/paymentFulfilment.js`, never throwing, idempotent on `agent_commission_ledger.payment_id`
(UNIQUE), the rate SNAPSHOT on the row, the same `commissionMinor` cap and the same finite window
from sign-up. The agent ledger is its own table — `models/SalesAgent.js` must never write the
referral `commission_ledger`, and a test holds that. Tax optimization has no payment product yet,
so its row is shown with nothing counted rather than left off. A customer who came through a
referrer's link AND an agent's can credit both; that is two schemes, and if it should not be,
it is a decision for the owner, not a quiet `if`.

**An agent's terms are DATA set by a superadmin** (`/admin/referrals?tab=agents` → Terms):
department, `commission_bps`, `monthly_target`. NULL means "not agreed yet" and is shown that way;
a NULL rate earns nothing. `SalesAgent.parseTerms` refuses rather than clamps an out-of-range
value. Nothing about an agent's pay is a constant in code.

**An agent sees an email address only where the person was told.** The sign-up form says an agent
whose link you came through can see your email, role, country and join date; `SalesAgent.attribute`
stamps `users.agent_notice_at` in the same UPDATE that credits the agent, and `peopleForAgent`
selects the email only where that is set — and searches only those addresses, so a search cannot
confirm a hidden one. People who signed up before the notice existed are listed without an email.
The privacy policy says the same.

Leads (`sales_agent_leads`, `user_id` = the agent) are the agent's own: every read and write is
scoped by agent in the query, `AgentLead.leadFilter` is the one filter for the list and its count,
`won_at` is stamped on the move into Won (the monthly target counts deals won IN the month), and
the table is in the erasure PURGE and the export. `/referrals/agent` answers 404 to anyone who is
not an ACTIVE agent; `isSalesAgent` is rebuilt into the session on every request, so pausing an
agent removes the menu item and the page on their next request. The `/dashboard` agent block is a
summary pointing at the one page that lists people.

## About (2026-11-09)

`/about` presents Salesforce Hub as the Salesforce sister platform of Dynamics Hub, same operator
and same team. Three things on it are DATA with an owner, and the page hides each until it exists:

- **The team** is `config/team.js`, asserted at boot. A bio was adapted from Dynamics Hub's for
  this site, so each carries `approved: false` until its person has read it: in production an
  unapproved bio is left out (name and role only), in development it shows with a Draft badge.
  `linkedin` and `photo` stay null until somebody supplies the real ones — a photo is a file under
  `/images/team/` (the CSP allows no other host), and a card without one shows initials.
- **Who runs it** reads `config/legal.js` (`LEGAL_CONTROLLER_*`, with the NIPT in
  `LEGAL_CONTROLLER_REGISTRATION`), filled from the company's official documents. Unset: a warning
  in development, and the card left out in production.
- **Stories** are `TaxProgram.liveStories` — consented, published, not hidden — and the section is
  not rendered without one. Dynamics Hub's stories are about Dynamics 365 and are never copied here.

The platform tiles are counts of rows (`SiteStats.platformCounts`, open roles through
`Job.buildFilter`) and a tile at 0 is hidden. They count whatever the database holds, so seed data in production
would publish invented people as real: at boot in production, `SiteStats.seedAccountCount` counts
accounts on the reserved `example.com` domain (every seeded account uses it, no real person can)
and warns if there are any. It warns and never deletes — removing them is an operator's decision. "What we stand for" is the old "What it refuses to
do", restated against what the code does today: the tax programme exists but gives no tax advice,
and Import from CV is named as the one other use of a CV file, because "uploaded CVs only go to
companies you apply to" was otherwise true of stored CVs and not of the import.

## LinkedIn verification

**What LinkedIn actually returns decides the whole design.** The OpenID Connect userinfo
response carries `sub`, `name`, `given_name`, `family_name`, `picture`, `locale`, `email`
and `email_verified`. It does NOT carry the member's vanity URL, headline, positions or
employer, and no scope available to an ordinary application returns them.

So the badge confirms exactly one thing and says exactly that: **this person controls a
LinkedIn account, and here is the name on it.** The `linkedin_url` on a profile stays a
claim and is labelled as one. Do not reword the badge into anything broader.

This is a real bug in the reference implementation, not a hypothetical. `routes/linkedin.js`
there extracts the username from the URL the member typed, logs it next to the subject
LinkedIn returned — and then sets `linkedin_verified = true` without comparing them,
because there is nothing to compare against. The badge claimed a specific profile was
verified when all that had happened was an OAuth round trip.

**Linking only, never a sign-in method.** Every route requires an authenticated session.
An OAuth provider that can also sign you in has to decide what to do when its email matches
an existing account, and every answer to that is a documented account-takeover pattern.
Requiring an existing session removes the question.

**The access token is never stored.** It is used for one userinfo call and dropped. This
application never posts to LinkedIn, so holding a credential that can act as the member
would be a liability with no purpose — the reference keeps them. Nor is the profile payload
retained: only the opaque subject and the display name.

`external_identities` has UNIQUE keys on both `(provider, subject)` and `(provider,
user_id)`: one LinkedIn account verifies one Hub account. A subject already claimed by
someone else is REFUSED, never moved — and the message does not name the other account.

`consultant_profiles.linkedin_verified` stays a denormalised column, which this codebase
otherwise refuses (see the featured-job window). The difference is that a verification does
not EXPIRE, so nothing has to come round and unset it; it changes only when the member
acts, and `models/ExternalIdentity.js` is the single writer, moving both rows in one
transaction.

`namesAgree()` is the one cross-check available, and it is deliberately loose: a shared
distinctive token, diacritics stripped. The result is RECORDED AND SHOWN, never used to
refuse the link — a stricter rule would reject real people to catch a case it cannot catch
anyway. `/linkedin/start` saves the session explicitly before redirecting, because the
store write is asynchronous and the callback arrives on a different request; without it the
flow fails as "security verification failed" on an entirely legitimate attempt.

There is no LinkedIn API for sending connection requests or direct messages. Any feature
implying automated outreach would be a lie, and a test asserts the module exposes nothing
shaped like one.

## AI drafting for quote narratives

The highest-risk feature here, and the constraints are what make it defensible rather than
reckless. A quote is a statement made to a client on a date; `utils/sowEstimation.js` exists
so its parts reconcile exactly. Generated prose beside those figures can only ADD risk.

**THE RULE: the narrative may not contain a numeral the estimate does not contain.**
`utils/draftVerification.js` checks every draft, and a draft that fails is never stored and
never shown — the prose equivalent of `assertDocumentOpens`. It is not silently retried:
the author is told what the model did, because that failure is the one thing this feature
has to be watched for.

Two things make the rule enforceable rather than merely requested:

1. **The model is never given a figure.** `factsFor()` hands over modules, phases by name
   and description, team roles and what is out of scope — no day count, no cost, no rate,
   no week number. It cannot repeat a figure it never saw. The client-size band is turned
   into a phrase for the same reason: "Large (501-5000)" would put digits in front of a
   model told to write none.
2. **Numerals the model WAS handed are permitted.** Not a loophole — a correction the
   verifier itself exposed. "B2B Commerce", "Five9" and "Bulk API 2.0" are real names, and
   a narrative naming a product in scope was being flagged for inventing the figure 2.

The verifier also rejects placeholders (`[insert…]`, TBD, `{{`), lengths outside the
section's range, and commitments a generated paragraph must not make — guarantee, warranty,
indemnity, penalty, fixed price. Those terms are EXPORTED, because the accept route applies
the same commitment rule to the author's own edit while deliberately dropping the numeral
rule: a consultant quoting a figure in their own words is exactly what they are entitled
to do.

**A draft is a draft.** `quote_drafts` is a separate table — there is no code path from a
model response to `quotes.estimate`. Nothing reaches a document until the author accepts
it, they can edit every word first, and `edited_body` is what a client reads while `body`
keeps what the model originally wrote. That is the whole ethical basis: what goes out is
what a person put their name to.

At most one accepted, non-superseded draft per section, held in one transaction by
`QuoteDraft.accept` — two live drafts would make a document's contents depend on which row
a query returned first. Superseded drafts are kept, not deleted: they may already have
been sent. `catalogue_version` is stamped at drafting time so prose written against one set
of figures and shown beside another is detectable.

It drafts the summary, the approach narrative, project assumptions and risks — sections
that are prose anyway. It never writes scope, effort, rates, timeline or price, and a test
asserts no section key is named after any of them.

The model is Claude Opus 5, not the Haiku the assistant runs on: this writes paragraphs a
consultant puts in front of a client. Spend goes to the same `ai_usage` ledger and the same
month-to-date cap, and `MAX_DRAFTS_PER_QUOTE` bounds an otherwise unbounded "try again"
button on an Opus-priced call.

## Company document branding

**No document is ever uploaded.** A company supplies its brand and its own standard
wording; the Hub's validated generators render with them. That is the feature, and the
absence is the design.

The reference implementation goes the other way, and the cost is specific: it asks a
company to upload a REAL PERSON'S CV as the sample, stores that person's name and up to
forty thousand characters of their document as "template configuration", writes the file to
disk, and later serves it back out. Three standing rules here at once — durable bytes never
live on disk, a document nobody validated is never served, and personal data kept without a
purpose is personal data to explain later. A .docx can also carry macros and remote
template references; serving one we did not build breaks "open it before anyone else has
to" in the most complete way available.

**Only the two ACCENT colours are brandable**, and `paletteFor()` ignores every other key.
Body text, rules and shading stay the Hub's neutrals: a company choosing its heading colour
is branding, a company choosing its body-text colour is a company shipping an unreadable
document to a client under its own name.

**A brand colour must clear 4.5:1 against white**, measured by `utils/contrast.js`. A
colour that fails is REFUSED with its measured ratio, never silently substituted — a
company that picked a colour and got a different one has been lied to about what it
configured. This is the same rule `DESIGN.md` states for `#00A1E0` (2.93:1), now enforced
rather than remembered; a test asserts the Hub's own colours pass the check a company's
has to.

On the deck's title slide the text is WHITE, not cyan, and that follows from the rule: a
colour that clears 4.5:1 against white has exactly that ratio for white text on it, so
white is guaranteed readable on any permitted brand and cyan is guaranteed nothing.

**Company clauses are APPENDED, never substituted.** The standard assumptions are what make
an estimate mean anything; a company that could replace them could ship a figure with its
basis quietly removed.

The palette is resolved ONCE per document, in the entry point, and threaded down. A
module-level "current company's colours" would be a race between two documents generating
at the same time — there are await points inside every generator.

`services/quotePackage.js` is the single place a company's configuration enters a document,
for the same reason it is the single place accepted narrative does. `brandingFor()` never
throws and returns an empty shape, so a generator renders the Hub's defaults without
branching on whether a template exists.

**`pptxgenjs` does not escape `author` or `company`.** It escapes slide body text, but
those two go straight into `docProps/app.xml` — so a company called "Smith & Jones Ltd"
produced a package whose app.xml would not parse, and `assertDocumentOpens` refused to
serve it. They are escaped explicitly, and a test reads app.xml back and asserts the name
appears escaped exactly once: a parse check alone would miss a double-escape, because
`&amp;amp;` is valid XML.

## Search

**Search adds no filter builder of its own**, and that is the security argument as much as
a tidiness one. `services/search.js` calls the same `browse` each list view calls, with the
same defaults, so a row invisible on `/jobs` is invisible in search without anything in
that file knowing why. A search page assembling its own WHERE clause would be a second
place that has to remember `is_public`, `status = 'open'` and `hidden_at IS NULL` — and the
first one to forget is the one that leaks. A test strips the comments and asserts the
module contains no SQL, no `buildFilter` call and no visibility override.

It also means the count next to "see all 43 jobs" is the count that page will show, because
both came from the same query.

**No cross-type relevance score.** A LIKE match on a company name and a LIKE match inside a
five-thousand-word post are not comparable; a blended ranking would be a number invented to
look authoritative. Results are grouped by type and ordered within a type by that type's own
ordering. Same instinct as the rate index suppressing a bucket rather than interpolating one.

**One failing source is a missing section with a note, never a failed page.** The four
queries run in parallel and each can fail alone. A section that is down says so — showing
it as "no results" would be a different claim, and a false one.

`utils/likePattern.js` escapes `%`, `_` and the backslash before a query becomes a LIKE
pattern, and ALL FOUR builders use it. Two real bugs it fixes, both present in every list
view before search existed: a search for `50%` looked for "50 followed by anything", and a
search for `%` became `%%%`, which matches every row — a free full scan per request, four
times over once one box asks four builders. Escape the backslash FIRST; doing it after the
wildcards escapes the escapes.

A query shorter than two characters is refused rather than answered slowly, and nothing is
queried at all until there is something to query for. `/search` is deliberately absent from
`PUBLIC_PATHS`, so `seo.indexable` is false: a results page is infinite crawl space and
every query string would be a separate URL.

## Tax advisory

**The page is now "Tax optimization", the Albania employment program, WITH a take-home
calculator (2026-11-06).** That is a decision, not a drift, and the reasoning below about
the reference's calculator still holds: what changed is that there is now a real program
with a real payroll to apply. The guardrails that make the difference:

- **Every figure comes from `config/tax-program.json`, owned by finance and legal**, changed
  by a reviewed commit and never by a setting. The committed file is all `null`, and null
  HIDES: no stat tile, no "by €X–€Y a year", no number in an FAQ answer, and a valid
  calculator submit says "Figures aren't available yet — ask about your setup". Keys are
  snake_case: `program_fee`, `income_tax_bands`, `employee_contributions`,
  `employer_contributions` (each says whether it is `paid_from_gross`), `months_per_year`.
  All four payroll keys or none — `[]` means "there are none" and must be written by somebody
  who knows, because a half-filled payroll prints a take-home far above the real one.
  **Dynamics Hub's calculator is the special case** (`routes/tax.js` there): new net = gross −
  (gross × percentRate / 100 + fixedFee), both admin settings in DH's database. Its exact
  equivalent is a fee of that rate and fixed amount, one 0 % band and two empty lists; the 5 %
  in DH's code is a fallback, not a rate anybody confirmed, so it is not copied here.
  `config/taxProgram.js` validates
  the file and THROWS at boot on a malformed one; `TAX_PROGRAM_FILE` points elsewhere for a
  staging site or a test fixture. Nothing on the page is copied from another site.
- **The arithmetic is ONE file, `public/js/tax-calculator.js`**, UMD so the browser runs it
  and the server validates parameters with the same code. It knows no rate — a test asserts
  it holds no numeric literal beyond its unit constants. Contributions (each capped or not,
  each reducing taxable income or not), marginal brackets, a fee; integers, each line
  rounded once, net = gross minus the rounded lines, so the lines add up to the difference.
- **What is typed is never sent.** The inputs have no `name`, the form no action or method,
  `tax-page.js` holds no fetch (both asserted), and the form opts out of `main.js`'s submit
  guard (`data-no-guard`) because it never submits. Every result says "Indicative only —
  your home-country tax obligations still apply": the figure is the program's Albanian
  payroll, not anybody's tax position.
- **Stories are a separate table from `success_stories`** (migration 042), because those
  deliberately carry no pay. A program story belongs to an account, stores no name (the page
  derives "first name + initial" at read time), and is shown only with consent given and not
  withdrawn, published, not hidden — `TaxProgram.LIVE_STORY` is that one clause. With none,
  the section is not rendered at all. The participant count shows from
  `ACTIVE_COUNT_FLOOR` (10) upwards. Both tables are in the erasure PURGE and the export.
  There is no admin screen for either yet; rows are entered by hand.
- "Apply now" is the same enquiry with `topic=program` preselected, so it keeps
  its consent, its rate limit and its retention. "Is this legal?" must keep three points —
  home obligations still apply, foreign tax credit, consult an advisor — and a test holds
  them.
- **The page lives at `/tax-optimization`**, its name. `/tax-advisory` and everything under it
  redirect there (`legacyRedirect` in `routes/tax.js`): 301 for a read, 308 for a POST, because
  a 301 lets a browser turn an enquiry posted from a cached form into a GET that drops it. The
  admin queue stays at `/admin/tax-advisory` — it is the enquiries, not the page.
- **The calculator form is always shown** (DH's layout: gross, net, country, one button),
  and it validates inline either way — both amounts, net below gross. Only a VALID submit
  meets the missing rates, and it answers with the enquiry link, never a sample figure.
- **`program_fee` is its own key, not part of the payroll**, so it can be published (step 2 of
  How it works, and the hidden-costs answer) before the contribution rates are. It is still
  one value: the loader hands it to the calculator inside the payroll, refuses a payroll that
  carries its own, and refuses a payroll with no fee at all. The pages say "a few questions":
  the form has seven fields, and a count is a claim somebody checks.
- **Country selects come in groups** (`countryGroups` in `config/regions.js`): where most
  consultants on the Hub live, MEASURED from `consultant_profiles` rather than chosen; then a
  short list of the ~55 countries contractors here work from; then, on the enquiry form only
  (it needs a real code), every other inhabited country. The calculator's ends in "Other".

**This feature exists because the reference's version of it cannot be ported.** Its
`POST /tax-optimization/calculate` takes the gross and net a visitor types, computes
`newNet = gross - (gross * percentRate / 100 + fixedFee)` with `percentRate` defaulting to
5, and returns a monthly saving, an annual saving and a percentage increase. That
arithmetic asserts somebody's ENTIRE burden becomes five per cent of gross — no
jurisdiction, no entity type, no VAT position, no social security floor, no accountant's
fee — and `percentRate` is an admin-editable setting, so the saving on the screen is a
marketing dial. `utils/contractorEconomics.js` already refuses to compute tax; a
calculator in `routes/tax.js` would have moved that refusal one directory to the left, so
a test scans this feature's source and its exported surface for anything
saving- or tax-computation-shaped.

What is real underneath it is the INTRODUCTION — the enquiry below, which is still the
only thing that stores anything, and still computes nothing.

**Six fields, and none of them is money.** The reference's form collects forty from an
anonymous visitor with no rate limit and no consent record: current employer, contract end
date, notice period, gross and net monthly pay, current tax rate, VAT registration,
desired and current day rate. It also stores `estimated_monthly_savings` POSTED BACK FROM
THE BROWSER, so the figure on the record is one the client chose. Here it is name, email,
optional phone, country of tax residence, how you work today, and your question. The
specialist asks the rest in the conversation, under their own engagement terms — which is
the only place a professional duty of confidentiality actually attaches. It does not
attach in a marketplace's database. The route reads named fields rather than spreading
the body, and a test asserts the exact shape of the call, so a field added to the form
cannot reach the model unnoticed.

**Consent is a real checkbox with a named purpose**, and `consent_version` is stamped on
the row the way registration stamps it. An unticked box posts nothing, so absence is
refusal and is never defaulted — the same trap `AppSetting.setMany` avoids by iterating
declared keys rather than the submitted body.

**Retention is declared and observable.** `RETENTION_DAYS` is in `config/taxAdvisory.js`,
the form states it, `/admin/tax-advisory` shows how many rows are past it, and the button
beside that number deletes them. `npm run purge:expired` does the same from a scheduler.
Unlike moderation, this DELETES: a hidden post still has counters and a ledger pointing at
it, an enquiry has neither, and the promise made on the form was deletion. The events
cascade with it, because keeping an audit trail of a record we said we would delete is
keeping the record.

**`open_key` is the idempotency, and it lives in the schema.** It holds the lower-cased
email while the enquiry is open and is NULLed on the move to `closed`; the unique index on
it therefore means "one OPEN enquiry per address". A double-submitted form updates one
row, and somebody helped in March can ask again in September. MySQL not colliding NULLs in
a unique index is the whole mechanism.

**The country is refused, never truncated.** `trimmed(input.country, 2)` made `ALB` arrive
as `AL` — a test caught it. It is the one fact that decides who can help, and `AUT`
silently becoming Australia is wrong forever rather than wrong visibly. The same value in
`buildFilter` IS clamped, deliberately: a wrong filter shows the wrong rows to an
administrator who fixes it in a second.

`/admin/tax-advisory` is superadmin-gated for the same reason `/admin/rates` is — it shows
individual people's private circumstances next to their names, and a general admin
moderating a forum has no business reading them.

## The daily challenge

**The reference's game system is client-authoritative from end to end**, and that one fact
decides everything here. `routes/games.js:41` reads `const { score, gameDate } = req.body`
and inserts both, so the browser says what it scored and which day it scored it on. It does
not matter anyway, because all 2467 lines of `views/partials/games-section.ejs` ship every
question together with the index of its correct answer. One fetch posts a perfect score on
any date, as often as you like — and that output feeds the points summary, so a browser can
mint points against a ledger whose entire value is that a total can be explained.

So the answers live in `config/challenges.js` and never leave the process. The page gets
questions through `publicFormOf`, which strips the answer AND the explanation — the
explanation names the right option in prose, so it is as good as the key. The browser posts
the options it chose; `gradeAnswers` decides the score; the date comes from the server
clock. `UNIQUE (user_id, challenge_date)` gives one attempt a day and is checked by
ATTEMPTING THE INSERT, because a select-then-insert has a window where two submissions both
see nothing and both write.

**Topic challenges (2026-11-08, migration 045).** `/challenges` is now a hub: "Today's mix"
at `/challenges/daily` and six topics at `/challenges/<topic>`, each five questions a day from
its own bank in `config/challengeBank/<topic>.json` (≥ `MIN_PER_TOPIC` = 60 each, asserted at boot; only
`config/challenges.js` may read the directory, and a test pins that). Sixty because a day draws six
from a topic — five for its set, one for the mix — and at twenty a question came back within days.
One question per JSON line, so a review reads text and a diff shows exactly which question moved. Every one is the same engine:
`setFor(date, slug)`, `publicFormOf`, `gradeAnswers`. The unique key is now
`(user_id, challenge_date, challenge)` — one attempt per challenge per day — and the column has
no default, so an insert that forgets which challenge it graded fails rather than counting as
the mix. The MIX takes five topics and the SIXTH question of each topic's order for the day, so
it never repeats a question from that day's topic sets: playing a topic first is no head start.
Points keys: the mix keeps `challenge:<date>:<user>:<i>` so no earlier award can be paid twice
under a new key; a topic adds its slug. The streak counts DAYS with any attempt; the day's board
sums every challenge played that day. The hub's cards are full gradients with white text;
`.challenge-tone-*` stops are read from the stylesheet by a test and held to 4.5:1. `/challenges`
does not light up Home in the top bar — the account menu's Challenges item is the active one. Slugs are checked with `hasOwnProperty`
(`isChallenge('__proto__')` is false) and an unknown one is a 404. `POST /challenges` answers
308 to `/challenges/daily`, so a form cached before the move still posts its answers.

**Two questions in the original bank were wrong**, and nobody could have appealed, because the
bank is exactly what a player cannot see. `gov-soql-101` marked "50" as the synchronous SOQL
limit (it is 100; the explanation said so), so every player who knew it was scored wrong; and
"which sandbox refreshes most frequently" had two right answers. A question needs ONE answer
right in every reading — write it that way, and change it in the same commit when Salesforce
changes a limit. The attempt now records the chosen option's LABEL beside its index, because a
growing bank changes what a past date's set reconstructs to.

**The insert no longer uses `CAST(? AS JSON)`.** MariaDB stores JSON as LONGTEXT and rejects the
cast, so on MariaDB every submission was a 500 (the seed skipped challenges there for the same
reason). A plain JSON string is stored as is by MySQL 8's JSON column and by MariaDB.

ONE engine, not the reference's nine games. The other eight are the same shape wearing different UI.
The streak is kept but DERIVED from attempt dates, never posted by a `/streak/checkin` the
browser can call at will; `streakFromDates` is pure so month, year and leap-day boundaries
are testable.

Three things the design turns on:

- The daily set is **seeded by the date**, so everybody answers the same five and a
  disputed score can be reconstructed later. A random shuffle makes both impossible.
- Answers are **keyed by question id, not position**. `qs` compacts a sparse numeric
  object, so a partial submission would otherwise be graded against the wrong questions.
- A correct answer pays **the smallest award on the site**. A quiz is the cheapest volume
  here, and the scheme's own rule is that one which pays for volume gets volume.

`duration_ms` is stored and never ranked on — ties break on who answered earlier, because a
number the browser chose must not decide a position. The leaderboards select no email
address.

## Recruiters

`is_recruiter` has been on `users` since migration 001; the profile, dashboard and public
agency directory sit behind it.

**`recruiter` is in `PUBLIC_ROLES` and `partner` is not, and the line is MONEY.** A recruiter
account can do what a company account can already do. A partner account carries a commission
rate, which is what made the reference's `user_types[]=partner` POST a real escalation rather
than a missing checkbox. Anyone adding a role to that list: ask whether it grants access
somebody else pays for.

Three corrections, each small and each real:

1. **The guard is the shared one.** The reference defines its own `isRecruiter` inside its
   route file, so a failed check redirects a background fetch to a login page instead of
   answering JSON — it does not know about `Sec-Fetch-Dest`.
2. **No GET writes.** Both of the reference's page handlers self-heal with
   `if (!recruiter) createForUser(...)`, so opening a dashboard inserts a row. A read that
   writes cannot be retried safely and creates rows for anyone who only looked.
3. **Validation is applied.** The reference declares express-validator rules and never calls
   `validationResult`, so they are decorative and an unbounded name reaches the column.

Specialisms are cloud FAMILIES, derived from `config/cloudFamilies.js`, so adding a cloud
adds a specialism. The directory filters on them with `JSON_CONTAINS`, not a LIKE over the
serialised array — `LIKE '%sales-cloud%'` would also match a future `sales-cloud-einstein`.

Candidate shortlists were listed here as "not built", because who may see that a consultant
is on one is not an obvious question; the reference promises them in a route comment and ships
nothing. They are now built (migration 041), and the answer is in "Browse Talent" below.

**PLACEMENT TRACKING IS A DIFFERENT MATTER, AND THIS FILE WAS WRONG ABOUT IT.** It previously
said the reference "promises both in a route comment and ships neither". Half of that is
true. Placements are fully built there: a `PlacementQuote` model, `placement_quotes` and
`placement_fees` tables, a validated `POST /admin/placements`, and a
`POST /payments/checkout/placement` product whose fee is derived server-side from the agreed
quote rather than taken from the request — the same price-tampering defence
`config/payments.js` implements here.

That error is recorded rather than quietly fixed, because of what it cost: a placement fee is
REVENUE, and this feature was skipped on the strength of a sentence in this file rather than
on a decision anybody made. Documentation that is wrong is more dangerous than documentation
that is missing, because people build on it. Three other claims in this file were checked
against the reference at the same time and all three held exactly; this is the one that did
not.

Whether to build it is an open decision, not a refusal. If it is built, the shape is already
settled by `config/payments.js`: a payment names a PRODUCT and a SUBJECT, the subject is a row
the payer demonstrably owns, and a resolver re-checks ownership and answers with the amount.
A route asks; a route never decides.

## Success stories and reviews

**A story carries no pay figures.** The reference's stories store `gross_before`,
`net_before`, `gross_after` and `net_after`, and its tax page renders the difference as a
monthly saving — the savings calculator this codebase refuses, wearing a different hat and
attached to a named person. A test scans the model and the migration for anything
money-shaped.

**`utils/videoEmbed.js` is the reference's best code**, ported almost unchanged, and that is
worth saying because most of what this repo takes from there it takes as a correction. Only
recognised URL shapes produce an embed, everything else is null, and YouTube goes through
the no-cookie host — an `<iframe src>` built from a typed value is third-party script inside
this origin's page. Two things are tightened: the conversion runs at RENDER time from the
raw stored value, so today's rules apply to every row; and every query parameter is dropped,
so an embed cannot inherit `?autoplay=1` or a tracking id. `EMBED_HOSTS` is shared into the
CSP's `frame-src`, so the policy and the allowlist cannot drift apart — the same reason
`WEBHOOK_PATH` is shared.

**A review needs an account.** The reference takes a name and a role from the form, which is
a testimonial farm with a text box. An account gives the review a subject and makes
`UNIQUE (user_id)` mean one voice, one review. The role shown is derived from the flags the
account holds, so "Salesforce MVP" cannot be typed into a field the page renders as fact.

**Neither has a delete.** `SiteReview.delete` there is a hard DELETE reachable from a bulk
action; afterwards nobody can say what was removed or by whom. Publish and hide are separate
nullable timestamps: unpublished means "not finished", hidden means "was live and should not
be", and the retraction is the one somebody asks about later. Editing a review clears its
approval and deliberately does NOT clear a hide.

`ImageBlob` now carries an owner column per table rather than assuming `user_id`, because a
story photo belongs to a story with no account behind it. The lookup uses `hasOwnProperty` —
`ALLOWED_TABLES['__proto__']` is `Object.prototype`, which is truthy.

## The sales CRM

**This table is different from every other one here.** Everything else holds data somebody
gave us. This holds the names, addresses, phone numbers and job titles of people who never
asked to be contacted, so that somebody can contact them. Three rules make that defensible,
and each is enforced in the schema or a pure function rather than left to a handler:

1. **A lead cannot exist without a source.** `source` is `NOT NULL` and validated against
   `config/crm.js`; most sources also require `source_detail`. "Where did you get this
   address" is the first question anybody asks, and it is recorded at import rather than
   reconstructed later. There is deliberately no free-text option: a free-text source field
   fills up with "web".
2. **Suppression outlives deletion.** `crm_suppressions` is keyed on a SHA-256 of the
   address, holds no address, and has NO foreign key to `crm_leads`. That absence is the
   design — deleting a lead is exactly how the reference would lose the fact that its
   subject asked to be left alone, and the next quarterly import would write them straight
   back in. Nothing in this application deletes from that table. Moving a lead to
   `unsubscribed` writes the suppression in the SAME transaction as the status, because two
   calls leave a window where the status says "leave them alone" and the list does not.
   Every non-terminal status reaches `unsubscribed` in one step, asserted at boot.
3. **Nothing sends.** A draft is written, a person sends it from their own mail client, and
   a person records that they did. `marked_sent_at` is named for what it is: a note somebody
   made, not a delivery receipt. The reference has `/outreach/generate` feeding an
   `/outreach/queue`, which is one scheduler away from a different product.

**The model is handed no personal detail** — company, country and job title, never the name,
the address or the phone number. None of it improves a first paragraph and all of it would
be somebody's contact details leaving for a third party. `utils/outreachDrafting.js` rejects
a claimed familiarity ("I saw your recent post" is a lie in a first line and the one that
gets an address blocked), any figure at all, and the same commitment terms
`utils/draftVerification.js` exports. Spend goes to the shared `ai_usage` ledger and cap.

**CSV only, previewed before it is written.** The reference sniffs every sheet of an .xlsx
by its headers; its own comment records what that produced — hundreds of rows silently
skipped from one export. Here the source is chosen on the import screen and stamped on every
row (a source column inside the file is a source nobody checked), every row comes back with
its own named problems, and the write step RE-PARSES rather than trusting a posted row set.

**The bulk interlock is ported from the reference deliberately** — it takes an
`expectedCount` and refuses on a mismatch, and it got that right. The export escapes a cell
beginning `=`, `+`, `-` or `@`, which the reference does not: that is a real injection path
out of a CSV.

`/crm` is superadmin-gated for the same reason `/admin/rates` is.

## Finance: invoices, costs and a profit and loss

The only area here that holds figures somebody has already sent to a customer, and it has
one rule the rest of the codebase does not need:

**AN ISSUED INVOICE IS IMMUTABLE, AND ITS NUMBER IS NEVER REUSED OR FREED.**

The reference implementation breaks both halves. `CompanyInvoice.remove(id)` is a hard
`DELETE FROM finance_invoices WHERE id = ?` reachable from a list button at any status, and
deleting an issued invoice leaves a gap in the sequence — the specific thing an auditor looks
for, and not undoable. And the number comes from `SELECT COALESCE(MAX(invoice_seq), 0) + 1`
read outside any transaction, so two invoices issued in the same second get the same number.

Here the number is allocated from a counter row locked `FOR UPDATE` inside the transaction
that writes the invoice, with `UNIQUE (invoice_year, invoice_seq)` behind it. Drafts hold no
number, and NULLs do not collide in a MySQL unique index, so a draft is free to discard. A
draft is the only editable state; anything after it is CANCELLED, which keeps the row and
keeps the number used. `/admin/finance/sequence` exists so the no-gaps claim is checkable
rather than asserted in a comment.

**VAT here is not the tax refusal.** `utils/contractorEconomics.js` refuses to compute tax
because it would be guessing at a jurisdiction. On an invoice nothing is guessed: the issuer
types the rate that applies and `config/finance.js` multiplies. Stating a rate you chose is
bookkeeping; inferring one you did not is advice. There is no default rate anywhere, and no
`STANDARD_VAT` constant — a test asserts that.

**Rounding happens once per line, and the invoice total is the sum of the rounded lines** —
never the rounding of a summed float. That is what makes the printed total equal the sum of
the printed lines, which is the only figure a customer actually checks. The stored totals are
re-checked by `reconciliationProblems` before an invoice is shown, stored or downloaded, and
`utils/documents/invoiceDocx.js` throws rather than produce a file that does not reconcile —
the same standing `routes/quotes.js` gives an estimate.

**The customer's details are COPIED onto the invoice at issue**, not joined from the client
row. A customer moving office next year must not rewrite an invoice already sent and filed.
The FK to `finance_clients` has no cascade and no `SET NULL`: a client with invoices cannot
be deleted at all, and archiving is the operation.

**`utils/decimalInput.js` is the one parser for every typed decimal**, and it exists because
this had two. `models/FinanceCost.js` carried its own copy under a comment saying "same rule
as the invoice lines" while the two had already drifted on negatives and on blanks. A blank
or absent field returns NaN and is refused by name — it must never read as a zero, because a
line whose `vat_percent` never arrived was being invoiced at 0% VAT without a word.

**`isoDate()` normalises a stored DATE before any comparison**, and that is a real bug, not a
precaution. `mysql2` returns a DATE as a JS `Date`, so `String(cost.starts_on).slice(0, 10)`
is `'Thu Jan 01'` — which sorts after `'2026-02-01'` as a string and put every recurring cost
outside every window. The profit and loss showed zero costs beside real invoices with nothing
in the log, and the unit tests stayed green throughout, because a unit test passes strings.

`services/profitAndLoss.js` is derived at read time and never stored, and it refuses two
things: it converts no currency (a P&L per currency, because merging two would make the
bottom line depend on the day the page was opened) and it computes no tax. Revenue is counted
on the ISSUE date with cash received shown beside it rather than blended in. A requested
window is validated and capped — `monthsBetween` walks month by month and each month walks
every cost row, so an unclamped `?from=0001-01&to=9999-12` is a cheap way to make a page
expensive. Arithmetic faults are `problems`; a month where more was received than invoiced is
a `note`, because a January invoice paid in March is ordinary and a banner that cries wolf is
a banner people stop reading.

Costs are ONE table for recurring and one-off — they differ by whether `recur_every` is set,
not by what they store. A yearly cost lands on its anniversary month rather than being spread
over twelve, because that is what the bank statement shows. Ending a cost is the operation;
`remove` refuses anything that has already reached a past month, since deleting a
subscription paid for eleven months would take eleven months of real expense out of
statements that were already filed.

The seller's own details are `FINANCE_SELLER_*` environment variables rather than settings
rows: an invoice with the wrong legal entity on it is worse than no invoice, and that is a
deployment decision with an author, not a checkbox.

**Deliberately not ported from the reference's superadmin area:**

- **Uploaded .docx invoice templates.** It takes a file an administrator uploads, writes it
  to the host disk and later fills and serves it. Credit where due — it checks the file
  actually contains the placeholder tags, which is a genuinely good guard. But three standing
  rules land on it at once: durable bytes never live on disk, a .docx can carry macros and
  remote template references, and serving a file we did not build breaks "open it before
  anyone else has to" completely. The layout lives in code instead, under version control.
- **`/documents/extract`** — an LLM reading supplier invoices uploaded as files. Same
  objection plus a second: it puts a third party's document, with their bank details on it,
  through a model.
- **`/employees` and `/business-units`**, and `/employees/import-consultants` with them.
  That is an HR system inside a marketplace, and the import path copies consultants who
  signed up to a directory into a staff table they never joined.

## Placement fees

Ported from the reference as a CORRECTION, which is what porting a feature from there has
meant every other time. **What it gets right, and it is the important half:** the contract
value is agreed by a person and stored SERVER-SIDE, and the fee is derived from that stored
row — nothing the browser sends reaches the amount. Its own audit calls that the C3
price-tampering finding, and it is the same structural answer `config/payments.js` gives
every product here.

Five things are fixed, each one a rule already stated somewhere in this file:

1. **THE CUSTOMER WAS OVERCHARGED.** It computes
   `Math.round((contractValue * feePercentage) / 100)` on a `parseFloat` of a
   `DECIMAL(12,2)` — a fee rounded to WHOLE currency units and only then multiplied by 100
   to reach cents. A €47,350 contract at 15% is €7,102.50 and that charges €7,103.00, with
   `Math.round` sending every half-unit upward. Here the value is minor units, the rate is
   basis points, and the fee is `value * bps / 10000` rounded DOWN — the direction
   `Referral.commissionMinor` rounds, because rounding a charge up bills more than the
   agreement says. The boot assertion carries that exact case.
2. **`?.percentage || 15`** has two faults in one line: an unrecognised placement kind bills
   at 15%, and a rate deliberately set to 0 is falsy and also bills at 15%. `rateBpsFor`
   returns null and the caller refuses. A price nobody chose is the one thing a pricing table
   must not produce.
3. **The rate is SNAPSHOT on the row.** It reads the live pricing config at checkout, so
   renegotiating the standard rate silently reprices every placement already agreed with a
   client — the fault `referral_attributions` avoids by snapshotting and a stored quote
   avoids by keeping its catalogue version.
4. **`DATETIME`, not `TIMESTAMP`.** Its `created_at` is the table's first TIMESTAMP column,
   so with `explicit_defaults_for_timestamp` off it carries an implicit
   `ON UPDATE CURRENT_TIMESTAMP` and marking a placement paid re-dates when it was agreed.
5. **The schema is a migration**, not `PlacementQuote.initializeTables()` running
   `CREATE TABLE IF NOT EXISTS` on boot.

**The losing tab gets its money back.** `placement_fees` has a unique key on its SUBJECT as
well as on the payment — the guard the per-payment key cannot give, since two checkout tabs
against one placement are two DIFFERENT payments. The reference has no such key: its webhook
asks `markPaid` whether the row moved and, on "no", logs a line and returns, so the second
payment is captured, no fee is recorded, no invoice is raised and nobody is told. Here the
insert decides, the handler reports the collision, and `fulfil()` rolls back and flags
`needs_refund` for `/admin/payments`. Verified against MySQL: two payments, one fee row, one
`needs_refund`.

`claimPaid` is a CLAIM, not a setter, and runs on the same connection inside the same
transaction as the fee insert. **The insert decides and the status follows** — never the
other way round. Gating fulfilment on reading a status first is the reference's worst payment
bug, and keeping the two apart matters even here where the same person wrote both.

`/admin/placements` is superadmin-gated: it sets a figure a company will be charged.

## Privacy rights, and erasing an account

The privacy policy promised **"ask us and your account and its data are removed"** and there
was no route, no form and no address to ask at. `/contact` had been in `PUBLIC_PATHS` since
the beginning — robots.txt allowed it, the sitemap handed it to search engines — and it
404'd, because no route or view had ever been written. That is the page that would have said
how to ask.

**Erasure ANONYMISES. It is never `DELETE FROM users`.** Thirty-two foreign keys cascade off
that row, and letting them is wrong three ways, each one a rule stated elsewhere here:

1. `rate_submissions` cascades, so deleting somebody's figures silently moves a PUBLISHED
   percentile for everybody. The rate index deliberately has no path to correct or remove a
   figure; erasure must not become that path by the back door.
2. `posts` and `post_replies` cascade. `posts.reply_count` is written in the same transaction
   as the row it counts and nothing recomputes it, so a reply vanishing leaves somebody
   else's question permanently wrong and an accepted answer pointing at nothing.
3. `payments` and `invoices` cascade — financial records under a statutory retention period.
   The right to erasure does not override a legal obligation to keep them.

So `models/AccountErasure.js` destroys every field and table that identifies a person and
keeps what belongs to somebody else's record, an aggregate, or the law — with nothing left
tying it to a human being. Once the link is severed a day rate in a percentile is not
personal data, which is exactly why the aggregate can stay honest and the promise can still
be kept. **It is the only module that erases an account**, for the same reason
`models/Moderation.js` is the only one that touches the hidden flags: a second eraser is a
second place that can forget a table, and that failure is silent — a name left in a row
nobody thought about. A test asserts no other file contains `DELETE FROM users`.

The photo and logo tables are in the purge list in their own right: they hold the BYTES keyed
by `user_id`, so deleting the profile row does not reach them. A superadmin is refused —
an erased account cannot sign in, and erasing the only administrator leaves no way into the
site at all. Confirmation is a TYPED word, not a checkbox: an account erased by accident
cannot be handed back, because the whole point is that the data is gone.

`services/dataExport.js` answers Article 15 and Article 20 with one JSON file, and carries
the rule that keeps it from becoming a breach with a download button: every query is scoped
to the one account, the `users` column list is written out EXPLICITLY rather than `SELECT *`
(which would export `password_hash` the moment somebody adds a column and forgets this file),
and only the person's OWN messages are included — the other party's words are the other
party's personal data, and their right does not weaken because somebody they once messaged
asked for a download.

`config/legal.js` names the controller, and **invents nothing**. A policy has to name a real
person or company with an address; that is not something an application can fill in for
itself, so they are environment variables, the pages say plainly when they are unset, and the
boot warns rather than throws — a missing controller is a legal problem, not a broken
application, and refusing to start would take a running site down over a text field. The
processor list is filtered by which API keys are actually set, because a policy naming Stripe
on a site with no Stripe key is inaccurate in the direction that matters.

**`npm run seed` refuses to run when `NODE_ENV=production`.** It creates 24 consultant
profiles, 6 companies, 30 jobs and 24 rate submissions — on a live site that is a public
directory of people who do not exist, and a published benchmark that sails past the
three-contributor privacy floor built from invented figures. `scripts/create-admin.js` exists
for the production case; until this guard, the only thing between a live site and a directory
of invented people was somebody remembering which command to type. `SEED_ALLOW_PRODUCTION=yes`
is the override, spelled out rather than any truthy value so an orchestrator exporting `0`
cannot switch it on.

## Build your profile

`/profile/settings` is ONE page for everybody: the consultant sections plus Account for a
consultant, Account alone (with a button that adds the role) for anybody else.
`/profile/consultant` redirects there, so there is one URL to link and one to remember.

**Uploaded CVs and cover letters are the one place this codebase serves a document it did
not build**, and it is only defensible because of what `utils/documentUpload.js` refuses
before a byte is stored: anything but PDF and .docx (a legacy .doc cannot be told apart from
its macros without a full parser), a .docx with macros, embedded objects or an external
template relationship, a PDF naming JavaScript, Launch, EmbeddedFile, RichMedia or XFA. The
bytes live in `consultant_documents`, never on disk, every list query leaves the `bytes`
column out, and the download is ONLY ever an attachment with `nosniff` — a PDF can hide a
keyword in a compressed stream, so inline display is the one door that stays shut.

**Import from CV never writes on its own.** The model's answer is laid out as ticked boxes
(built from DOM nodes, never `innerHTML`); basics land in the form and wait for Save, and the
ticked projects and experience go through `/profile/consultant/import-entries`, which shapes
each entry with the same `projectFrom`/`experienceFrom` a hand-typed one uses.

**A company the consultant APPLIED to can open the profile even while it is private**, and
even if that company is on the hidden list: applying is the consultant choosing to show it.
A moderator's takedown still wins. The page says so beside the switch — the rule existed in
the copy before it existed in the route, and a privacy note that is not true is worse than
none. `?preview=company` renders the page as a signed-in company sees it (rate hidden when on
request, no owner controls) and is honoured only for the owner.

**No answer is pre-filled** (migration 038). Availability and work mode are NULL until
chosen and neither type of work is pre-ticked: a default the form shows as a selection is a
fact somebody can publish by pressing Save without reading. Once answered, "Choose…" is
disabled so a listed profile cannot go back to saying nothing — and listing needs an
availability, as the spec's minimum says. "Anywhere (remote)" is its own column,
`works_anywhere`, not every country code at once; "Anywhere in EU" ticks the 27 codes in
`config/regions.js`, so a stored list is still a list a country filter can match.

`nextSortOrder` wraps the MAX in `Number()`: MariaDB returns `COALESCE(MAX(..))` as a string,
and `"5" + 1` gave an imported project sort order 51.

## My documents

`/profile/documents` is the ONE page for a person's files: uploaded CVs and cover letters, the
CV Generator's log, and — for a company — its SOW quotes with their downloads. The menu, the CV
Generator, the profile's Documents section and the applications list all link here; the
profile section is a summary, not a second upload form.

**Uploads are limited per kind** (`ConsultantDocument.LIMITS`: 5 CVs, 10 cover letters),
counted `FOR UPDATE` inside the insert's transaction so two tabs cannot both take the last slot.

**"Recently generated" is a LOG, not a store** (`generated_documents`, migration 044): the kind,
the sections chosen and the application it was for. The file itself is never kept — a profile
changes, and the stale copy is the one somebody sends — so "Generate again" rebuilds it from the
profile as it is now. `GeneratedDocument.log` never throws: a bookkeeping failure must not cost
somebody their download. The application is accepted only if it is the consultant's own.
Both tables are in the erasure PURGE and the export.

## The consultant's applications

`/dashboard/applications` lists through `Application.buildFilter` with the CONSULTANT scope,
`Application.forConsultant(id)` — the same builder the company board uses, not a second one,
so a tab's count is the number of rows behind it. A missing scope still throws.

"Seen by the company" is `viewed_at` OR the first company move, whichever came first. A move
is read from WHICH transition happened, not from the event's actor: the consultant can only
withdraw or re-submit, so any other step is the company's — even when its actor was erased
and is NULL. Reading the actor first made every seeded and every erased-employer application
look unanswered. `viewed_at` is set by a conditional UPDATE on the employer's GET of the
application: the one exception to "no GET writes", because "opened" can only be observed on a
read, and it is idempotent and inserts nothing.

Private notes live in `application_notes`, never as a column on `applications`: the employer
side reads `a.*`, and a note only one party may read must not sit in a row the other selects
wholesale. The CV sent is `cv_document_id`, validated against the applicant's own CVs on
apply, and downloadable by exactly the two parties to the application. The status email goes
to the consultant only when the COMPANY moves the application, never on their own withdraw.

The consultant answers an offer: `Application.consultantMay` allows offered → hired (accept)
and any withdrawal (decline is a withdrawal with a note), and nothing else of the company's.
"Hired" still needs two decisions — the company's offer and the consultant's yes. On an
offered row the list shows Accept / Decline instead of Withdraw.

## Saved jobs

`/dashboard/saved` uses the board's own job card (`views/partials/job-card.ejs`, `saved` local)
rather than a second card, so a pill the board shows is a pill the shortlist shows. That is how
an empty pill was found: `Job.listSaved` selected its own short column list without
`seniority`, and every saved card rendered a blank badge where the level should be. It now
selects the board's columns, and the card renders no pill for a level it does not have.

A saved role that closed, expired or was taken down STAYS on the list, greyed, "No longer
open", with only Remove — `is_open` in `listSaved` is the board's visibility rule, so a card
offering Apply is one the board would show. A bookmark disappearing without a word is the
thing somebody writes in about.

"Highest rate" (`utils/savedJobs.js`) ranks only published rates: a hidden one deciding a
card's position would leak it. Day rates and salaries are different units, so contract roles
come first, permanent after, unpublished last. The whole list is read once and sliced, because
SQL here cannot convert currencies; the count is the real one, not page length plus offset.

The "Saved roles" block on Your applications is the same data and the same unsave handler
(`[data-saved-item]` in `public/js/main.js`): removal is in place with Undo, built from DOM
nodes, and Undo saves the job again rather than restoring a cached row.

## Browse Talent

`/consultants` is built the way `/jobs` is: one form, checkbox groups with a count beside each
value, applied on change, chips with × above the list. Each count leaves out its OWN group
(`ConsultantProfile.facet`, the same rule as `Job.facet`), so ticking Italy does not turn every
other country into (0). Every count, the hero figures included, goes through `buildFilter` with
the viewer: a consultant who hid from this company is not counted for it either — a count is a
measurement too.

The hero says "24 consultants · 6 available now · 13 clouds covered", and each is a count of
what this viewer can browse. "Clouds covered" counts clouds at least one listed consultant
works in, never the size of the catalogue: thirteen clouds in a config file is a claim about
nobody.

The certification filter offers OFFICIAL names only (`config/certifications.js`), and only
those somebody listed holds. The profile accepts free text for a credential, and a filter on
free text is a filter on whatever somebody typed.

The card is built from stored facts. Its title is role plus seniority ("Senior CPQ & Billing
Consultant"), not the headline, which in practice repeated the seniority badge. A hidden rate
reads "Rate on request" and arrives as NULL from `browse`, so `consultantRate()` cannot print
it even if a template forgets. "LinkedIn verified" means what the LinkedIn section says it
means; the Trailhead badge is TYPED on the profile, so it is neutral-coloured and titled "As
stated on the profile".

**The shortlist answers the question this file used to leave open.** It is private to the
company or recruiter that made it — the consultant is never told and cannot see it, and nothing
anybody else reads joins on `company_shortlists`. It never makes anybody visible: adding refuses
a profile the account could not find in the directory, and the shortlist view is a
`shortlisted_by` clause in `buildFilter`, which only narrows, so a profile that went private or
hid itself from that company drops out. It goes with either account: the company's rows through
`PURGE`, and every entry naming an erased consultant through `PURGE_AS_SUBJECT`. A test pins the
files allowed to mention the table.

"Invite to apply" goes to the approach form on the profile (`#approach`), and only for an
account with an open role — a conversation is always anchored to one, so there is nothing to
invite to without it. A company with none sees "Post a role to invite" instead, and a visitor
sees "Sign in to shortlist": a button labelled "Shortlist" that lands on a login form is a
button that said something it does not do.

**The level and the years cannot contradict each other.** The seniority labels state their
bands ("Junior (0-2 yrs)"), so `SENIORITY_LEVELS` carries `minYears`/`maxYears` and
`seniorityFitsYears` refuses a mismatched pair on save — refused, not corrected, because which
of the two is wrong is the consultant's to say. The form moves the level when the years are
typed and says so. The seed derives the level from the years; picked independently they put
"Junior Apex Developer · 18 years experience" on a card.

## Hiding a profile from named companies

For the consultant looking for their next contract while still in their current one. A public
profile is how they get found; their present employer seeing it is why a lot of people never
publish one.

**The exclusion is a clause in `ConsultantProfile.buildFilter` and nowhere else.** The
reference implementation has this feature and put its equivalent clause inline in ONE query
out of the fourteen that read `consultant_profiles` — so its browse list honoured the block
and its search, its featured-talent panel and its profile page did not. That is the
one-builder rule wearing the most expensive shape available: a privacy promise that holds on
one page. A test asserts the string `consultant_hidden_companies` appears exactly once in
that model.

The rule is stated **twice in total**, and the second place is named rather than discovered:
a list is SQL, and a single profile page is a row already fetched that cannot use a WHERE
clause, so `ConsultantHiddenCompany.blocks()` answers for the detail route. A test pins the
set of files allowed to mention the table to exactly those two. The detail route answers
**404, never 403** — "you may not see this consultant" tells the company that a consultant
they can name has blocked them, which is the thing being hidden.

`viewer` is resolved once per request by `viewerFor()` and passed IN. The builder stays a pure
function over its filters and never reaches into the database, which is what keeps it testable
and what stops a list and its count disagreeing. In `services/search.js` it arrives as an
ARGUMENT to each source's `search`, not a closure: `SOURCES` is a frozen module-level constant,
and a source capturing per-request state would be one request's viewer answering another's.

**What it cannot do is said on the page.** A signed-out visitor cannot be filtered — the
directory is public and no clause can ask who an anonymous browser works for. The consultant
is told that plainly and pointed at the switch that does answer it: making the profile
non-public. A free-text employer name is matched against a registered company's profile name
and only bites if that employer later signs up under a matching name; the page says that too.
A privacy feature described as stronger than it is, is worse than no feature.

The schema enforces that exactly one kind of block is set per row with a `CHECK`, and one
block per company per consultant with two unique keys, so adding the same block twice is a
duplicate-key no-op rather than a second row to remove twice.

## Issue reports

`/admin/errors` records what the SERVER noticed. `/report-issue` records what a PERSON
noticed, and the two barely overlap: a button that does nothing, a figure that looks wrong, a
rule that behaves differently from what the page says. None of those raise an exception, so
without this they arrive as nothing at all and the first sign is somebody leaving.

**Open to anonymous visitors on purpose.** The most valuable report a marketplace can get
comes from somebody who could not finish signing up, and requiring an account to say
"registration is broken" loses exactly the report you most need. `user_id` is nullable and
`contact_email` exists only so an anonymous reporter can be answered — it is stored ONLY when
there is no account, because keeping a typed address beside a signed-in report is a second
copy of something already held.

**Nothing is captured automatically** — no IP, no user agent, no referrer. A bug report is not
a reason to start logging visitors, and each of those fields would need a retention rule and a
line in the privacy policy. A test strips the migration's comments and asserts none of those
columns exists.

`page_path` must be a path on this site: a full URL, a protocol-relative `//host` or a
`javascript:` scheme is refused and stored as NULL. It is typed by a stranger and lands on an
administrator's screen, and an administrator clicking a link somebody else supplied is the
oldest trick there is. It is rendered with `<%= %>` as text as well — this is the second
guard, not the only one.

**There is no delete.** A report somebody dismissed is evidence that a person complained and
nothing happened, which is the most useful row in the table the fourth time the same thing
arrives. Same reasoning as moderation hiding rather than deleting. Every non-terminal status
reaches `closed` in ONE step, asserted at boot — the same rule `config/crm.js` holds for
`unsubscribed`, because the step somebody skips is the one that closes it.

An answer written by an administrator is shown to the reporter on `/my-issues`. A queue that
never replies teaches people not to send the next report.

## The admin test panel

`/admin/tests` requests the RUNNING site over HTTP, on `APP_BASE_URL`, one case at a time,
redirects not followed — the question Jest cannot answer is whether the thing behind the
domain is up and behind the right guards. Ported from Dynamics Hub, with its cases in
`admin_test_cases` (migration 042) and these rules:

- **The built-in suite is code.** `config/adminTests.js` holds it; "Rebuild suite" upserts
  those rows by `builtin_key`, switches them back on, deletes built-ins the code dropped,
  and does NOT touch a custom case or a past result. The reference drops both tables.
  Results copy the case's name and path and SET NULL on delete, so a run still says what it
  checked after the case is gone. `admin_test_runs` (028) is kept and no longer written.
- **One safety rule, `caseSafetyProblems`, at boot, on save and again just before a case
  runs.** A path on this site, never a URL (the runner re-checks the origin). A GET, or a
  POST sent as a visitor with no cookie, no token and no body, to a route not CSRF-exempt and
  not named for deleting, paying or sending, expecting the CSRF refusal (302 or 403) — the
  only write a case may attempt is one that cannot happen. No `body` column at all, and only
  the headers in `ALLOWED_HEADERS`, so a case cannot carry a session.
- **Running and rebuilding are admin; adding, switching off and deleting are superadmin** —
  those decide what the panel requests on the live site and what it stops checking. A
  built-in is switched off, never deleted from the screen: it would come back on rebuild.
- **Signed-in cases are OPT-IN via `QA_TEST_PASSWORD`** (12+ characters, or it counts as
  unset). Without it they are recorded as SKIPPED — never passed — the screen says how many
  and why, and any QA accounts are switched off. With it, `QaAccount.ensure` creates or
  repairs `qa-<role>@salesforcehub.test` for consultant, company, recruiter and admin:
  verified, active, exact flags, every profile hidden. **The QA admin is a plain admin and
  `is_superadmin` is forced to 0 on every run** — superadmin is shell-only, for named people,
  and a QA superadmin would also make every "a plain admin is refused" case pass for the
  wrong reason. Sign-in goes through the real form (GET for the cookie and `_csrf`, then
  POST); sessions are cached per role because the login limiter allows ten a window.
- **No `X-Forwarded-Proto`.** The reference forges it to get a secure cookie over loopback.
  Here the base URL is the public https address behind the platform's proxy, and an http one
  in production should fail at sign-in, which it does, with a message saying so.
- **QA accounts are never counted.** `utils/qaAccounts.js` is the one definition:
  `isOwnTraffic` skips them and the runner's user agent, which also says `monitor` so a
  sales-agent link it opens is no open; "new this week", the admin overview, sign-ups by
  country and the sales agents' unattributed row bind `QA_EMAIL_LIKE`; `utils/email.js`
  refuses every `.test` address. They are created by the model, never through
  `/auth/register`, so no referral or sales-agent attribution can reach them. The company's
  profile is created HIDDEN before any page opens, because `GET /jobs/new` and `GET
  /profile/company` create one on first use and `company_profiles` defaults to public — the
  suite's own directory case caught "QA Company" in the public list.
- **Failures go to the error log as `source = 'self_test'`**, written directly rather than
  through the error handler, so the CSRF-scanner rule never sees them, and filterable and
  deletable by filter like any other row. No response text is copied there.
- **Coverage is a test.** `tests/unit/adminTests.test.js` walks every router `server.js`
  mounts and fails for any GET route without a path parameter that no built-in case
  requests, and for any `isSuperadmin` route without a case proving the plain QA admin is
  refused it. `COVERAGE_EXEMPT` is the named list for a route that genuinely cannot be
  checked this way; it is empty, because even a download or an OAuth callback can be guarded.
  Add the case in the same commit as the page.

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

**Every role needs at least one entry in `ROLE_ALIASES`, and a test enforces it.** That is
not tidiness. This application is ported from a Dynamics 365 marketplace, and two roles
survived the port untranslated — `smb-erp-isv` ("SMB / ERP ISV Consultant") and `hcm-isv`,
which name Business Central and a Dynamics HR partner and mean nothing here. What exposed
them was that they were two of the only three roles with no aliases at all: nobody could
write a search term for a product that is not in this ecosystem. Keeping the invariant keeps
the signal. They are now `appexchange-isv` and `manufacturing-cloud`.

`tests/unit/taxonomy.test.js` also scans every user-visible label in every catalogue that
feeds a dropdown — roles, categories, seniorities, modules, families, certifications and ISV
solutions — and fails on another vendor's product name. The scan asserts each list is
non-empty first, because a catalogue read through the wrong key is an empty list, and an
empty list passes every "nothing forbidden here" assertion silently. That guard caught a
real mistake while the test was being written.

Renaming a slug was free while nothing stored one — no seed row, no other module, nothing
deployed. Once this application holds data, changing a slug is a migration, not an edit.

## Email

With no `RESEND_API_KEY`, `utils/email.js` logs instead of sending, which is what makes
local development and CI work without credentials. `send()` returns failures rather than
throwing, because every call site is a side effect of an action that must succeed anyway.

## Look and feel

`DESIGN.md` is the authority for anything user-facing, and it is short — read it before
adding a page. The two rules most often broken while moving fast:

- **Bootstrap AND Inter are served from this origin**, not a CDN (`/vendor/bootstrap`,
  `/vendor/bootstrap-icons`, `/vendor/inter`, all from `node_modules`). The CSP allows no
  CDN at all. A CDN puts a third party on every page load, breaks behind a proxy that
  blocks it, and forces the policy to trust a host that also serves everybody else's code.

  This rule was written before it was true. Inter came from `fonts.googleapis.com` via two
  `<link>` tags, and `styleSrc`/`fontSrc` named two Google hosts to permit them — so the
  documentation said one thing and the policy did another, and nothing checked. Driving the
  running site through a real browser is what found it: the stylesheet request failed with
  `ERR_CERT_AUTHORITY_INVALID` behind a proxy, which is the exact failure this rule
  predicts, and the page had been silently falling back to system fonts.
  `tests/unit/brandAssets.test.js` now asserts both halves — no template fetches from
  another host, and no CSP directive names one. `frameSrc` is the single exception and
  carries `EMBED_HOSTS`, shared from `utils/videoEmbed.js` so the two cannot drift.

  `public/css/inter.css` declares the four weights the design uses, with an explicit
  `unicode-range` and the `latin-ext` subset: Albanian ë and ç live there, as do the
  diacritics in most European names this site will hold, and the range is what stops a page
  that shows none of them from downloading the file.
- **Never inline a brand colour.** There is a token or a class. `views/email/` is the one
  exception, because email clients strip `<style>` and do not support custom properties.
- **`#00A1E0` never sits behind white text** (2.93:1). Cyan is an accent and a gradient
  stop; `--primary-blue` #0176D3 is the CTA and link colour.

The scroll-reveal hidden state is gated behind `.js-reveal`, set by an inline script in
`views/partials/head.ejs` before first paint. With scripting off the content is simply
visible. Never let an animation be the reason a page cannot be read.

## Style

- CommonJS, `'use strict'`, no transpilation.
- Comments explain **why**, not what. If a rule exists because something broke, say so.
- `<%= %>` escapes, `<%- %>` does not. Only ever pass `sanitizeRichText()` output to `<%- %>`.
- Server-side validation is authoritative. Client-side JavaScript is a convenience and the
  page must work without it.

## Node version and dependencies

**Node 24, in four places that must agree**: `Dockerfile` (`node:24-bookworm-slim`), the CI
workflow's `node-version`, `engines` in `package.json`, and `.nvmrc`. Node 20 reached end of life
in April 2026, and the deploy log showed what staying on it costs: `geoip-lite` 2.0.3 and
`sanitize-html` 2.17.7 already declared newer engines. `sanitize-html` 2.18 then moved to an
ESM-only `htmlparser2`; the app `require()`s it fine on any Node that has require(esm), but Jest
can only do that from Node 24.9, so on an older local Node fifteen suites fail to load while CI
is green. Use Node 24 locally.

**`overrides` in `package.json` exist for advisories a dependency pins out of reach**, each
named for its parent: `brace-expansion` 1.x under `exceljs`'s old `minimatch`;
`express-mysql-session`'s own `mysql2` (the store is handed our pool, but the stale copy still
shipped in the image); `exceljs`'s `uuid`. After changing one, delete the nested lockfile entry
it replaces — npm keeps a locked version over an override until the entry is gone.

Left on purpose, because the vulnerable code is never reached: `image-size` under `pptxgenjs`
(it measures images; the deck adds none) and `glob`/`minimatch` under `archiver` 7 (they serve
`archive.glob()`/`directory()`; every archive here is `append()` of buffers). `archiver` 8 is
ESM-only — revisit both when moving to it.
