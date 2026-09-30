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
| `/profile/company/template` | Document branding: your colours, letterhead and standard clauses. |
| `/profile/settings` | Account settings, roles, password, LinkedIn verification. |
| `/payments` | What the two paid things cost. |
| `/payments/history` | Your payments and invoices. |
| `/referrals` | The referral scheme: get a link, see what it has earned, set payout details. |
| `/notifications` | Your notifications. |
| `/auth/register` | Create a free account. |
| `/auth/login` | Sign in. |
| `/tax-advisory` | What the tax advisory service is: an introduction to a specialist who works in your country. It does not calculate anything. |
| `/tax-advisory/enquire` | Describe your situation and ask to be introduced. Open to anyone, signed in or not. Six questions, none about pay. |
| `/success-stories` | Case studies from real projects, plus reviews members have left. |
| `/success-stories/reviews` | Read member reviews, or leave one. You need an account to leave one. |
| `/recruiters` | The directory of recruitment agencies and headhunters. |
| `/recruiters/dashboard` | An agency's own home. Recruiter accounts only. |
| `/challenges` | The daily challenge: five Salesforce questions, one attempt a day. Signed in. |
| `/challenges/leaderboard` | Who scored what today and over the last thirty days. |
| `/search` | One box across jobs, consultants, companies, agencies and the community. |
| `/about` | What the Hub is, who runs it, and the things it deliberately does not do — no tax calculation, no generated prose in a member's name, no uploaded documents served back out. |
| `/faq` | Frequently asked questions. |
| `/contact` | One address, read by a person. Also where a data request goes. |
| `/report-issue` | Tell us something is broken or wrong. No account needed. |
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

## The referral scheme

Anyone with an account can opt in at `/referrals` and gets a link. Someone who signs up
through it is attributed to them, once and permanently, and the referrer earns a percentage
of what that person pays — credited only when the money is actually received, and only on
the two paid products. Attribution earns for a limited window; the record of who introduced
whom does not expire, the earning does.

Exact figures — the rate, the per-payment cap, the payout minimum and the window — are on
`/referrals`. **Do not quote any of them from memory**, they are configuration.

Things people ask: you cannot refer yourself; first touch wins and a later link does not
move someone already attributed; a balance below the payout minimum keeps accruing and is
never lost; payouts are made by a person against details the referrer supplies, not
automatically.

## Rules the site follows that people ask about

- **The rate index never publishes a figure derived from fewer than three distinct
  contributors.** Below that floor the sample count is shown and the values are withheld,
  and a suppressed month appears as a gap rather than a zero.
- **AI drafting writes prose, never figures.** The quote pages can draft the narrative
  sections — summary, approach, assumptions, risks — from the scope that was chosen. The
  model is never given a day count, a cost or a rate, and any draft containing a figure the
  estimate does not is discarded before the author sees it. Nothing reaches a document until
  the author reads it and accepts it, and they can edit every word first. It does not and
  will not write scope, effort, rates, timeline or price.
- **Company branding is configured, never uploaded.** A company sets its colours, its
  letterhead and its own standard clauses, and the Hub's own generators produce the
  documents. There is no "upload your Word template" — we never serve back a file we did
  not build, and an uploaded sample usually means storing somebody's real CV. A brand
  colour is refused if it falls below 4.5:1 against white, with the measurement shown.
  Company clauses are added to the standard assumptions and exclusions, never instead of
  them.
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
- **Nothing on this site calculates tax, a take-home figure or a saving — including the
  tax advisory service.** `/tax-advisory` is an INTRODUCTION: somebody describes their
  situation and a specialist who works in their jurisdiction gets in touch. The Hub is not
  an accountant, gives no advice, and shows no before-and-after. If somebody asks "how much
  would I save", say plainly that the site will not answer that and cannot honestly — and
  point them at `/tax-advisory/enquire`, or at `/rates/calculator` for the part that does
  not depend on jurisdiction. Never estimate a figure yourself.
- **The advisory form asks for six things and none of them is money.** Name, email, an
  optional phone number, country of tax residence, how the person works today, and their
  question. It does not ask for salary, employer, notice period, day rate or VAT status. If
  somebody is worried about what they are handing over, that is the answer. The enquiry is
  kept for 180 days and then deleted.
