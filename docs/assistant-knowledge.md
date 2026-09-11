# Salesforce Hub — assistant knowledge base

This file is the ONLY thing the in-site assistant knows about the site beyond its role
definition. It is read once at boot by `utils/assistantPrompt.js` and never re-read per
request, because the prompt has to stay byte-identical for Anthropic's prompt cache to
hit.

**When you add or move a page, edit this file in the same commit.** An assistant that
confidently sends people to a route that no longer exists is worse than one that says it
does not know.

Keep it factual and short. Everything here is spent as input tokens on every single
exchange.

---

## What Salesforce Hub is

A marketplace and toolset for the Salesforce consulting ecosystem: a job board, a
consultant and company directory, a contributed day-rate index, a scope estimator that
produces client-ready quote documents, private messaging, and a community.

It is not affiliated with Salesforce, Inc.

## Who uses it

- **Consultants** — build a profile, browse and apply to roles, contribute day rates,
  take part in the community.
- **Companies** — post roles, review applicants, browse consultants, produce scope
  estimates and quote documents.

An account can hold both roles at once.

## Pages, and what each is for

| Path | What it does |
|---|---|
| `/jobs` | Browse open roles. Filter by cloud, role, seniority, work mode, country and rate. |
| `/jobs/new` | Post a role. Company accounts only. |
| `/consultants` | The consultant directory. Only profiles their owners have made public appear. |
| `/companies` | The company directory. |
| `/rates` | The day-rate index: percentiles and trends by role, seniority and country. |
| `/rates/submit` | Contribute your own day rate. This is what keeps the index alive. |
| `/rates/calculator` | What a day rate is worth over a year once holiday, the bench and running costs come out. Public, stateless, and **before tax**. |
| `/profile/consultant/download/package` | A consultant's CV and rate card, rendered from their profile as a zip. Also `/cv` and `/rate-card` individually. |
| `/quotes/new` | The scope estimator: pick clouds and modules, get a phased plan, team shape, budget and timeline. |
| `/quotes` | Your saved estimates, and the SOW, work-breakdown and summary-deck downloads for each. |
| `/community` | Questions, discussions, articles and wins. Questions can have an accepted answer. |
| `/community/new` | Write a post. |
| `/messages` | Your conversations. Threads are anchored to an application or a specific role. |
| `/dashboard` | Your home: applications, roles, saved jobs, activity. |
| `/profile/consultant` | Build or edit your consultant profile. |
| `/profile/company` | Build or edit your company profile. |
| `/profile/settings` | Account settings, roles, password. |
| `/payments` | What the two paid things cost. |
| `/payments/history` | Your payments and invoices. |
| `/notifications` | Your notifications. |
| `/auth/register` | Create a free account. |
| `/auth/login` | Sign in. |
| `/faq` | Frequently asked questions. |
| `/legal/privacy`, `/legal/terms` | The policies. |

## What is free, and what is not

Free, and staying free: posting a job, applying to one, the rate index, the scope
estimator, messaging, and the community.

Paid, and only these two:

- **Featured job placement** — a flat fee per job for a 30-day window at the top of the
  board. Buying again while a window is open extends it rather than replacing it.
- **Project deposit** — a percentage of an accepted quote's own total, within a fixed
  minimum and maximum, taken from the quote page.

Exact figures are on `/payments`. Do not quote a number from memory; send people there.

## Rules the site follows that people ask about

- **The rate index never publishes a figure derived from fewer than three distinct
  contributors.** Below that floor the sample count is shown and the values are withheld,
  and a suppressed month appears as a gap rather than a zero.
- **A saved quote is never recomputed.** It keeps the catalogue version it was priced
  under, so editing a rate later does not rewrite what a client was already told.
- **There is no open direct-message inbox.** Every conversation is anchored — to an
  application, or to an enquiry about a specific role one of the two parties owns.
- **A consultant profile is only in the public directory if its owner published it**, and
  there is a completeness threshold before it can be published.
- **The rate calculator does not compute tax.** It is deliberate, not an omission: tax
  depends on country, company structure, VAT registration and how someone pays themselves,
  and a figure that looked like tax advice but was a guess would be worse than none. Every
  figure it shows is before tax and labelled so.
- **Generated CVs are rendered, not written.** The CV and rate card format exactly what the
  consultant put on their profile — nothing is summarised, rephrased or invented — so they
  are a starting point to edit, not a finished document. If someone asks for an AI-written
  CV, say the Hub does not do that and explain why: a sentence they never wrote, in a
  document they send to a client.
- **Roles only escalate one way through self-service.** Adding the consultant or company
  role to your own account is possible; removing one, or granting anything privileged,
  is an administrator action.

## Things the assistant genuinely cannot do

It cannot see or change anyone's account, applications, messages, payments or profile. It
cannot look up whether a specific job or person exists. For anything account-specific —
billing, a payment that has not appeared, a bug, personal data, deleting an account — the
answer is to contact support by email, not to guess.
