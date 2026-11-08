#!/usr/bin/env node
'use strict';

/**
 * Development seed data. REFUSES TO RUN IN PRODUCTION.
 *
 * NOTE on consent: `User.create` is called here WITHOUT a consent argument, so seeded
 * accounts carry no accepted-terms stamp. That is deliberate and must stay that way —
 * only a real person clicking the registration form can produce a consent record.
 * Seeded accounts are force-verified instead, exactly as an admin-created account is,
 * because login refuses unverified non-admin accounts.
 */
/* eslint-disable no-await-in-loop -- seeding is intentionally sequential: each step uses ids created by the previous one. */
const { pool, promisePool } = require('../config/database');
const config = require('../config/config');
/*
 * THE GUARD.
 *
 * This script creates 24 consultant profiles, 6 companies, 30 jobs — and 24 rate
 * submissions. On a development machine that is convenient. On a live site it is three
 * separate lies told to real visitors:
 *
 * 1. A PUBLIC DIRECTORY OF PEOPLE WHO DO NOT EXIST, with skills, day rates and work
 *    histories that employers would contact.
 * 2. A PUBLISHED RATE INDEX built from invented figures. The privacy floor counts PEOPLE and
 *    suppresses anything under three contributors precisely so that a published benchmark
 *    means something; twenty-four fabricated rows sail past it and produce a real-looking
 *    percentile nobody contributed to.
 * 3. Job postings nobody is hiring for.
 *
 * `scripts/create-admin.js` exists for the production case and says so at the top. Nothing
 * enforced the difference until now: the only thing standing between a live site and a
 * directory of invented people was somebody remembering which command to type.
 *
 * SEED_ALLOW_PRODUCTION=yes is the override, spelled out rather than a bare truthy value,
 * for the one legitimate case: a staging deployment that runs with NODE_ENV=production
 * because it must behave like the real thing.
 */
if (config.isProduction && process.env.SEED_ALLOW_PRODUCTION !== 'yes') {
  console.error('');
  console.error('  Refusing to seed: NODE_ENV is production.');
  console.error('');
  console.error('  This would publish 24 consultant profiles for people who do not exist and');
  console.error('  24 invented rate figures into an index that is presented as contributed by');
  console.error('  real consultants.');
  console.error('');
  console.error('  For a live site use:  npm run create-admin -- you@example.com "Your Name"');
  console.error('  If this really is a staging box: SEED_ALLOW_PRODUCTION=yes npm run seed');
  console.error('');
  process.exit(1);
}

const User = require('../models/User');
const ConsultantProfile = require('../models/ConsultantProfile');
const CompanyProfile = require('../models/CompanyProfile');
const Job = require('../models/Job');
const Application = require('../models/Application');
const Skill = require('../models/Skill');
const RateSubmission = require('../models/RateSubmission');
const Post = require('../models/Post');
const Quote = require('../models/Quote');
const Conversation = require('../models/Conversation');
const Notification = require('../models/Notification');
const SuccessStory = require('../models/SuccessStory');
const SiteReview = require('../models/SiteReview');
const Challenge = require('../models/Challenge');
const Referral = require('../models/Referral');
const RecruiterProfile = require('../models/RecruiterProfile');
const IssueReport = require('../models/IssueReport');
const TaxEnquiry = require('../models/TaxEnquiry');
const CrmLead = require('../models/CrmLead');
const FinanceClient = require('../models/FinanceClient');
const FinanceInvoice = require('../models/FinanceInvoice');
const FinanceCost = require('../models/FinanceCost');
const PlacementQuote = require('../models/PlacementQuote');
const SalesAgent = require('../models/SalesAgent');
const CompanyTemplate = require('../models/CompanyTemplate');
const { calculateEstimation, reconciliationProblems } = require('../utils/sowEstimation');
const { catalogueVersion } = require('../config/estimation');
const { dailySetFor, serverDate } = require('../config/challenges');
const { PRIVACY_VERSION } = require('../config/legal-versions');
const { sync: syncCategories } = require('./sync-categories');
const { ROLE_SLUGS, ROLE_CATEGORIES, baseDayRate, roleLabel, seniorityLabel, seniorityForYears } = require('../config/roleTaxonomy');
const { ALL_MODULES, CLOUD_FAMILIES } = require('../config/cloudFamilies');
const { ALL_CERTIFICATIONS } = require('../config/certifications');

const SEED_PASSWORD = process.env.SEED_PASSWORD || 'Password123';

/*
 * Job descriptions that differ from card to card.
 *
 * Every seeded role used to carry the same two sentences, so the board's two-line preview
 * read identically down the whole page and the site looked fake at a glance. These are
 * assembled from the row's own facts — company, role, clouds, shape — plus a programme and a
 * set of duties chosen by the role's category, deterministically from the index so a seed is
 * reproducible. Still invented: the production guard above is what keeps them off a live site.
 */
const PROGRAMMES = [
  'a multi-country rollout replacing three legacy CRMs',
  'the second phase of a programme that went live in the spring',
  'a greenfield implementation for a newly merged business',
  'an org consolidation after an acquisition',
  'a service transformation with a hard regulatory deadline',
  'a re-platforming of quoting and billing ahead of a new pricing model'
];
const DUTIES_BY_CATEGORY = {
  'Functional Consultants': 'run discovery workshops, turn requirements into user stories, configure the solution and take the business through UAT',
  'Technical Roles': 'build and review Apex, LWC and Flow, own the integration patterns and keep the deployment pipeline green',
  'AI & Agentforce': 'design agents and prompt templates, ground them in Data Cloud and measure them against real cases before go-live',
  'Architecture & Leadership': 'own the target architecture, the data model and the integration landscape, and make the trade-offs the delivery team builds on',
  'Program & Business': 'own the plan, the RAID log and the steering pack, and keep a multi-vendor team delivering to one roadmap',
  'HR & Recruitment': 'build the hiring pipeline for the programme and work with delivery leads on the profiles they actually need'
};
const CATEGORY_BY_ROLE = Object.fromEntries(ROLE_CATEGORIES.flatMap((c) => c.roles.map((r) => [r.value, c.category])));

function jobDescription({ companyName, role, seniority, moduleLabels, isContract, durationMonths, workMode, index }) {
  const duties = DUTIES_BY_CATEGORY[CATEGORY_BY_ROLE[role]] || 'work with the delivery team from design through handover';
  const clouds = moduleLabels.length ? moduleLabels.join(', ') : 'the core platform';
  const shape = isContract
    ? `This is a ${durationMonths}-month contract, ${workMode === 'remote' ? 'fully remote' : workMode === 'hybrid' ? 'hybrid with two days a week on site' : 'on site with the client team'}.`
    : `This is a permanent role in a team that ${index % 2 ? 'is growing its Salesforce practice' : 'owns the platform end to end'}.`;
  const level = seniority === 'mid' ? 'mid-level' : seniority;
  return `${companyName} needs a ${level} ${roleLabel(role)} for ${PROGRAMMES[index % PROGRAMMES.length]}, working across ${clouds}.\n\n` +
    `You will ${duties}. ${shape}\n\n` +
    'Tell us about a programme you delivered on these clouds and what you would do differently next time.';
}

/*
 * Consultant bios that differ from card to card, for the same reason the job descriptions do:
 * one sentence repeated down the directory made it look fake at a glance. Built from the row's
 * own role, years and clouds plus a sector and a strength chosen by the role's category,
 * deterministically from the index. Still invented — the production guard keeps them off a
 * live site.
 */
const SECTORS = [
  'manufacturing', 'financial services', 'retail and consumer goods', 'the public sector',
  'healthcare and life sciences', 'SaaS and high tech', 'energy and utilities', 'professional services'
];
const RECENT_WORK = [
  'a multi-country rollout that replaced three legacy CRMs',
  'an org merge after an acquisition, with two sales teams on one process',
  'a contact-centre transformation with a regulatory deadline',
  'a quote-to-cash rebuild for a new subscription pricing model',
  'a customer portal used by twelve thousand dealers',
  'a data migration of fifteen years of account history',
  'stabilising an org that had grown three hundred flows and no documentation'
];
const STRENGTHS_BY_CATEGORY = {
  'Functional Consultants': [
    'Most at home in discovery workshops, turning a messy process into one a sales team will actually use.',
    'Known for UAT plans the business finishes and training material that outlives the project.',
    'Pushes back on customisation when configuration will do, and writes down why.'
  ],
  'Technical Roles': [
    'Writes Apex and LWC with tests that mean something, and leaves a pipeline the next team can run.',
    'Happiest untangling an integration nobody has documented since go-live.',
    'Reviews code the way they would want theirs reviewed: specific, quick and kind.'
  ],
  'AI & Agentforce': [
    'Measures an agent against real cases before go-live rather than against a demo script.',
    'Spends as much time on the data an agent is grounded in as on the prompt itself.'
  ],
  'Architecture & Leadership': [
    'Makes the trade-offs early and in writing, so the delivery team builds on decisions rather than guesses.',
    'Has sat on both sides of a design authority and knows which questions slow a programme down.'
  ],
  'Program & Business': [
    'Keeps a multi-vendor team on one plan and a steering committee on one page.',
    'Runs a RAID log people actually read, and escalates early rather than loudly.'
  ],
  'HR & Recruitment': [
    'Hires for the profile a programme actually needs, not the one on the first draft of the brief.',
    'Works with delivery leads to keep a hiring pipeline moving through the busy months.'
  ]
};

