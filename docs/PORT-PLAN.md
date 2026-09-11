# Port plan

Tracking the port of the DynamicsHub feature set onto Salesforce Hub. The reference has
**551 route handlers**; this app has **103**. This file is the honest ledger of what is
done, what is next, and what is deliberately excluded.

Counts are handlers in the reference implementation, which is a rough proxy for size, not
for value: the 142 admin handlers include a great deal of niche tooling, while the 2 rate
handlers cover a feature that is better here than there.

## Done

| Area | Reference | Here | Notes |
|---|---|---|---|
| Auth & identity | 11 | 11 | Parity. Multi-role, verification, reset |
| Jobs | 8 | 10 | **Ahead** — bulk actions with an `expectedCount` interlock |
| Rate index | 2 | 3 | **Ahead** — n≥3 privacy floor, percentiles, trend with gaps |
| Applications | — | 3 | Declared state machine, append-only audit |
| Quotes & estimator | 29 | 7 | Deterministic half done; AI drafting is not |
| Documents (SOW/WBS/deck) | 17 | — | Generated on demand from the stored estimate |
| Messaging | 6 | 5 | Anchored to a subject rather than keyed per user pair |
| Profiles | 47 | 20 | Core, delivery history, generated CV and rate card, rate calculator |
| Companies | 10 | 3 | Directory and profile |
| Consultants | 33 | 3 | Directory and profile |
| Notifications | 5 | 4 | |
| Community: forum + feed | 29 | 14 | Posts, replies, votes, accepted answers, feed, points, levels |
| Payments | 9 | 7 | Featured job placements and quote deposits; idempotency in the schema |
| In-site assistant | 2 | 1 | Site help on every page, three spend bounds, no transcript storage |
| Admin | 142 | 18 | Users, jobs, moderation, analytics, settings, errors, payments, AI spend, payouts |
| Referrals & commissions | 9 | 6 | Link, append-only ledger, admin payouts. One payee type, not three |
| LinkedIn verification | 9 | 3 | Link-only identity confirmation. No posting, no token stored |
| AI drafting | part of 17 | 3 | Narrative sections only, every draft verified against the figures |
| Design system | — | — | Glassmorphism ported, palette re-based on Salesforce blue |

## Next, in order

1. **Company document templates** (16).
2. **Search across everything** (1) — one box spanning jobs, consultants and companies,
   behind the existing filter builders.
3. **Sales CRM** (22) and **superadmin finance** (41) — only with a concrete reason. These
   are an internal sales tool and an accounting system that happen to live in the same
   repository.
4. **Smaller pieces**: tax service (4), recruiters (3), success stories (2), reviews (1),
    games (13).

## Done since this plan was written

**Payments.** Two products — a featured job placement and a deposit against an accepted
quote — plus invoices, an append-only payment event log and a refund queue in the admin
area. Departures from the reference, each for a stated reason:

- The price is derived by a resolver in `config/payments.js` from a row the payer owns,
  never read from the request. Same conclusion as the reference's "C3" fix, reached
  structurally rather than by validating a submitted number.
- Idempotency is in the SCHEMA — unique keys on `stripe_session_id`, on each fulfilment
  table's `payment_id`, and on the subject of an exclusive product — rather than in a
  `hasFulfillment()` check the next handler can forget to call.
- No automatic refund. A payment that cannot be fulfilled is flagged and worked by a
  person.
- No commission or referral machinery yet: that is item 1 above, and wiring it in before
  there is a referral model would be inventing the requirement.

**The in-site assistant.** A floating helper on every page, answering from
`docs/assistant-knowledge.md` and nothing else. Departures from the reference:

- No provider router and no fallback chain. One provider, one model, pinned. A fallback
  to a second vendor doubles the surface that has to be reasoned about for a feature whose
  whole job is answering "where is the rate index".
- No per-user budget overrides, no admin-editable settings rows, no purchasable top-ups.
  Two caps from the environment, both enforced against one ledger.
- The system prompt is split into a cached stable half and a volatile viewer half, and
  the viewer half carries the account's SHAPE only — no name, no email, no id.
- No conversation tables. Storing transcripts would mean holding whatever people type
  into a support box, indefinitely, for a feature that answers questions about public
  pages.

Still not built, and worth being explicit about: AI drafting of the narrative sections of
a SOW. That is a different feature with a different risk profile — it writes into a
document a client is quoted from — and it needs the reconciliation rules thought through
before it exists, not after.

**Admin, the parts that earn it.** 14 handlers of the reference's 142, chosen by what was
actually missing rather than by what existed there:

- **Moderation** was the real gap. The community and the rate index both accept content
  from anyone with an account and there was no way to take any of it down.
- **Settings**, **analytics** and **error-log housekeeping**, all small and all things you
  reach for at an awkward hour.

