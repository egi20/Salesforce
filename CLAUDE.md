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

What is real underneath it is the INTRODUCTION. So `/tax-advisory` explains the service,
says in the same breath that the Hub calculates nothing, and offers a form. Nothing else.

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

ONE game, not the reference's nine. The other eight are the same shape wearing different UI.
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

Not built, deliberately: candidate shortlists and placement tracking. The reference promises
both in a route comment and ships neither. A shortlist holds other people's profiles, and
who may see that a consultant is on one is not an obvious question.

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

## Look and feel

`DESIGN.md` is the authority for anything user-facing, and it is short — read it before
adding a page. The two rules most often broken while moving fast:

- **Bootstrap is served from this origin**, not a CDN (`/vendor/bootstrap`,
  `/vendor/bootstrap-icons`, from `node_modules`). The CSP allows no CDN at all. A CDN
  puts a third party on every page load, breaks behind a proxy that blocks it, and forces
  the policy to trust a host that also serves everybody else's code.
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
