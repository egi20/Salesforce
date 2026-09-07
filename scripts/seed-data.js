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

  console.log(`\nDone. Sign in with admin@example.com / ${SEED_PASSWORD}`);
}

seed()
  .then(() => pool.end(() => process.exit(0)))
  .catch((err) => {
    console.error(err);
    pool.end(() => process.exit(1));
  });