Deliberately not ported: the in-app HTTP test runner (this project has Jest and a boot
validator), the newsletter sender, the CRM-adjacent screens (contacts, referrers, sales
agents, recruiters, team, success stories), and the SOW config editor — that last one on
principle, since it would move estimate inputs out of version control and into a form with
no author, diff or review.

**Consultant tooling.** Delivery history (the `consultant_projects` table had been in the
schema since migration 002 with nothing reading or writing it, so the CV's most useful
section was always empty), a generated CV and rate card, and a contract rate calculator.

Two deliberate departures from the reference, both of which made this far smaller than the
8,000 lines it spends there:

- **No LLM in the CV.** It renders the structured profile the consultant already entered.
  Fluent text about a career the model does not know is not worth a sentence they never
  wrote in a document they send to a client.
- **No tax calculation.** The reference's `calculateTaxSavings` is a hard-coded 30%
  against a hard-coded 5%, with its own comment calling it placeholder logic, presented to
  users as a saving. Everything in `utils/contractorEconomics.js` is before tax and says
  so.

**Referrals and commissions.** A shareable link, an append-only commission ledger and an
admin payout screen. Departures from the reference, each for a stated reason:

- **One payee type.** The reference has referrers, sales agents and recruiters, three
  overlapping schemes with three sets of near-identical balance columns and two separate
  credit functions. One payee, one ledger.
- **No balance columns.** `pending_earnings` / `total_earnings` / `paid_earnings` on the
  referrer row is the same mistake this codebase already rejected for points, and worse:
  it is money. The balance is a SUM.
- **Basis points, not DECIMAL percentages.** The reference's float arithmetic forced a
  `+ 0.001` tolerance into every payout comparison.
- **A payout settles everything unpaid**, rather than matching a typed amount FIFO — the
  source of the reference's "requested €3 cannot be matched exactly" refusals.
- **A per-commission cap and a finite earning window.** The reference has neither, so one
  click creates an unbounded claim on somebody's future payments.
- **Session, not a thirty-day tracking cookie.** An attribution that does not survive a
  browser restart is lost; a second cookie following people for a month is a consent
  question nobody asked. The `?ref=` on the registration link covers the common case.

**LinkedIn verification.** Three handlers of the reference's nine, and the difference is
what the badge is allowed to claim.

The reference asks for the member's `linkedin.com/in/...` URL, runs OAuth, extracts the
username from the URL they typed, logs it beside the subject LinkedIn returned — and then
sets `linkedin_verified = true` without comparing the two, because LinkedIn's userinfo
response contains no vanity URL to compare against. The badge asserted that a specific
profile had been verified; what had happened was an OAuth round trip.

So: the badge reads "LinkedIn confirmed", the profile link is labelled as a member-supplied
claim, and the one available cross-check (the name) is shown rather than used as a gate.
Also dropped from the reference's version — the `w_member_social` posting scope, the stored
access token, the retained profile payload, and the six handlers that exist to post on
somebody's behalf. There is no LinkedIn API for connection requests or direct messages, so
nothing here implies outreach.

**AI drafting.** Prose for the narrative sections of a quote, and nothing else.

The reference spends ~8,000 lines putting a model in front of documents; this is three
handlers, because the hard part was never the generation. It was deciding what a generated
paragraph is allowed to say next to figures that reconcile exactly, and then checking it:

- **Every draft is verified.** Any numeral not in the stored estimate fails it, and a
  failing draft is discarded with its reasons shown to the author — never silently retried.
- **The model is never given a figure**, so it cannot repeat one. That, not the prompt's
  politeness, is what makes the rule hold.
- **Drafts live in their own table.** There is no code path from a model response to
  `quotes.estimate`, and nothing reaches a document until a person accepts it.

Still not built, deliberately: AI-written CVs and cover letters. `utils/documents/cvDocx.js`
renders what the consultant wrote and should keep doing so — the reasoning is in the
consultant-tooling entry above and has not changed.

## Excluded

**Dedupe** (65 handlers across `dedupe`, `dedupeApi`, `dedupeAuth`, plus 12 tables and a
matching engine). Excluded at the owner's instruction. It is a separate record-deduplication
product that happens to be embedded in the reference implementation, not part of a
marketplace.

## Standing constraints

Everything ported must satisfy the rules already in `CLAUDE.md`. The ones most often at
risk while porting:

- Schema changes are numbered migrations. Models never create or alter tables.
- One filter builder per browsable thing.
- Money paths are transactional and idempotent, and a payout is never clawed back
  automatically.
- Consent is stamped only by the public registration route.
- Notifications are fire-and-forget with a stable dedupe key.
- Anything user-facing follows `DESIGN.md`, including the contrast floor.