function consultantBio({ role, years, clouds, index }) {
  const strengths = STRENGTHS_BY_CATEGORY[CATEGORY_BY_ROLE[role]] || STRENGTHS_BY_CATEGORY['Functional Consultants'];
  // Opens with what is particular to this person: the card already prints the role and the
  // years above the bio, and two clamped lines repeating them would say nothing new.
  return `Most recently on ${RECENT_WORK[(index * 3) % RECENT_WORK.length]}, across ${clouds.join(', ')}. ` +
    `${strengths[index % strengths.length]} ` +
    `${years === 1 ? 'A first year' : `${years} years`} in the ecosystem as a ${roleLabel(role)}, mostly in ${SECTORS[index % SECTORS.length]}.`;
}

const SKILL_POOL = [
  'Apex', 'SOQL', 'LWC', 'Aura', 'Flow', 'CPQ', 'Billing', 'Sales Cloud', 'Service Cloud',
  'Experience Cloud', 'Data Cloud', 'MuleSoft', 'Tableau', 'CRM Analytics', 'Agentforce',
  'Einstein Bots', 'Field Service', 'OmniStudio', 'Bulk API', 'Platform Events',
  'Change Data Capture', 'SFDX', 'Gearset', 'Copado', 'Data Loader', 'Marketing Cloud',
  'Pardot', 'AMPscript', 'Commerce Cloud', 'Sharing Rules'
];

const COMPANIES = [
  ['Northwind Cloud Partners', 'consulting_partner', 'DE', 'Berlin', '51-200'],
  ['Adriatic Digital', 'consulting_partner', 'AL', 'Tirana', '11-50'],
  ['Meridian Retail Group', 'end_customer', 'NL', 'Amsterdam', '1000+'],
  ['Helix Health', 'end_customer', 'IE', 'Dublin', '201-1000'],
  ['Cobalt ISV Labs', 'isv', 'GB', 'London', '11-50'],
  ['Talent Bridge', 'staffing', 'PL', 'Warsaw', '51-200']
];

const FIRST = ['Ana', 'Marko', 'Elira', 'Tomas', 'Sofia', 'Jonas', 'Petra', 'Luka', 'Ines', 'Mateo', 'Nora', 'Filip'];
const LAST = ['Berisha', 'Novak', 'Hoxha', 'Kovac', 'Meier', 'Dubois', 'Rossi', 'Nowak', 'Larsen', 'Silva', 'Horvat', 'Krasniqi'];
/*
 * A country and a city that is actually in it. Every seeded row used to carry
 * `city: 'Remote'` with an independently random work mode, so a card could read
 * "Remote, PL" and "On site" at the same time. A city is now set only when somebody has
 * to travel to it.
 */
const PLACES = [
  ['DE', 'Berlin'], ['AL', 'Tirana'], ['NL', 'Amsterdam'], ['IE', 'Dublin'], ['GB', 'London'],
  ['PL', 'Warsaw'], ['ES', 'Madrid'], ['IT', 'Milan'], ['PT', 'Lisbon'], ['RO', 'Bucharest']
];

/*
 * Billable days behind an annual figure.
 *
 * A permanent role stores a SALARY in the same columns a contract stores a DAY RATE, and
 * the seed wrote a day rate into both — so the site published "468 EUR/yr" beside a job
 * titled "12 month contract" that was marked permanent. This is only a seed's arithmetic,
 * deliberately crude, but the figure it produces has to be the right ORDER OF MAGNITUDE or
 * the site looks broken to anybody who opens it.
 */
const BILLABLE_DAYS_PER_YEAR = 220;

/*
 * An employee costs less in salary than a contractor bills, because the salary is not the
 * whole cost: holiday, sick pay, employer contributions and the bench all sit on top of it.
 * 0.6 is a rough market ratio and nothing here depends on it being right — it exists so a
 * seeded permanent role lands in a range a reader recognises instead of quoting contractor
 * gross as a salary. This is seed data, not a benchmark: the real one is the rate index,
 * which is built from figures people contributed.
 */
const SALARY_TO_CONTRACT_RATIO = 0.6;

