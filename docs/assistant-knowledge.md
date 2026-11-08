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

## Where things are in the menu

People name pages by the menu label they see, so these are the labels:

- **Consultant Hub** — the hub page itself (`/consultant-hub`, every consultant tool on one
  page), Find Jobs (`/jobs`), Build Profile (`/profile/settings`, or sign-up
  for a visitor), CV Generator (`/cv-generator`).
- **Companies Hub** — the hub page itself (`/companies-hub`, every hiring tool on one page),
  Browse Talent (`/consultants`), Get SOW Quote (`/quotes/new`), and the
  three engagement models: Staff Augmentation, Project-Based, Managed Services.
- **Services** — Tax Optimization (`/tax-optimization`; employment through the Hub's Albania
  entity, with a take-home calculator once its payroll rates are published), Rate & Salary Index (`/rates`, which links
  to the calculator), SOW Generator (`/quotes/new`), Document Generator.
- The company directory (`/companies`) and the agency directory (`/recruiters`) are in the
  footer, under Companies Hub, not in the top menu.
- There is no Community menu. **Home (`/`) is the community feed** — posts filtered by All,
  Jobs, Questions, Discussions, Articles and Wins — for visitors and members alike. The
  forum itself (`/community`), success stories and, once signed in, the daily challenge are
  in the footer under Community.

## Pages, and what each is for

