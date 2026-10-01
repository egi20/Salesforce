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
const { sync: syncCategories } = require('./sync-categories');
const { ROLE_SLUGS, baseDayRate, roleLabel } = require('../config/roleTaxonomy');
const { ALL_MODULES } = require('../config/cloudFamilies');
const { ALL_CERTIFICATIONS } = require('../config/certifications');

const SEED_PASSWORD = process.env.SEED_PASSWORD || 'Password123';

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
    const seniority = ['junior', 'mid', 'senior', 'lead'][randomInt(0, 3)];
    const base = baseDayRate(role) || 600;
    const [homeCountry, homeCity] = PLACES[i % PLACES.length];
    const consultantWorkMode = ['remote', 'hybrid', 'onsite'][randomInt(0, 2)];

    await ConsultantProfile.ensureExists(user.id);
    await ConsultantProfile.update(user.id, {
      headline: `${seniority} Salesforce specialist`,
      bio: `${randomInt(3, 15)} years delivering Salesforce projects across Europe.`,
      primary_role: role,
      seniority,
      years_experience: randomInt(2, 18),
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
      title: `${seniority} consultant`,
      startedOn: `${randomInt(2016, 2023)}-01-01`,
      isCurrent: true,
      description: 'Delivery across multiple clouds.'
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

    const job = await Job.create(company.id, {
      // `roleLabel`, not the slug with its hyphens swapped for spaces: that produced
      // "pmo — 11 month contract" and "cpq consultant" in lower case on every card. The
      // seniority is a field of its own and already renders as its own badge.
      title: `${roleLabel(role)} — ${shape}`,
      description:
        'We are looking for an experienced practitioner to join an ongoing programme.\n\n' +
        'You will work with the delivery team on design, build and handover.',
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
    await Job.setModules(job.id, pick(ALL_MODULES, randomInt(1, 3)).map((m) => m.value));
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

  console.log(`\nDone. Sign in with admin@example.com / ${SEED_PASSWORD}`);
}

seed()
  .then(() => pool.end(() => process.exit(0)))
  .catch((err) => {
    console.error(err);
    pool.end(() => process.exit(1));
  });