function pick(list, n) {
  const copy = [...list];
  const out = [];
  for (let i = 0; i < n && copy.length; i += 1) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function seed() {
  console.log('Seeding development data...');

  /*
   * ACCOUNTS ARE IDEMPOTENT. CONTENT IS NOT.
   *
   * Users and profiles are looked up by email before they are written, so a second run
   * leaves them alone — but jobs, rate submissions and posts were appended unconditionally.
   * Running `npm run seed` twice therefore produced 60 jobs, half of them written under
   * whatever the generator looked like the first time. That is exactly how a corrected
   * generator gets judged on the rows it did not write.
   *
   * There is no merge to attempt here: this is a development fixture, and the fix is to
   * say so and stop rather than to double it.
   */
  const [[{ existingJobs }]] = await promisePool.query('SELECT COUNT(*) AS existingJobs FROM jobs');
  if (existingJobs > 0) {
    console.log(`\n  ${existingJobs} jobs already exist, so this database has been seeded.`);
    console.log('  Seeding again would append a second set rather than replace the first.');
    console.log('  To start clean: drop the database, then `npm run migrate && npm run seed`.\n');
    return;
  }

  const skills = await Skill.findOrCreateMany(SKILL_POOL, { category: 'salesforce' });
  console.log(`  ${skills.length} skills`);

  // --- admin -------------------------------------------------------------------
  let admin = await User.findByEmail('admin@example.com');
  if (!admin) {
    admin = await User.create({
      email: 'admin@example.com',
      password: SEED_PASSWORD,
      name: 'Platform Admin',
      roles: ['admin']
    });
    await User.setEmailVerified(admin.id);
    await User.setSuperadmin(admin.id, true);
    console.log('  admin@example.com created');
  }

  // --- companies ---------------------------------------------------------------
  const companyUsers = [];
  for (const [name, type, country, city, size] of COMPANIES) {
    const emailAddress = `hiring@${name.toLowerCase().replace(/[^a-z]+/g, '')}.example.com`;
    let user = await User.findByEmail(emailAddress);
    if (!user) {
      user = await User.create({
        email: emailAddress,
        password: SEED_PASSWORD,
        // The account and the profile are the same organisation. Appending "Recruiting"
        // made the menu say one name and the profile page another.
        name,
        roles: ['company']
      });
      await User.setEmailVerified(user.id);
    }
    await CompanyProfile.ensureExists(user.id, name);
    await CompanyProfile.update(user.id, {
      company_name: name,
      company_type: type,
      country,
      city,
      company_size: size,
      tagline: `${type.replace('_', ' ')} in the Salesforce ecosystem`,
      about: `${name} works across the Salesforce platform.\n\nThe team delivers design, build and support for customers in ${city} and across ${country}.`,
      is_public: 1
    });
    companyUsers.push(user);
  }
  console.log(`  ${companyUsers.length} companies`);

  // --- consultants -------------------------------------------------------------
  const consultantUsers = [];
  for (let i = 0; i < 24; i += 1) {
    /*
     * `LAST[(i * 7) % 12]` repeated exactly on the second pass: 84 is a multiple of 12, so
     * consultant 13 got consultant 1's name and every one of the 24 appeared twice. The
     * offset by pass is what breaks the cycle.
     */
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i + Math.floor(i / FIRST.length)) % LAST.length]}`;
    const emailAddress = `consultant${i + 1}@example.com`;

    let user = await User.findByEmail(emailAddress);
    if (!user) {
      user = await User.create({ email: emailAddress, password: SEED_PASSWORD, name, roles: ['consultant'] });
      await User.setEmailVerified(user.id);
    }

    const role = ROLE_SLUGS[i % ROLE_SLUGS.length];
    /*
     * The level comes FROM the years, through the same bands the profile form enforces.
     * Picked independently they produced "Junior Apex Developer · 18 years experience" on the
     * directory card — a seed contradicting the label it was printed beside.
     */
    const years = randomInt(1, 18);
    const seniority = seniorityForYears(years);
    const clouds = pick(CLOUD_FAMILIES, randomInt(1, 3));
    const base = baseDayRate(role) || 600;
    const [homeCountry, homeCity] = PLACES[i % PLACES.length];
    const consultantWorkMode = ['remote', 'hybrid', 'onsite'][randomInt(0, 2)];

    await ConsultantProfile.ensureExists(user.id);
    /*
     * One figure for the years, used in the bio AND the column, and a bio assembled from the
     * row's own facts so no two cards read the same. The headline is a professional title
     * ("Senior CPQ & Billing Consultant"), not the seniority word the card already shows.
     */
    await ConsultantProfile.update(user.id, {
      headline: `${seniorityLabel(seniority)} ${roleLabel(role)}`,
      bio: consultantBio({ role, years, clouds: clouds.map((f) => f.label), index: i }),
      primary_role: role,
      seniority,
      years_experience: years,
      country: homeCountry,
      // Same rule as a job: a city is where somebody is, not a work mode wearing its name.
      city: consultantWorkMode === 'remote' ? null : homeCity,
      work_mode: consultantWorkMode,
      day_rate: Math.round(base * (0.75 + Math.random() * 0.6)),
      currency: 'EUR',
      availability: ['immediate', 'two_weeks', 'one_month', 'not_available'][randomInt(0, 3)]
    });

    await Skill.setForConsultant(user.id, pick(skills, randomInt(3, 8)).map((s) => s.id));
    for (const cert of pick(ALL_CERTIFICATIONS, randomInt(0, 3))) {
      await ConsultantProfile.addCertification(user.id, { name: cert, earnedOn: `${randomInt(2019, 2025)}-06-01` });
    }
    await ConsultantProfile.addExperience(user.id, {
      company: COMPANIES[i % COMPANIES.length][0],
      title: `${seniorityLabel(seniority)} ${roleLabel(role)}`,
      startedOn: `${randomInt(2016, 2023)}-01-01`,
      isCurrent: true,
      description: 'Delivery across multiple clouds.'
    });
    /*
     * Clouds, languages, where they will work and what kind of engagement. Listing a profile
     * now needs at least one cloud (ConsultantProfile.listingProblems), so these come before
     * setPublic — without them every seeded profile would be refused and Browse Talent empty.
     */
    await ConsultantProfile.setClouds(user.id, clouds.map((f) => f.value));
    await ConsultantProfile.setLanguages(user.id, [
      { language: 'English', level: i % 3 === 0 ? 'native' : 'fluent' },
      ...(i % 2 ? [{ language: ['German', 'Italian', 'Spanish', 'Albanian', 'Dutch', 'French'][i % 6], level: 'native' }] : [])
    ]);
    await ConsultantProfile.setWorkCountries(user.id, [homeCountry, ...(i % 3 === 0 ? ['DE', 'NL'] : [])]);
    await ConsultantProfile.update(user.id, {
      open_to_contract: 1,
      open_to_permanent: i % 3 === 0 ? 1 : 0,
      trailhead_rank: ['Ranger', 'Double Star Ranger', 'Mountaineer', 'All Star Ranger'][i % 4],
      trailhead_badges: 40 + ((i * 37) % 300)
    });
    await ConsultantProfile.recomputeCompleteness(user.id);
    await ConsultantProfile.setPublic(user.id, true);

    consultantUsers.push(user);
  }
  console.log(`  ${consultantUsers.length} consultants`);

  // --- jobs --------------------------------------------------------------------
  let jobCount = 0;
  for (let i = 0; i < 30; i += 1) {
    const company = companyUsers[i % companyUsers.length];
    const role = ROLE_SLUGS[(i * 3) % ROLE_SLUGS.length];
    const base = baseDayRate(role) || 600;
    const seniority = ['mid', 'senior', 'lead'][randomInt(0, 2)];

    /*
     * ONE DECISION DRIVES THE WHOLE ROW.
     *
     * Every field here used to be rolled independently, and the row contradicted itself
     * four ways at once: a title saying "12 month contract" on a row marked permanent, a
     * `duration_months` that disagreed with the number in its own title, a day rate
     * published as an annual salary, and `city: 'Remote'` beside a work mode of "onsite".
     *
     * Seed data is the first thing anybody sees. A row that argues with itself makes the
     * whole product look untrustworthy, and none of it is the reader's fault to untangle.
     */
    const isContract = i % 4 !== 0;
    const durationMonths = isContract ? randomInt(3, 12) : null;
    const workMode = ['remote', 'hybrid', 'onsite'][randomInt(0, 2)];
    const [country, cityName] = PLACES[i % PLACES.length];
    const shape = isContract ? `${durationMonths} month contract` : 'permanent role';
    // A salary is an annual figure. Rounded to the nearest thousand, because nobody
    // advertises a salary of 128,700.
    const annual = (day) =>
      Math.round((day * BILLABLE_DAYS_PER_YEAR * SALARY_TO_CONTRACT_RATIO) / 1000) * 1000;
    const minDay = Math.round(base * 0.85);
    const maxDay = Math.round(base * 1.25);

    // Chosen before the row is written, so the description can name the clouds it is tagged with.
    const jobModules = pick(ALL_MODULES, randomInt(1, 3));
    const job = await Job.create(company.id, {
      // `roleLabel`, not the slug with its hyphens swapped for spaces: that produced
      // "pmo — 11 month contract" and "cpq consultant" in lower case on every card. The
      // seniority is a field of its own and already renders as its own badge.
      title: `${roleLabel(role)} — ${shape}`,
      description: jobDescription({
        companyName: COMPANIES[i % COMPANIES.length][0],
        role,
        seniority,
        moduleLabels: jobModules.map((m) => m.label),
        isContract,
        durationMonths,
        workMode,
        index: i
      }),
      role,
      seniority,
      engagement_type: isContract ? 'contract' : 'permanent',
      work_mode: workMode,
      country,
      // A remote role has no city. Naming one and calling it remote is the contradiction.
      city: workMode === 'remote' ? null : cityName,
      rate_min: isContract ? minDay : annual(minDay),
      rate_max: isContract ? maxDay : annual(maxDay),
      currency: 'EUR',
      rate_visible: true,
      duration_months: durationMonths,
      status: 'open'
    });

    /*
     * Spread the publication dates over the last six weeks.
     *
     * Every seeded role was published at the instant the seed ran, which made a board of
     * thirty roles look like thirty roles posted today — and made the "Posted in the last
     * 24 hours" filter return all of them, so the one thing it exists to do was
     * undemonstrable. The dates are deterministic from the index so a given seed is
     * reproducible.
     */
    const daysOld = (i * 7) % 42;
    if (daysOld > 0) {
      await promisePool.query(
        'UPDATE jobs SET published_at = DATE_SUB(NOW(), INTERVAL ? DAY), created_at = DATE_SUB(NOW(), INTERVAL ? DAY) WHERE id = ?',
        [daysOld, daysOld, job.id]
      );
    }

    await Skill.setForJob(job.id, pick(skills, randomInt(2, 6)).map((s) => s.id));
    await Job.setModules(job.id, jobModules.map((m) => m.value));
    jobCount += 1;
  }
  console.log(`  ${jobCount} jobs`);

  // --- applications ------------------------------------------------------------
  /*
   * WITHOUT THESE THE WHOLE HIRING SIDE READS AS MISSING.
   *
   * The seed created jobs and consultants and never connected them, so every company
   * dashboard showed six zeroes, every "Applicants" link led to an empty list, and the
   * pipeline — which has existed since the first migration, with its own state machine and
   * event log — was reported as a feature that had not been built. A fixture that leaves
   * the central workflow at zero is a fixture that hides it.
   *
   * Statuses are walked through `Application.transition`, never written directly: the
   * state machine is the thing being demonstrated, and a seed that bypassed it could
   * produce a row the application itself would refuse to create.
   */
  const { rows: openJobs } = await Job.browse({ status: 'open' }, { limit: 200 });
  const PIPELINE_PATHS = [
    [],
    ['reviewing'],
    ['reviewing', 'shortlisted'],
    ['reviewing', 'shortlisted', 'interviewing'],
    ['reviewing', 'shortlisted', 'interviewing', 'offered'],
    ['reviewing', 'shortlisted', 'interviewing', 'offered', 'hired'],
    ['reviewing', 'rejected']
  ];

  let applicationCount = 0;
  for (let j = 0; j < openJobs.length; j += 1) {
    const job = openJobs[j];
    const applicants = pick(consultantUsers, randomInt(0, 5));

    for (let a = 0; a < applicants.length; a += 1) {
      const consultant = applicants[a];
      const { applicationId } = await Application.apply(job.id, consultant.id, {
        coverLetter:
          'I have delivered this kind of programme before and can start within the notice ' +
          'period on my profile.\n\nHappy to talk through the specifics whenever suits.',
        dayRate: Math.round((Number(job.rate_min) || 600) * (0.95 + Math.random() * 0.2)),
        currency: 'EUR'
      });
      applicationCount += 1;

      // The employer walks it forward. A path of [] leaves it at "submitted", which is
      // the state most of a real board is in.
      for (const step of PIPELINE_PATHS[(j + a) % PIPELINE_PATHS.length]) {
        await Application.transition(applicationId, job.company_user_id, step, { actorIsEmployer: true });
      }
    }
  }
  console.log(`  ${applicationCount} applications`);

  // --- rate submissions --------------------------------------------------------
  // Enough contributors per bucket that some buckets clear the privacy floor and
  // others deliberately do not, so the suppression path is visible in development.
  let rateCount = 0;
  for (const user of consultantUsers) {
    const profile = await ConsultantProfile.findByUserId(user.id);
    if (!profile || !profile.primary_role) continue;
    await RateSubmission.submit(user.id, {
      role: profile.primary_role,
      seniority: profile.seniority || 'senior',
      engagementType: 'contract',
      workMode: profile.work_mode,
      country: profile.country || 'DE',
      amount: Math.round(Number(profile.day_rate) || 600),
      currency: 'EUR'
    });
    rateCount += 1;
  }
  console.log(`  ${rateCount} rate submissions`);

  // --- community ---------------------------------------------------------------
  // The category tree is derived from config, so it is synced rather than invented here.
  await syncCategories();
  const categories = await Post.listCategories();
  const categoryBySlug = Object.fromEntries(categories.map((c) => [c.slug, c.id]));

  const SEED_POSTS = [
    ['question', 'revenue-cloud', 'CPQ price rules firing in the wrong order — what am I missing?',
      '<p>I have two price rules on the same quote line, and the discount one evaluates before the cost one, which gives me a margin that is wrong by exactly the discount. Evaluation order is set, both are active, and calculator sequence looks right. What is the thing everybody misses here?</p>'],
    ['question', 'integration', 'Bulk API 2.0 job stuck in UploadComplete for 40 minutes',
      '<p>Ingest job with about 900k records, CSV, upsert on an external id. It moved to UploadComplete and has sat there since. No failed records, no error. Is this queueing behind something, or have I done something wrong with the batching?</p>'],
    ['discussion', 'architecture', 'When is a second org actually the right answer?',
      '<p>Every consolidation project I have been on started as "we will merge the orgs" and ended as "we will keep both and integrate". I am starting to think a second org is more often correct than we admit. Curious where other people draw the line.</p>'],
    ['article', 'devops', 'A deployment checklist that has survived four programmes',
      '<p>Nothing clever here, just the list I actually run before a production deployment, and why each line is on it. Most of them exist because of a specific outage.</p><p>The short version: validate against a full-copy sandbox with production data volumes, run the destructive changes as a separate step, and never let a deployment be the first time a permission set is applied.</p>'],
    ['article', 'careers', 'What a day rate is actually made of',
      '<p>A day rate is not a salary divided by 220. It has to cover the gaps between contracts, your own pension, sick days you do not get paid for, insurance, accounting, and the training nobody else is buying you.</p><p>Working backwards from take-home is the only way to know whether a number is good.</p>'],
    ['win', 'sales-cloud', 'Go-live: 1,400 users across nine countries',
      '<p>Eighteen months, three false starts and one very long weekend. Data migration reconciled to the penny on the first run, which I still do not entirely believe.</p>'],
    ['win', 'certification', 'Passed Integration Architect on the second attempt',
      '<p>Failed the first one by a few percent, mostly on the async patterns. Second time round I built the thing instead of reading about it. That was the difference.</p>'],
    ['question', 'data-cloud', 'Identity resolution matching too aggressively on shared household emails',
      '<p>Ruleset matches on email plus last name. Families sharing an address and a mailbox are collapsing into one unified profile. Has anyone found a match rule that survives this without going full deterministic?</p>'],
    ['discussion', 'agentforce', 'Is anyone running Agentforce in production yet, honestly?',
      '<p>Plenty of demos, very few war stories. If you have it live with real customers, what broke that you did not expect?</p>']
  ];

  let postCount = 0;
  for (let i = 0; i < SEED_POSTS.length; i += 1) {
    const [kind, categorySlug, title, body] = SEED_POSTS[i];
    const categoryId = categoryBySlug[categorySlug] || categories[0].id;
    const author = consultantUsers[(i * 5) % consultantUsers.length];

    const created = await Post.create(author.id, { categoryId, kind, title, body });
    postCount += 1;

    // A couple of replies so threads are not all empty, and one accepted answer so the
    // solved state is visible without anyone having to produce it by hand.
    const repliers = pick(consultantUsers.filter((u) => u.id !== author.id), randomInt(0, 3));
    let firstReplyId = null;
    for (const replier of repliers) {
      const { replyId } = await Post.reply(created.id, replier.id,
        '<p>Ran into this too. What worked for us was checking the order of evaluation first, then reproducing it in a scratch org with the minimum config.</p>');
      if (!firstReplyId) firstReplyId = replyId;
    }

    if (kind === 'question' && firstReplyId && i % 2 === 0) {
      await Post.acceptSolution(created.id, firstReplyId, author.id);
    }

    // Some votes, from people who are not the author.
    for (const voter of pick(consultantUsers.filter((u) => u.id !== author.id), randomInt(0, 6))) {
      await Post.vote('post', created.id, voter.id, 1);
    }
  }
  console.log(`  ${postCount} community posts`);
}

/* ============================================================================
 * DEMO DATA FOR EVERY OTHER SCREEN
 *
 * The base seed above fills the directory, the job board, the pipeline, the rate index and
 * the forum. Everything after it — quotes, messages, notifications, stories, reviews, the
 * daily challenge, referrals, recruiters, issue reports, tax enquiries, the CRM, finance,
 * placements and sales agents — opened on an empty state, which reads as "not built".
 *
 * Unlike the base seed this runs on EVERY invocation and is idempotent section by section:
 * each one looks up what it would create and skips if it is already there, so a database
 * seeded before these sections existed is topped up rather than refused, and a second run
 * is a no-op. Everything goes through the model that owns the table — the state machines
 * are walked, ledgers are written by their own module — because a fixture that bypassed
 * them could produce a row the application itself would refuse to create.
 * ========================================================================== */

/** A UTC calendar date `days` before today, as the YYYY-MM-DD every date column takes. */
function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** First day of the month `months` back — recurring costs start on a month boundary. */
function isoMonthStart(monthsBack) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1)).toISOString().slice(0, 10);
}

/** Find a demo account by email, or create it the way every seeded account is created. */
async function ensureAccount(email, name, roles) {
  let user = await User.findByEmail(email);
  if (!user) {
    // No consent argument — see the note at the top of this file.
    user = await User.create({ email, password: SEED_PASSWORD, name, roles });
    await User.setEmailVerified(user.id);
    user = await User.findById(user.id);
    console.log(`  ${email} created`);
  }
  return user;
}

/** The flags `SiteReview.roleLabelFor` reads, built from the row rather than typed. */
function sessionShapeOf(user) {
  return { isConsultant: Boolean(user.is_consultant), isCompany: Boolean(user.is_company), isRecruiter: Boolean(user.is_recruiter) };
}

/**
 * Play a scripted thread through `Conversation.postMessage`, then move it back in time.
 *
 * Posting is the only way a message is written, so membership is re-checked and the
 * counters move exactly as they do for a person. Every message would then carry the same
 * second, though, and an inbox where everything happened just now demonstrates nothing —
 * so the timestamps are shifted with parameterised UPDATEs afterwards, the same way the
 * base seed spreads `jobs.published_at`. Read state is shifted to match what posting did:
 * each sender has read up to their own last message, so whatever the other side wrote
 * after it is genuinely unread. The `message_received` notification is emitted with the
 * route's own dedupe key.
 */
async function playThread(conversationId, lines, namesById) {
  const posted = [];
  for (const line of lines) {
    const result = await Conversation.postMessage(conversationId, line.from, line.body);
    posted.push({ ...result, from: line.from, minutesAgo: line.minutesAgo });
  }

  const lastOwn = new Map();
  for (const message of posted) {
    await promisePool.query('UPDATE messages SET created_at = DATE_SUB(NOW(), INTERVAL ? MINUTE) WHERE id = ?', [
      message.minutesAgo,
      message.messageId
    ]);
    lastOwn.set(message.from, message.minutesAgo);
  }
  await promisePool.query('UPDATE conversations SET last_message_at = DATE_SUB(NOW(), INTERVAL ? MINUTE) WHERE id = ?', [
    posted[posted.length - 1].minutesAgo,
    conversationId
  ]);
  for (const [userId, minutesAgo] of lastOwn) {
    await promisePool.query(
      'UPDATE conversation_participants SET last_read_at = DATE_SUB(NOW(), INTERVAL ? MINUTE) WHERE conversation_id = ? AND user_id = ?',
      [minutesAgo, conversationId, userId]
    );
  }

  for (const message of posted) {
    for (const recipientId of message.recipientIds) {
      const dedupeKey = `message:${message.messageId}:${recipientId}`;
      const created = await Notification.emit({
        userId: recipientId,
        type: 'message_received',
        title: `New message from ${namesById[message.from]}`,
        body: message.body.slice(0, 120),
        link: `/messages/${conversationId}`,
        dedupeKey
      });
      if (created) {
        await promisePool.query(
          'UPDATE notifications SET created_at = DATE_SUB(NOW(), INTERVAL ? MINUTE) WHERE user_id = ? AND dedupe_key = ?',
          [message.minutesAgo, recipientId, dedupeKey]
        );
      }
    }
  }
}

async function seedDemo() {
  console.log('\nDemo data for the remaining screens (each section skips what already exists)...');

  const admin = await User.findByEmail('admin@example.com');
  const companyByName = {};
  for (const [name] of COMPANIES) {
    companyByName[name] = await User.findByEmail(`hiring@${name.toLowerCase().replace(/[^a-z]+/g, '')}.example.com`);
  }
  const consultants = [];
  for (let i = 1; i <= 24; i += 1) consultants.push(await User.findByEmail(`consultant${i}@example.com`));
  if (!admin || consultants.some((c) => !c) || Object.values(companyByName).some((c) => !c)) {
    console.log('  Base accounts are missing, so there is nothing to attach demo data to. Skipping.');
    return;
  }
  const c1 = consultants[0];
  const northwind = companyByName['Northwind Cloud Partners'];
  const adriatic = companyByName['Adriatic Digital'];
  const meridian = companyByName['Meridian Retail Group'];
  const helix = companyByName['Helix Health'];
  const cobalt = companyByName['Cobalt ISV Labs'];
  const talentBridge = companyByName['Talent Bridge'];
  const firstName = (user) => String(user.name).split(' ')[0];

  // --- extra demo accounts ------------------------------------------------------
  const recruiter = await ensureAccount('recruiter@example.com', 'Mira Kastrati', ['recruiter']);
  // An agent is a colleague with a sign-up link, not a role: the account is an ordinary one
  // and being an agent is a row in `sales_agents`.
  const agent = await ensureAccount('agent@example.com', 'Dren Gashi', ['consultant']);

  // --- recruiter profile ----------------------------------------------------------
  // Saved through the same normaliser the profile form uses; specialisms are cloud FAMILY
  // slugs from config/cloudFamilies.js. `save` is an upsert, so this is safe to repeat.
  await RecruiterProfile.save(recruiter.id, {
    agency_name: 'Cloudbridge Talent',
    contact_name: recruiter.name,
    tagline: 'Contract and permanent Salesforce hiring across the Benelux and the Balkans',
    about:
      'A six-person agency that only places Salesforce people.\n\n' +
      'Most of our work is contract architects and CPQ specialists for partners who need someone in two weeks, ' +
      'not two months. We read every profile ourselves before it reaches a client.',
    phone: '+31 30 000 0000',
    website: 'https://cloudbridge-talent.example.com',
    country: 'NL',
    city: 'Utrecht',
    specialisms: ['sales-cloud', 'service-cloud', 'revenue-cloud', 'experience-cloud']
  });
  await RecruiterProfile.setPublic(recruiter.id, true);
  console.log('  recruiter profile (public)');

  // --- sales agent ----------------------------------------------------------------
  // Added the way /admin adds one. Two accounts are credited to the link through the
  // model's first-touch UPDATE, which refuses to overwrite and so is safe to repeat. The
  // link-open counter only moves when the agent row is new, because it is a counter.
  const { agent: agentRow, created: agentCreated } = await SalesAgent.add(agent.id, admin.id);
  await SalesAgent.attribute(agentRow.code, recruiter.id);
  await SalesAgent.attribute(agentRow.code, talentBridge.id);
  if (agentCreated) {
    for (let i = 0; i < 7; i += 1) await SalesAgent.countOpen(agent.id);
  }
  console.log(`  sales agent ${agent.email} (code ${agentRow.code})`);

  // --- referrals ------------------------------------------------------------------
  // consultant1 joins the scheme and is credited with two introductions. Attribution is
  // first touch and unique per referred account, so a re-run is a silent no-op. No
  // commission is written: commission is earned on money RECEIVED, and no payment exists
  // without Stripe — an empty ledger beside two introductions is the honest picture.
  const referrer = await Referral.enrol(c1.id);
  await Referral.setPayoutDetails(c1.id, { method: 'bank_transfer', reference: 'IBAN ending 3000 (demo)' });
  await Referral.attribute(referrer.code, consultants[22].id);
  await Referral.attribute(referrer.code, consultants[23].id);
  console.log(`  referrals: ${c1.email} enrolled (code ${referrer.code}), 2 introductions`);

  // --- quotes ---------------------------------------------------------------------
  // Built exactly as POST /quotes builds one: the route's input shape, the estimator, the
  // reconciliation guard, then Quote.create. Statuses are walked with Quote.transition.
  const existingQuotes = await Quote.listForOwner(northwind.id, { limit: 1 });
  if (existingQuotes.total === 0) {
    const QUOTES = [
      {
        owner: northwind,
        client: { name: 'Henrik Aalto', company: 'Baltic Freight Lines', email: 'henrik.aalto@balticfreight.example.com', industry: 'Distribution', size: 'Large (501-5000)' },
        project: { name: 'Service Cloud rollout for the customer desk', summary: '<p>Replace a shared mailbox and a spreadsheet with case management, routing and a knowledge base for 120 agents in three countries.</p>' },
        inputs: { selectedFamilies: ['service-cloud'], selectedModules: ['case-management', 'omni-channel', 'knowledge'], selectedIsvs: ['isv-cti'], complexity: 'moderate', customizationLevel: 'medium', numberOfUsers: '120', numberOfOrgs: '1', numberOfIntegrations: '2', integrationComplexity: 'medium' },
        path: ['sent', 'accepted']
      },
      {
        owner: northwind,
        client: { name: 'Lea Hoffmann', company: 'Kesselring Maschinenbau', email: 'l.hoffmann@kesselring.example.com', industry: 'Manufacturing', size: 'Medium (51-500)' },
        project: { name: 'Data Cloud pilot', summary: '<p>Unify service and sales data for one product line before deciding on a wider rollout.</p>' },
        inputs: { selectedFamilies: [], selectedModules: ['ingestion', 'identity-resolution', 'calculated-insights'], selectedIsvs: [], complexity: 'simple', customizationLevel: 'low', numberOfUsers: '40', numberOfOrgs: '1', numberOfIntegrations: '1', integrationComplexity: 'simple' },
        path: []
      },
      {
        owner: adriatic,
        client: { name: 'Besa Leka', company: 'Vela Instruments', email: 'besa.leka@vela.example.com', industry: 'Technology', size: 'Medium (51-500)' },
        project: { name: 'CPQ and subscription billing', summary: '<p>Quote-to-cash for a hardware-plus-subscription catalogue, replacing manual price sheets.</p>' },
        inputs: { selectedFamilies: [], selectedModules: ['cpq', 'product-catalog', 'subscription-management'], selectedIsvs: ['isv-docusign', 'isv-avalara'], complexity: 'complex', customizationLevel: 'medium', numberOfUsers: '75', numberOfOrgs: '1', numberOfIntegrations: '3', integrationComplexity: 'medium' },
        path: ['sent']
      },
      {
        owner: cobalt,
        client: { name: 'Owen Price', company: 'Harbourline Insurance', email: 'owen.price@harbourline.example.com', industry: 'Financial Services', size: 'Large (501-5000)' },
        project: { name: 'Partner portal for brokers', summary: '<p>A broker-facing portal for quotes and policy documents, with single sign-on.</p>' },
        inputs: { selectedFamilies: [], selectedModules: ['partner-portal', 'sharing-security', 'rest-api'], selectedIsvs: [], complexity: 'moderate', customizationLevel: 'high', numberOfUsers: '600', numberOfOrgs: '1', numberOfIntegrations: '2', integrationComplexity: 'complex' },
        path: ['sent', 'expired']
      }
    ];

    for (const spec of QUOTES) {
      const inputs = {
        clientIndustry: spec.client.industry,
        companySize: spec.client.size,
        includeTraining: true,
        includeSupport: true,
        supportDurationDays: 30,
        otherModules: '',
        otherIsvs: '',
        otherIntegrations: '',
        ...spec.inputs
      };
      const estimate = calculateEstimation(inputs, { contingencyPercentage: 15, currency: 'EUR' });
      const mismatches = reconciliationProblems(estimate);
      if (mismatches.length) throw new Error(`Seed estimate failed reconciliation: ${mismatches.join('; ')}`);

      const quote = await Quote.create(spec.owner.id, {
        client: spec.client,
        project: spec.project,
        inputs,
        estimate,
        catalogueVersion: catalogueVersion()
      });
      for (const step of spec.path) {
        await Quote.transition(quote.id, spec.owner.id, step, {
          note: step === 'accepted' ? 'Signed SOW received by email.' : null
        });
      }
    }
    console.log(`  ${QUOTES.length} quotes`);
  }

  // --- conversations --------------------------------------------------------------
  // ANCHORED threads only, opened under the same eligibility rules as POST /messages/start:
  // an application both parties are in, or an enquiry about a specific job that one of
  // them owns (a company may approach a PUBLIC profile; a consultant may approach the
  // advertiser of an OPEN role).
  const inbox = await Conversation.listForUser(c1.id, { limit: 1 });
  if (inbox.total === 0) {
    const namesById = {};
    for (const u of [c1, consultants[1], northwind, adriatic, meridian]) namesById[u.id] = u.name;

    const openJobsOf = async (company) => (await Job.browse({ company_user_id: company.id, status: 'open' }, { limit: 20 })).rows;

    /** An application of this consultant to one of this company's open roles, made if needed. */
    const applicationWith = async (consultant, company) => {
      const jobs = await openJobsOf(company);
      const mine = await Application.listForConsultant(consultant.id, { limit: 100 });
      const live = mine.find((a) => jobs.some((j) => j.id === a.job_id) && !Application.isTerminal(a.status));
      if (live) return live.id;
      const fresh = jobs.find((j) => !mine.some((a) => a.job_id === j.id));
      if (!fresh) return null;
      const { applicationId } = await Application.apply(fresh.id, consultant.id, {
        coverLetter: 'I have led two Service Cloud rollouts of a similar size and can start within two weeks.',
        dayRate: Number(fresh.rate_min) || 650,
        currency: 'EUR'
      });
      return applicationId;
    };

    let threads = 0;

    // 1. consultant1 and Northwind, about an application Northwind has shortlisted.
    const appId = await applicationWith(c1, northwind);
    if (appId) {
      let application = await Application.findById(appId);
      for (const step of ['reviewing', 'shortlisted']) {
        if (!Application.canTransition(application.status, step)) continue;
        const moved = await Application.transition(appId, northwind.id, step, { actorIsEmployer: true });
        await Notification.emit({
          userId: c1.id,
          type: 'application_status',
          title: `Application for ${application.job_title} is now "${moved.status}"`,
          link: `/applications/${appId}`,
          dedupeKey: `application-status:${appId}:${moved.previousStatus}:${moved.status}`
        });
        application = await Application.findById(appId);
      }
      const conversationId = await Conversation.findOrCreate({
        kind: 'application',
        applicationId: appId,
        jobId: application.job_id,
        participantIds: [c1.id, northwind.id],
        createdByUserId: northwind.id
      });
      await playThread(conversationId, [
        { from: northwind.id, minutesAgo: 3 * 1440, body: `Hi ${firstName(c1)}, thanks for applying for ${application.job_title}. Your Omni-Channel work stood out. Would you have half an hour on Thursday for a first call?` },
        { from: c1.id, minutesAgo: 3 * 1440 - 95, body: 'Thanks for getting back to me. Thursday works — any time after 10:00 CET. Happy to walk through the routing design from my last project.' },
        { from: northwind.id, minutesAgo: 2 * 1440 + 30, body: 'Great, I have sent an invite for 11:00. Our delivery lead, Jonas, will join.' },
        { from: northwind.id, minutesAgo: 140, body: 'Following up after Thursday: we would like to move you to the shortlist and set up a second conversation with the client. Could you share your availability for next week?' }
      ], namesById);
      threads += 1;
    }

    // 2. consultant1 asks Adriatic Digital about one of its open roles (an enquiry).
    const [adriaticJob] = await openJobsOf(adriatic);
    if (adriaticJob) {
      const conversationId = await Conversation.findOrCreate({
        kind: 'enquiry',
        jobId: adriaticJob.id,
        participantIds: [c1.id, adriatic.id],
        createdByUserId: c1.id
      });
      await playThread(conversationId, [
        { from: c1.id, minutesAgo: 5 * 1440, body: `Hello, before I apply for "${adriaticJob.title}": is the role open to someone working remotely from Berlin with a monthly visit to Tirana?` },
        { from: adriatic.id, minutesAgo: 4 * 1440 + 200, body: 'Hi, yes — the team is split across Tirana and remote. One visit a month would suit us well. The client is in retail, mostly Service Cloud with some Experience Cloud.' },
        { from: c1.id, minutesAgo: 4 * 1440, body: 'Perfect, thank you. I will send an application today.' }
      ], namesById);
      threads += 1;
    }

    // 3. Meridian Retail Group approaches consultant1's public profile about a role. Not
    //    yet opened by consultant1, so it is unread in their inbox.
    const [meridianJob] = await openJobsOf(meridian);
    if (meridianJob) {
      const conversationId = await Conversation.findOrCreate({
        kind: 'enquiry',
        jobId: meridianJob.id,
        participantIds: [meridian.id, c1.id],
        createdByUserId: meridian.id
      });
      await playThread(conversationId, [
        { from: meridian.id, minutesAgo: 95, body: `Hi ${firstName(c1)}, we came across your profile in the directory. We are hiring for "${meridianJob.title}" and your background looks like a close match. Would you be open to a short call this week?` }
      ], namesById);
      threads += 1;
    }

    // 4. consultant2 writes to Northwind about their application; Northwind has not replied.
    const c2AppId = await applicationWith(consultants[1], northwind);
    if (c2AppId) {
      const application = await Application.findById(c2AppId);
      const conversationId = await Conversation.findOrCreate({
        kind: 'application',
        applicationId: c2AppId,
        jobId: application.job_id,
        participantIds: [consultants[1].id, northwind.id],
        createdByUserId: consultants[1].id
      });
      await playThread(conversationId, [
        { from: consultants[1].id, minutesAgo: 1440 + 60, body: 'Hello, I applied last week and wanted to add that my notice period has shortened — I could start on the 1st of next month.' }
      ], namesById);
      threads += 1;
    }
    console.log(`  ${threads} conversations`);
  }

  // --- saved jobs -----------------------------------------------------------------
  // `saveForUser` is an INSERT IGNORE on (user, job), so repeating it is a no-op.
  const { rows: newestJobs } = await Job.browse({ status: 'open' }, { limit: 12, sort: 'newest' });
  const toSave = newestJobs.filter((_, i) => i % 3 === 0).slice(0, 4);
  for (const job of toSave) await Job.saveForUser(c1.id, job.id);
  console.log(`  ${toSave.length} saved jobs for ${c1.email}`);

  // --- success stories ------------------------------------------------------------
  // Editorial and admin-written. NO pay figures, before or after: a story is evidence
  // about delivery, never a financial claim about a named person.
  const { total: storyCount } = await SuccessStory.list({ include_unpublished: true }, { limit: 1 });
  if (storyCount === 0) {
    const STORIES = [
      {
        title: 'Nine weeks from mailbox to Omni-Channel',
        subject_name: 'Baltic Freight Lines',
        subject_role: 'Customer service, three countries',
        summary: 'A shared inbox and a spreadsheet replaced by routing, case management and a knowledge base.',
        family: 'service-cloud',
        quote: 'The estimate said nine weeks and the plan said which nine. That is the first time a partner has shown us the phases before we signed.',
        quote_author: 'Head of Customer Service',
        body:
          '<p>The customer desk had grown to 120 agents working out of one shared mailbox. Nobody could say how long a customer had been waiting.</p>' +
          '<p>Northwind scoped the work on the Hub, shared the phased estimate with the client and staffed it with two consultants found through the directory.</p>' +
          '<p>Routing went live in week seven; the knowledge base followed two weeks later.</p>'
      },
      {
        title: 'A first contract, found through the forum',
        subject_name: 'Elira Hoxha',
        subject_role: 'CPQ consultant',
        summary: 'From a permanent role to a first contract, after an answer on the forum led to an introduction.',
        family: 'revenue-cloud',
        quote: 'I answered a question about price rules and a week later the person who asked it offered me the project.',
        quote_author: 'Elira Hoxha',
        body:
          '<p>Elira had spent four years on CPQ inside one company and wanted to try contracting, but had no network outside it.</p>' +
          '<p>An accepted answer on the forum led to a message from a partner looking for exactly that experience. The first contract started a month later.</p>'
      },
      {
        title: 'Identity resolution that survives shared mailboxes',
        subject_name: 'Kesselring Maschinenbau',
        subject_role: 'Data Cloud pilot',
        summary: 'A pilot that proved the match rules on one product line before anybody committed to the rest.',
        family: 'data-cloud',
        quote: 'Starting small meant the hard question — what counts as the same customer — was answered with our own data.',
        quote_author: 'Head of CRM',
        body:
          '<p>The pilot covered a single product line and two data streams. The team spent most of its time on match rules, because shared family mailboxes were collapsing households into one profile.</p>' +
          '<p>The ruleset that came out of it is now the template for the wider rollout.</p>'
      }
    ];
    for (const story of STORIES) {
      const { id } = await SuccessStory.create(story, { actorUserId: admin.id });
      await SuccessStory.setPublished(id, true);
    }
    console.log(`  ${STORIES.length} success stories (published)`);
  }

  // --- site reviews ---------------------------------------------------------------
  // One per account (UNIQUE user_id), looked up first because `submit` clears an approval
  // on every write. Most are approved by the admin; Helix Health's waits in the queue.
  const REVIEWS = [
    [c1, 5, 'Found my current contract here within three weeks. The rate index is the first one I have seen that tells you when it does not have enough data.', true],
    [consultants[2], 4, 'The profile builder is quick and the CV export is clean. I would like more filters on the job board, but what is there works.', true],
    [northwind, 5, 'We scope every new opportunity with the estimator now. The documents reconcile with the web page, which our finance team noticed straight away.', true],
    [recruiter, 4, 'A directory of people who actually work on the platform, with certifications that are labelled when they expire. Saves us a lot of screening calls.', true],
    [helix, 4, 'Posted two roles and had a shortlist within a fortnight. The applicant board makes it easy to see what is waiting on us.', false]
  ];
  let reviewCount = 0;
  for (const [user, rating, body, approve] of REVIEWS) {
    if (await SiteReview.forUser(user.id)) continue;
    await SiteReview.submit(user.id, { rating, body }, sessionShapeOf(user));
    if (approve) {
      const review = await SiteReview.forUser(user.id);
      await SiteReview.setApproved(review.id, true, { actorUserId: admin.id });
    }
    reviewCount += 1;
  }
  if (reviewCount) console.log(`  ${reviewCount} site reviews`);

  // --- daily challenge ------------------------------------------------------------
  // Attempts go through `Challenge.submit`, which grades them and dates them from the
  // `now` it is given — the date is never taken from the answers. Each player picks the
  // right option for some questions and a wrong one for the rest, so scores vary.
  // consultant1 played the last four days but NOT today: the streak shows and the quiz is
  // still there to try. INSERT IGNORE on (user, date) makes a re-run a no-op.
  const PLAYERS = [
    [0, [1, 2, 3, 4]],
    [1, [0, 1, 2, 3, 4, 5, 6]],
    [2, [0, 1, 2]],
    [3, [0, 2, 3]],
    [4, [1, 2, 5]],
    [5, [0]],
    [6, [3, 4]],
    [7, [0, 1]]
  ];
  let attempts = 0;
  for (const [index, days] of PLAYERS) {
    const player = consultants[index];
    for (const daysAgo of days) {
      // Today's attempts are a few minutes old; earlier ones mid-morning on their day. The
      // date is then derived from that instant exactly as the model derives it.
      const when =
        daysAgo === 0
          ? new Date(Date.now() - (index + 1) * 7 * 60_000)
          : new Date(`${isoDaysAgo(daysAgo)}T${String(8 + index).padStart(2, '0')}:${String(10 + daysAgo * 7).padStart(2, '0')}:00Z`);
      const date = serverDate(when);
      const questions = dailySetFor(date);
      const rightCount = (index + daysAgo) % (questions.length + 1);
      const answers = {};
      questions.forEach((q, i) => {
        answers[q.id] = i < rightCount ? q.answer : (q.answer + 1) % q.options.length;
      });
      const result = await Challenge.submit(player.id, answers, { now: when, durationMs: 40_000 + index * 3_000 });
      if (result.recorded) {
        // When it was played, not when the seed ran: the daily board breaks ties on it.
        await promisePool.query('UPDATE challenge_attempts SET created_at = ? WHERE user_id = ? AND challenge_date = ?', [
          when,
          player.id,
          date
        ]);
        attempts += 1;
      }
    }
  }
  if (attempts) console.log(`  ${attempts} challenge attempts (today is ${serverDate()})`);

  // --- issue reports --------------------------------------------------------------
  // One of each shape the queue has to handle: a signed-in bug with an answer, an
  // anonymous access problem with a contact address, a closed "wrong figure" report, and an
  // idea sent with consent to publish and then published on /ideas.
  const { total: issueCount } = await IssueReport.list({}, { limit: 1 });
  if (issueCount === 0) {
    const bug = await IssueReport.create(
      {
        kind: 'bug',
        severity: 'normal',
        page_path: '/dashboard/saved',
        summary: 'A saved job stays in the list after the role is closed',
        detail: 'I saved a role last week. The company has since closed it, but it still shows in my saved jobs with no sign that it is closed.'
      },
      { userId: c1.id }
    );
    await IssueReport.setStatus(bug.id, 'open', {
      response: 'Thanks — confirmed. Closed roles will be labelled in the saved list; we will update this report when it ships.',
      actorUserId: admin.id
    });

    await IssueReport.create({
      kind: 'access',
      severity: 'high',
      page_path: '/auth/register',
      summary: 'Verification email never arrives',
      detail: 'Registered twice with the same address, waited an hour each time. Nothing in spam either.',
      contact_email: 'newcomer@example.org'
    });

    const wrong = await IssueReport.create(
      {
        kind: 'wrong',
        severity: 'low',
        page_path: '/rates',
        summary: 'Rate index shows a gap for my role this month',
        detail: 'The chart for my role and seniority has an empty month in the middle. Is the data missing?'
      },
      { userId: northwind.id }
    );
    await IssueReport.setStatus(wrong.id, 'closed', {
      response: 'Working as intended: that month had fewer than three contributors, so the figure is suppressed rather than shown from one or two people.',
      actorUserId: admin.id
    });

    const idea = await IssueReport.create(
      {
        kind: 'idea',
        page_path: '/jobs',
        summary: 'Let me filter jobs by the certifications they ask for',
        detail: 'Most roles list one or two certifications. A filter for those would save a lot of scrolling.',
        publish_consent: 'on'
      },
      { userId: consultants[3].id }
    );
    await IssueReport.setIdeaPublished(idea.id, true, admin.id);
    for (const voter of [c1, consultants[4], consultants[5]]) await IssueReport.toggleIdeaVote(idea.id, voter.id);
    console.log('  4 issue reports (1 published idea)');
  }

  // --- tax advisory enquiries -----------------------------------------------------
  // Six fields and no money, through the route's own normaliser, with consent stamped at
  // the privacy version the form states. One is new; one has been walked to `introduced`.
  const { total: enquiryCount } = await TaxEnquiry.list({}, { limit: 1 });
  if (enquiryCount === 0) {
    const ENQUIRIES = [
      [consultants[4], 'DE', 'first_contract', 'employed', 'I am leaving a permanent role to take my first contract in January. Should I go freelance first or set up a company straight away?', []],
      [consultants[5], 'AL', 'cross_border', 'freelance', 'I live in Tirana and most of my clients are in Germany and the Netherlands. I am not sure where I should be invoicing from.', ['contacted', 'introduced']]
    ];
    for (const [user, country, topic, arrangement, question, path] of ENQUIRIES) {
      const { id } = await TaxEnquiry.create(
        { fullName: user.name, email: user.email, phone: null, country, topic, arrangement, question, consent: true, consentVersion: PRIVACY_VERSION },
        { userId: user.id }
      );
      for (const step of path) {
        await TaxEnquiry.setStatus(id, step, {
          actorUserId: admin.id,
          note: step === 'contacted' ? 'Replied by email, asked for a call slot.' : 'Introduced to a cross-border specialist.'
        });
      }
    }
    console.log(`  ${ENQUIRIES.length} tax advisory enquiries`);
  }

  // --- CRM leads ------------------------------------------------------------------
  // Every lead names its source; statuses are walked through `setStatus`, which writes the
  // activity in the same transaction. One lead asks to be left alone, which writes the
  // suppression — so /crm/suppressions has a row and the reason is visible.
  const { total: leadCount } = await CrmLead.list({}, { limit: 1 });
  if (leadCount === 0) {
    const LEADS = [
      [{ company: 'Lumen Logistics', contact_name: 'Sara Lindqvist', contact_email: 'sara.lindqvist@lumen-logistics.example.com', job_title: 'Head of Sales Operations', country: 'SE', source: 'inbound', source_detail: 'Contact form on /companies-hub' }, [], []],
      [{ company: 'Arktis Energy', contact_name: 'Jonas Eriksen', contact_email: 'j.eriksen@arktis.example.com', job_title: 'CRM Programme Lead', country: 'NO', source: 'event', source_detail: 'Salesforce user group meetup, Oslo, September' }, ['contacted'], [['sent', 'email', 'Sent the Service Cloud case study and offered a scoping call.']]],
      [{ company: 'Corvina Insurance', contact_name: 'Marta Ruiz', contact_email: 'marta.ruiz@corvina.example.com', job_title: 'IT Director', country: 'ES', source: 'referral', source_detail: 'Introduced by Northwind Cloud Partners' }, ['contacted', 'replied', 'qualified'], [['meeting', 'phone', 'Discovery call: broker portal, 600 users, decision by end of quarter.']]],
      [{ company: 'Pellucid Labs', contact_name: 'Tom Byrne', contact_email: 'tom.byrne@pellucid.example.org', job_title: 'COO', country: 'IE', source: 'company_website', source_detail: 'https://pellucid.example.org/contact (partnerships)' }, ['contacted', 'replied', 'qualified', 'won'], []],
      [{ company: 'Gradina Foods', contact_name: 'Arta Dema', contact_email: 'arta.dema@gradina.example.com', job_title: 'Commercial Manager', country: 'AL', source: 'public_directory', source_detail: 'Chamber of commerce members directory, Tirana' }, ['parked'], [['note', null, 'Not before their new financial year. Revisit in March.']]],
      [{ company: 'Vireo Health', contact_name: 'Nina Weiss', contact_email: 'nina.weiss@vireo.example.com', job_title: 'Practice Manager', country: 'AT', source: 'existing_customer', source_detail: '' }, ['contacted', 'unsubscribed'], []]
    ];
    for (const [input, path, activities] of LEADS) {
      const { id } = await CrmLead.upsert(input, { actorUserId: admin.id });
      for (const step of path) {
        await CrmLead.setStatus(id, step, {
          actorUserId: admin.id,
          channel: 'email',
          note: step === 'unsubscribed' ? 'Asked not to be contacted again.' : null
        });
      }
      for (const [outcome, channel, note] of activities) {
        await CrmLead.addActivity(id, { outcome, channel, note, actorUserId: admin.id });
      }
    }
    console.log(`  ${LEADS.length} CRM leads`);
  }

  // --- finance --------------------------------------------------------------------
  // Two clients; one invoice issued six weeks ago and paid, one issued last week and
  // outstanding, one draft. Issued in date order so the numbers run with the dates. VAT is
  // the rate the issuer chose, typed on each line — the app infers none.
  const { total: clientCount } = await FinanceClient.list({ include_archived: true }, { limit: 1 });
  if (clientCount === 0) {
    const meridianClient = await FinanceClient.create({
      name: 'Meridian Retail Group B.V.',
      contact_name: 'Accounts payable',
      email: 'ap@meridian-retail.example.com',
      address: 'Keizersgracht 100\n1015 AA Amsterdam\nNetherlands',
      country: 'NL',
      tax_id: 'NL000000000B01'
    });
    const helixClient = await FinanceClient.create({
      name: 'Helix Health DAC',
      contact_name: 'Finance team',
      email: 'finance@helix-health.example.com',
      address: '1 Grand Canal Street\nDublin 2\nIreland',
      country: 'IE',
      tax_id: 'IE0000000X'
    });

    const paid = await FinanceInvoice.createDraft({
      clientId: meridianClient.id,
      reference: 'Featured job listings, Q3',
      notes: 'VAT reverse-charged to the customer.',
      dueDate: isoDaysAgo(15),
      lines: [
        { description: 'Featured job listing, 30 days', unit: 'listing', quantity: '3', unit_price: '149.00', vat_percent: '0' },
        { description: 'Applicant board onboarding session', unit: 'hour', quantity: '1.5', unit_price: '120.00', vat_percent: '0' }
      ],
      actorUserId: admin.id
    });
    await FinanceInvoice.issue(paid.id, { issueDate: isoDaysAgo(45), actorUserId: admin.id });
    await FinanceInvoice.setStatus(paid.id, 'paid');

    const outstanding = await FinanceInvoice.createDraft({
      clientId: helixClient.id,
      reference: 'Placement fee — Service Cloud Architect',
      dueDate: isoDaysAgo(-23),
      lines: [{ description: 'Placement fee, permanent role (as agreed)', unit: 'placement', quantity: '1', unit_price: '13800.00', vat_percent: '23' }],
      actorUserId: admin.id
    });
    await FinanceInvoice.issue(outstanding.id, { issueDate: isoDaysAgo(7), actorUserId: admin.id });

    await FinanceInvoice.createDraft({
      clientId: meridianClient.id,
      reference: 'Featured job listings, Q4',
      lines: [{ description: 'Featured job listing, 30 days', unit: 'listing', quantity: '2', unit_price: '149.00', vat_percent: '0' }],
      actorUserId: admin.id
    });

    await FinanceCost.create(
      { description: 'Application hosting and database', category: 'hosting', currency: 'EUR', amount: '189.00', recur_every: 'monthly', starts_on: isoMonthStart(6), vendor: 'Render' },
      { actorUserId: admin.id }
    );
    await FinanceCost.create(
      { description: 'Domain names and business email', category: 'software', currency: 'EUR', amount: '240.00', recur_every: 'yearly', starts_on: isoMonthStart(4), vendor: 'Registrar' },
      { actorUserId: admin.id }
    );
    await FinanceCost.create(
      { description: 'Accountant: annual filing', category: 'professional', currency: 'EUR', amount: '850.00', recur_every: 'once', starts_on: isoDaysAgo(60), vendor: 'Local accountancy practice' },
      { actorUserId: admin.id }
    );
    console.log('  finance: 2 clients, 3 invoices (paid, issued, draft), 3 costs');
  }

  // --- placements -----------------------------------------------------------------
  // Agreed by an administrator; the fee is derived by the model from the stored contract
  // value and the kind's rate, never typed.
  const { total: placementCount } = await PlacementQuote.list({}, { limit: 1 });
  if (placementCount === 0) {
    await PlacementQuote.agree(
      {
        company_user_id: meridian.id,
        consultant_user_id: consultants[3].id,
        consultant_name: consultants[3].name,
        job_title: 'Field Service Lead — 6 month contract',
        placement_kind: 'contract',
        contract_value: '47350.00',
        currency: 'EUR',
        note: 'Start date agreed for the first Monday of next month.'
      },
      { actorUserId: admin.id }
    );
    await PlacementQuote.agree(
      {
        company_user_id: helix.id,
        consultant_user_id: consultants[6].id,
        consultant_name: consultants[6].name,
        job_title: 'Service Cloud Architect (permanent)',
        placement_kind: 'permanent',
        contract_value: '92000.00',
        currency: 'EUR'
      },
      { actorUserId: admin.id }
    );
    console.log('  2 placements');
  }

  // --- company document branding --------------------------------------------------
  // Northwind's quotes render with its own accent colours and one standard clause. Both
  // colours clear 4.5:1 against white, or `save` would refuse them.
  if (!(await CompanyTemplate.findByUserId(northwind.id))) {
    const saved = await CompanyTemplate.save(northwind.id, {
      brand_navy: '#14325C',
      brand_blue: '#0B5CAB',
      legal_name: 'Northwind Cloud Partners GmbH',
      address: 'Musterstraße 1\n10115 Berlin\nGermany',
      contact_email: 'hiring@northwindcloudpartners.example.com',
      website: 'https://northwindcloudpartners.example.com',
      footer_note: 'Northwind Cloud Partners GmbH, Berlin'
    });
    if (saved.saved) {
      await CompanyTemplate.addClause(northwind.id, { kind: 'term', body: 'Invoices are payable within 30 days of issue. Change requests are estimated and agreed in writing before work starts.' });
      console.log('  document branding for Northwind');
    }
  }

  // --- notifications --------------------------------------------------------------
  // The account menu's panel reads these. Fixed dedupe keys, so a re-run inserts nothing;
  // the oldest of each person's seeded notifications is marked read so both states show.
  const NOTIFICATIONS = [
    [admin, 'issue_reported', 'New issue report: verification email never arrives', 'Severity: high. Sent without an account.', '/admin/issues', 'seed:admin:issue'],
    [admin, 'review_pending', 'A site review is waiting for approval', 'Helix Health left a four-star review.', '/admin/reviews', 'seed:admin:review'],
    [admin, 'tax_enquiry', 'New tax advisory enquiry', 'Going contracting for the first time, Germany.', '/admin/tax-advisory', 'seed:admin:tax'],
    [admin, 'placement_agreed', 'Placement agreed with Meridian Retail Group', null, '/admin/placements', 'seed:admin:placement'],
    [c1, 'answer_accepted', 'Your answer was accepted', 'Thanks for the tip on evaluation order.', '/community', 'seed:c1:accepted'],
    [c1, 'referral_signup', 'Someone joined through your referral link', 'Introductions are listed on your referrals page.', '/referrals', 'seed:c1:referral'],
    [c1, 'challenge_streak', 'Four days in a row on the daily challenge', 'Play today to keep the streak going.', '/challenges', 'seed:c1:streak'],
    [northwind, 'application_received', 'New applications this week', 'Two consultants applied to your open roles.', '/dashboard/applicants', 'seed:northwind:applications'],
    [northwind, 'quote_accepted', 'Baltic Freight Lines accepted your estimate', null, '/quotes', 'seed:northwind:quote']
  ];
  // Only claimed when it is true: on a database that skipped the profile, it is not listed.
  const recruiterProfile = await RecruiterProfile.findByUserId(recruiter.id);
  if (recruiterProfile && recruiterProfile.is_public) {
    NOTIFICATIONS.push([recruiter, 'profile_listed', 'Cloudbridge Talent is listed in the agency directory', 'Companies can now find you under your specialisms.', `/recruiters/${recruiterProfile.slug}`, 'seed:recruiter:listed']);
  }
  for (const [user, type, title, body, link, dedupeKey] of NOTIFICATIONS) {
    await Notification.emit({ userId: user.id, type, title, body, link, dedupeKey });
  }
  for (const user of [admin, c1, northwind]) {
    const rows = await Notification.listFor(user.id, { limit: 200 });
    const oldestSeeded = rows.filter((n) => n.dedupe_key.startsWith('seed:')).pop();
    if (oldestSeeded && !oldestSeeded.read_at) await Notification.markRead(user.id, oldestSeeded.id);
  }
  console.log('  notifications for admin, consultant1, Northwind and the recruiter');
}

/*
 * consultant1 is the account people are told to sign in with, so it gets a full set of
 * applications (scripts/seed-applications.js): without them My Applications only ever shows
 * its empty state to whoever is reviewing it.
 */
async function seedConsultantApplications() {
  const { seedApplicationsFor } = require('./seed-applications');
  const [[c1]] = await promisePool.query("SELECT id FROM users WHERE email = 'consultant1@example.com'");
  if (!c1) return;
  const n = await seedApplicationsFor(c1.id, { log: () => {} });
  console.log(`  ${n} demo applications for consultant1`);
}

seed()
  .then(seedDemo)
  .then(seedConsultantApplications)
  .then(() => {
    console.log(`\nDone. Demo accounts (password: ${SEED_PASSWORD}):`);
    console.log('  admin@example.com                          superadmin');
    console.log('  consultant1@example.com                    consultant (consultant2..24 also exist)');
    console.log('  hiring@northwindcloudpartners.example.com  company');
    console.log('  recruiter@example.com                      recruiter');
    console.log('  agent@example.com                          sales agent');
  })
  .then(() => pool.end(() => process.exit(0)))
  .catch((err) => {
    console.error(err);
    pool.end(() => process.exit(1));
  });