| Path | What it does |
|---|---|
| `/consultant-hub` | One page listing every consultant tool: jobs, profile, CV generator, rate index and calculator, tax introduction. |
| `/companies-hub` | One page listing every hiring tool: browse consultants, post a role, scope estimate, engagement models, agencies. |
| `/jobs` | Browse open roles. Filter by cloud, role, seniority, work mode, country and rate. |
| `/jobs/new` | Post a role. Company accounts only. |
| `/consultants` | Browse Talent, the consultant directory. Only profiles their owners have made public appear. Filter by cloud, role, official certification, minimum years of experience, availability, country, seniority, work mode, LinkedIn verified, Trailhead and maximum day rate; each option shows how many consultants it would show, and filters apply as you tick them. Cards show the title, years of experience, country, rate (or "Rate on request"), availability, certifications and a short bio. Signed-out visitors see "Sign in to shortlist" and a link to create a company account. Company and recruiter accounts can press ★ Shortlist to keep a private list (only that company sees it; the consultant is not told) and filter to "My shortlist only"; with an open role they also see "Invite to apply", which opens the approach form on the profile; a company with no open role sees "Post a role to invite". On the profile form the seniority level must match the years of experience (Junior 0–2, Mid 3–5, Senior 6–9, Lead 10+); typing the years moves the level to match. |
| `/companies` | The company directory. |
| `/rates` | Rate & Salary Index. "Benchmark my rate" is the Hub's EDITORIAL model (base rate for the role × experience × region, adjusted for certifications, skills, work arrangement, industry and contract type; every figure listed under Methodology) and gives a min, recommended and max day rate with monthly, annual and equivalent-salary figures from the contract rate calculator. Beside it, community data: a trend of the median day rate (30 days, 12 weeks or 12 months) and rates by role; the community index by role, experience and region (median and P25–P75, nothing shown below three people); day-rate budgets and salaries from open job adverts. Consultants share their own rate on the same page (#share): role, contract or permanent, the figure in EUR, years of experience, country optional. |
| `/rates/submit` | Old address of the share form; it now opens `/rates#share`. |
| `/rates/calculator` | What a day rate is worth over a year once holiday, the bench and running costs come out. Public, stateless, and **before tax**. |
| `/profile/consultant/download/package` | A consultant's CV and rate card, rendered from their profile as a zip. Also `/cv` and `/rate-card` individually. |
| `/quotes/new` | SOW Quote Generator. The page opens with "Get your SOW quote in minutes" (Start new quote, View history), how it works, the supported Salesforce clouds and what the SOW contains; the form follows, in four steps: 1. Client info, 2. Scope (every cloud with its modules, searchable, plus AppExchange add-ons and integrations), 3. Shape & options (complexity, customisation, users, orgs, contingency, currency, training and hypercare), 4. Review & generate (man-days, duration, budget, phases, team and timeline). On Scope and Shape a panel shows the running total as you choose, worked out by the same engine as the saved estimate. If you have a quote already, "Use last quote" fills the form from it (a new quote is saved; the old one is unchanged). Save quote keeps it in Your quotes; Download SOW pack saves it and downloads the pack. |
| `/quotes` | Your saved estimates, and the SOW, work-breakdown and summary-deck downloads for each. |
| `/community` | Questions, discussions, articles and wins. Questions can have an accepted answer. |
| `/community/new` | Write a post. |
| `/messages` | Your conversations. Threads are anchored to an application or a specific role. |
| `/dashboard` | Your home: applications, roles, saved jobs, activity. |
| `/dashboard/applications` | My Applications, for consultants: every application with its status (Applied, In review, Shortlisted, Interview, Offer, Hired, Rejected, Withdrawn), whether the company has viewed it, the CV that was sent, the rate you proposed and a timeline. Filter by status, Active or Archived, contract or permanent, or search; add a private note only you can see; message the company or withdraw. When a company makes you an offer, the row shows Accept offer and Decline instead of Withdraw. A nudge appears after 14 days with no reply. With no applications yet it shows roles that match your profile and your saved roles. You get an email when a company moves one of your applications. |
| `/profile/company` | Build or edit your company profile. |
| `/profile/company/template` | Document branding: your colours, letterhead and standard clauses. |
| `/profile/settings` | "Build your profile": one page with sections for Basics, Salesforce (clouds, certifications, Trailhead), Work & rate, Projects & experience, Documents (upload a CV or cover letter as PDF or .docx — older .doc files are not accepted), Privacy, and Account (email, password, roles, LinkedIn, your data). "Import from CV" reads a .docx or .txt CV and shows what it found; nothing is kept until you tick it and save. "Preview public profile" shows the page as a signed-in company sees it. An account without the consultant role sees only the Account section and a button to add the role. `/profile/consultant` redirects here. |
| `/payments` | What the two paid things cost. |
| `/payments/history` | Your payments and invoices. |
| `/referrals` | The referral scheme: get a link, see what it has earned, set payout details. |
| `/s/<code>` | A sales agent's personal sign-up link — a member of the Hub's own team. It lands on `/auth/register`. It is not the referral scheme and earns nobody a commission; it only records whose link brought somebody in, once, at sign-up. An agent sees their link and who came through it on `/dashboard`. Agents are added by an administrator; nobody can make themselves one. |
| `/notifications` | Your notifications. |
| `/auth/register` | Create a free account. |
| `/auth/login` | Sign in. |
| `/tax-optimization` | Tax optimization: keep your clients and location and be employed through the Hub's Albania entity (a technology park with reduced social contributions). How it works in three steps, why Albania, who is eligible, an FAQ, and a calculator that shows the program's Albanian payroll applied to your gross — it runs in the browser and stores nothing, and says the figures are not available yet until the rates are published. Home-country tax obligations still apply; the Hub is not a tax advisor. `/tax-advisory` redirects here. |
| `/tax-optimization/enquire` | Apply to the program ("Apply now" opens it with the program preselected) or ask about your setup ("Contact us"). Open to anyone, signed in or not. A few questions, none about pay; kept for 180 days, then deleted. |
| `/success-stories` | Case studies from real projects, plus reviews members have left. |
| `/success-stories/reviews` | Read member reviews, or leave one. You need an account to leave one. |
| `/recruiters` | The directory of recruitment agencies and headhunters. |
| `/recruiters/dashboard` | An agency's own home. Recruiter accounts only. |
| `/challenges` | The daily challenge: five Salesforce questions, one attempt a day. Signed in. |
| `/challenges/leaderboard` | Who scored what today and over the last thirty days. |
| `/search` | One box across jobs, consultants, companies, agencies and the community. |
| `/services/staff-augmentation`, `/services/project-based`, `/services/managed-services` | The three shapes an engagement can take, and which one fits. Each ends at the consultant directory or the scope estimator. |
| `/services/document-generator` | Document Generator, for companies: a quote becomes an SOW, work breakdown and deck. Nothing is stored. "The SOW pack: three documents from one estimate", with Start new quote and Your quotes. One card per file says what is in it: the SOW (scope, add-ons and integrations; approach, timeline and acceptance criteria; team and commercials; assumptions, exclusions, your terms and validity), the work breakdown (summary, WBS with a weekly Gantt, scope, team and cost) and the deck (title, at a glance, scope, approach, timeline, team and commercials, assumptions and next steps). It also explains why the three agree and shows a sample timeline. How it works, the supported clouds and the full list of SOW sections are on /quotes/new. It points consultants to the CV Generator. |
| `/cv-generator` | CV Generator, for consultants: a CV (.docx) or CV + rate card (.zip) generated from the profile. Choose the sections (projects, employment, certifications, Trailhead, day rate), preview, download. "My documents" lists uploaded CVs and cover letters. The Hub does not write cover letters; upload your own. Visitors are asked to create an account. |
| `/profile/settings` (Work & rate, Privacy) | Where a consultant sets their rates. Three optional figures — a day rate, an hourly rate and the salary a permanent role would have to pay. None is calculated from another. One switch hides all three: the profile then reads "Rate on request" to everyone else, while the figures still drive match scores and the rate card. A private profile is out of the directory, but a company the consultant applied to can still open the profile they were sent. |
| `/admin/analytics` | Administrators: the site's own counts (visitors and sign-ups by country, the daily challenge, monthly growth), with screens for Google Analytics 4 and Cloudflare Web Analytics beside it where those are configured. |
| `/admin/applications` | Superadmins only: the state of every application on the site — never its content — and how many have sat untouched. |
| `/admin/tests` | An administrator's panel that makes real requests against this site's own routes and records what they answered. Admin accounts. |
| `/dashboard/applicants` | An employer's board: every application across every role they have posted, by stage, with a filter for the role and how recently somebody applied. Company accounts. Moving somebody between stages happens on the application's own page. |
| `/about` | What the Hub is, who runs it, and the things it deliberately does not do — no tax calculation, no generated prose in a member's name, no uploaded documents served back out. |
| `/faq` | Frequently asked questions. |
| `/contact` | One address, read by a person. Also where a data request goes. |
| `/report-issue` | Tell us something is broken or wrong, or suggest something. No account needed. You can say how badly it affects you and attach up to three screenshots, which are deleted 90 days after the report is closed. A suggestion can be offered for the ideas page with a tick box. |
| `/ideas` | Suggestions people agreed to share, published after somebody here read them, with no names. Signed-in members can vote once on each. |
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

- **Analytics, and the cookie question.** The site always counts page views per country
  per day itself, with no cookie and no identifier. A deployment may also run Cloudflare
  Web Analytics (no cookie, no consent needed) and Google Analytics 4. GA4 sets cookies, so
  where it is switched on visitors are asked first — "Allow analytics" or "Decline", the
  same size — and nothing loads from Google until they allow it. The answer can be changed
  any time from "Analytics choices" at the foot of every page. Where that link is absent,
  GA4 is not running. Administrators and the sign-in pages are never measured. Do not say
  which providers this deployment runs; the privacy policy (`/legal/privacy`) states it.

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
- **The only take-home figure on this site is the calculator on `/tax-optimization`**, and
  it is narrow: it applies the Albania program's own payroll to a gross the visitor types,
  in their browser, and only once the program's rates are published (until then it says
  "Figures aren't available yet" and points to the enquiry form). It is not anybody's tax position — home-country tax obligations
  still apply — and the Hub is not an accountant and gives no advice. If somebody asks "how
  much would I save", point them at that calculator and at `/tax-optimization/enquire`, and
  say a tax advisor in their country has to confirm it. Never estimate a figure yourself.
- **The form asks a few things and none of them is money.** Name, email, an
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