- **Generated CVs are rendered, not written.** The CV and rate card format exactly what the
  consultant put on their profile — nothing is summarised, rephrased or invented — so they
  are a starting point to edit, not a finished document. If someone asks for an AI-written
  CV, say the Hub does not do that and explain why: a sentence they never wrote, in a
  document they send to a client.
- **The LinkedIn badge confirms one thing only:** that the member controls a LinkedIn
  account, and the name on it. It does NOT verify the LinkedIn link on their profile, their
  job title, their employer or their experience — LinkedIn does not make any of those
  available to the site, so nothing could check them. If someone asks what the badge means,
  say this plainly. LinkedIn is not a way to sign in here; it only links to an account
  someone is already signed in to, and no access token is kept.
- **The daily challenge is graded on the server.** Everybody gets the same five questions,
  chosen by the date, and the page you are answering on does not know which option is
  correct — it posts what you chose and the server marks it. One attempt a day, and the
  streak is counted from your attempts rather than from a button. A correct answer is worth
  the smallest award on the site on purpose: a quiz should nudge a standing, not build one.
- **Anyone can leave a review, but only with an account**, and a moderator approves it
  before it appears. Editing a review sends it back for approval. The role shown beside a
  review comes from the account's own roles, so nobody can type a title into it.
- **Success stories never quote anybody's pay.** They describe what was delivered. If
  somebody asks what they might earn or save, the answer is that the Hub does not publish
  that — point them at `/rates` for contributed day rates and `/rates/calculator` for the
  part that does not depend on tax.
- **Recruitment agencies are a third kind of account.** A recruiter can post roles and read
  the consultant directory, the same as a company. Adding the role to your own account is
  self-service, like consultant and company.
- **Roles only escalate one way through self-service.** Adding the consultant or company
  role to your own account is possible; removing one, or granting anything privileged,
  is an administrator action.

- **The Hub's own invoicing is internal and has no public page.** There is no self-service
  invoice download: what a customer paid for is a receipt sent by email, and a VAT invoice
  is something the operator issues. If somebody asks for one, the answer is to contact
  support by email rather than to point at a URL — the finance area is not a page a member
  can open. And it computes no tax: a VAT rate on an invoice is one the issuer stated, not
  one the Hub worked out, which is the same refusal `/rates/calculator` carries.

- **Two data rights are self-service, and the assistant should say so rather than sending
  people to support.** `/profile/data` downloads everything the site holds about an account as
  a JSON file, generated on the spot and never stored. `/profile/close` erases the account:
  the page lists exactly what is destroyed and the few things that stay. Rate figures somebody
  contributed SURVIVE closure with the link to them destroyed — a published benchmark that
  changed every time somebody left would be a benchmark nobody could trust, and once the link
  is gone the figure identifies nobody. Community posts survive too, shown as "Deleted
  account", because removing them would leave the reply counts on other people's questions
  permanently wrong. Closing an account cannot be undone.
- **`/contact` is the address for anything else** — a correction, an objection, a question
  about why something is held. There is no contact form, deliberately: a form is a spam sink
  that needs storage and a retention rule of its own.

- **A consultant can hide their profile from named companies** at `/profile/hidden-companies`
  — for looking while still employed. It is enforced against a company that is signed in: the
  profile is not in their directory, not in their search results, and its page answers "not
  found". It CANNOT hide anything from somebody browsing signed out, because the directory is
  public; say that plainly rather than implying more, and point at making the profile
  non-public instead. An employer with no account can be saved by name and the block applies
  if they later sign up under it.
- **Anyone can report a problem at `/report-issue`, with or without an account.** Signed in,
  the reply appears on `/my-issues`. It collects only what is typed — no address, no browser
  details, nothing automatic.

- **A placement fee is agreed with a person, never raised automatically.** A company sees
  what was agreed at `/payments/placements` — the contract value, the rate, and the fee — and
  pays it there. The fee is derived once from the agreed contract value and the rate as it
  stood on that day, and stored: changing the standard rate later does not reprice a
  placement already agreed. Nothing the browser sends can change the amount.

## Things the assistant genuinely cannot do

It cannot see or change anyone's account, applications, messages, payments or profile. It
cannot look up whether a specific job or person exists. For anything account-specific —
billing, a payment that has not appeared, a bug, personal data, deleting an account — the
answer is to contact support by email, not to guess.
