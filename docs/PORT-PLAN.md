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
| Profiles | 47 | 15 | Core done; CV builder and rate calculator are not |
| Companies | 10 | 3 | Directory and profile |
| Consultants | 33 | 3 | Directory and profile |
| Notifications | 5 | 4 | |
| Community: forum + feed | 29 | 14 | Posts, replies, votes, accepted answers, feed, points, levels |
| Admin | 142 | 8 | Users, jobs, error log, visitor geography, payments and refunds |
| Payments | 9 | 7 | Featured job placements and quote deposits; idempotency in the schema |
| Design system | — | — | Glassmorphism ported, palette re-based on Salesforce blue |

## Next, in order

1. **In-site AI assistant** (2 handlers, but a real feature) — the widget in the corner of
   every page. Needs an ANTHROPIC_API_KEY and must degrade to hidden without one, the way
   e-mail already degrades to logging. Deferred at the owner's instruction, after payments.
2. **Admin, the parts that earn it** (~20 of 142) — settings, analytics, an issue tracker.
   Not the in-app HTTP test runner: this project has Jest and a boot validator.
3. **Consultant tooling** (part of 33) — CV builder, rate calculator, document packages.
4. **Referrals & commissions** (9) — every credit path through one function that pays
   referrer and agent together, all mutations transactional and idempotent, no automatic
   clawback.
5. **LinkedIn verification** (9) — OAuth to prove identity, never as a sign-in method. Note
   there is no API for sending connection requests or DMs; any feature implying automated
   outreach would be a lie.
6. **Document generator for CVs and cover letters** (17).
7. **Company document templates** (16).
8. **Search across everything** (1) — one box spanning jobs, consultants and companies,
   behind the existing filter builders.
9. **Sales CRM** (22) and **superadmin finance** (41) — only with a concrete reason. These
   are an internal sales tool and an accounting system that happen to live in the same
   repository.
10. **Smaller pieces**: tax service (4), recruiters (3), success stories (2), reviews (1),
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
- No commission or referral machinery yet: that is item 4 above, and wiring it in before
  there is a referral model would be inventing the requirement.

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
