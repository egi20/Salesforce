#!/usr/bin/env node
'use strict';

/**
 * Development seed data.
 *
 * NOTE on consent: `User.create` is called here WITHOUT a consent argument, so seeded
 * accounts carry no accepted-terms stamp. That is deliberate and must stay that way —
 * only a real person clicking the registration form can produce a consent record.
 * Seeded accounts are force-verified instead, exactly as an admin-created account is,
 * because login refuses unverified non-admin accounts.
 */
/* eslint-disable no-await-in-loop -- seeding is intentionally sequential: each step uses ids created by the previous one. */
const { pool } = require('../config/database');
const User = require('../models/User');
const ConsultantProfile = require('../models/ConsultantProfile');
const CompanyProfile = require('../models/CompanyProfile');
const Job = require('../models/Job');
const Skill = require('../models/Skill');
const RateSubmission = require('../models/RateSubmission');
const Post = require('../models/Post');
const { sync: syncCategories } = require('./sync-categories');
const { ROLE_SLUGS, baseDayRate } = require('../config/roleTaxonomy');
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
const COUNTRIES = ['DE', 'AL', 'NL', 'IE', 'GB', 'PL', 'ES', 'IT', 'PT', 'RO'];

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
        name: `${name} Recruiting`,
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
      about: `<p>${name} works across the Salesforce platform.</p>`,
      is_public: 1
    });
    companyUsers.push(user);
  }
  console.log(`  ${companyUsers.length} companies`);

  // --- consultants -------------------------------------------------------------
  const consultantUsers = [];
  for (let i = 0; i < 24; i += 1) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    const emailAddress = `consultant${i + 1}@example.com`;

    let user = await User.findByEmail(emailAddress);
    if (!user) {
      user = await User.create({ email: emailAddress, password: SEED_PASSWORD, name, roles: ['consultant'] });
      await User.setEmailVerified(user.id);
    }

    const role = ROLE_SLUGS[i % ROLE_SLUGS.length];
    const seniority = ['junior', 'mid', 'senior', 'lead'][randomInt(0, 3)];
    const base = baseDayRate(role) || 600;

    await ConsultantProfile.ensureExists(user.id);
    await ConsultantProfile.update(user.id, {
      headline: `${seniority} Salesforce specialist`,
      bio: `<p>${randomInt(3, 15)} years delivering Salesforce projects across Europe.</p>`,
      primary_role: role,
      seniority,
      years_experience: randomInt(2, 18),
      country: COUNTRIES[i % COUNTRIES.length],
      city: 'Remote',
      work_mode: ['remote', 'hybrid', 'onsite'][randomInt(0, 2)],
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
      description: '<p>Delivery across multiple clouds.</p>'
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

    const job = await Job.create(company.id, {
      title: `${seniority === 'lead' ? 'Lead' : seniority === 'senior' ? 'Senior' : ''} ${role.replace(/-/g, ' ')} — ${randomInt(3, 12)} month contract`.trim(),
      description:
        '<p>We are looking for an experienced practitioner to join an ongoing programme.</p>' +
        '<p>You will work with the delivery team on design, build and handover.</p>',
      role,
      seniority,
      engagement_type: Math.random() > 0.25 ? 'contract' : 'permanent',
      work_mode: ['remote', 'hybrid', 'onsite'][randomInt(0, 2)],
      country: COUNTRIES[i % COUNTRIES.length],
      city: 'Remote',
      rate_min: Math.round(base * 0.85),
      rate_max: Math.round(base * 1.25),
      currency: 'EUR',
      rate_visible: true,
      duration_months: randomInt(3, 12),
      status: 'open'
    });

    await Skill.setForJob(job.id, pick(skills, randomInt(2, 6)).map((s) => s.id));
    await Job.setModules(job.id, pick(ALL_MODULES, randomInt(1, 3)).map((m) => m.value));
    jobCount += 1;
  }
  console.log(`  ${jobCount} jobs`);

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
