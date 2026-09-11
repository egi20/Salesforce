'use strict';

const ConsultantProfile = require('../models/ConsultantProfile');
const Skill = require('../models/Skill');
const User = require('../models/User');
const { roleLabel } = require('../config/roleTaxonomy');
const { moduleLabel } = require('../config/cloudFamilies');

/**
 * Everything a consultant's documents render from, assembled ONCE.
 *
 * This exists for the same reason `quote.estimate` is stored whole: the CV, the rate card
 * and the profile page must not be able to disagree. They all read this one object, so a
 * generator that wanted a differently-shaped answer would have to change it here, in
 * front of every other reader.
 *
 * It is a READ. Nothing here derives a figure, invents a summary or rewrites anyone's
 * words — a document generator that starts writing prose is the point at which a CV stops
 * being the consultant's own claim about themselves.
 */

/** A date as a person reads it on a CV: month and year, never a day. */
function monthYear(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** "Mar 2024 – present". The en dash and the lower-case "present" are house style. */
function period(startedOn, endedOn, isCurrent = false) {
  const from = monthYear(startedOn);
  const to = isCurrent || !endedOn ? 'present' : monthYear(endedOn);
  if (!from) return to === 'present' ? '' : to || '';
  return `${from} – ${to}`;
}

/**
 * The display name, with the same fallback rule the messaging module uses: NEVER the
 * email local part. An account with no name would otherwise put a `firstname.lastname`
 * email prefix on a document its owner sends to clients.
 */
function displayName(user, profile) {
  const parts = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (parts) return parts;
  if (user.name) return user.name;
  if (profile && profile.headline) return profile.headline;
  return 'Salesforce consultant';
}

async function build(userId) {
  const [user, profile] = await Promise.all([User.findById(userId), ConsultantProfile.findByUserId(userId)]);
  if (!user || !profile) return null;

  const [skills, certifications, experiences, projects] = await Promise.all([
    Skill.forConsultant(userId),
    ConsultantProfile.listCertifications(userId),
    ConsultantProfile.listExperiences(userId),
    ConsultantProfile.listProjects(userId)
  ]);

  return {
    name: displayName(user, profile),
    // The contact block is the consultant's own email, and it appears because a CV
    // without one is not a CV. Nothing else personal is carried.
    email: user.email,
    headline: profile.headline || (profile.primary_role ? roleLabel(profile.primary_role) : ''),
    roleLabel: profile.primary_role ? roleLabel(profile.primary_role) : null,
    seniority: profile.seniority || null,
    yearsExperience: profile.years_experience || null,
    location: [profile.city, profile.country].filter(Boolean).join(', '),
    workMode: profile.work_mode,
    willingToTravel: Boolean(profile.willing_to_travel),
    availability: profile.availability,
    availableFrom: profile.available_from ? monthYear(profile.available_from) : null,
    dayRate: profile.day_rate ? Number(profile.day_rate) : null,
    currency: profile.currency || 'EUR',
    bio: profile.bio || '',
    links: {
      linkedin: profile.linkedin_url || null,
      website: profile.website_url || null,
      trailblazer: profile.trailblazer_url || null
    },
    skills: skills.map((s) => s.name),
    certifications: certifications.map((c) => ({
      name: c.name,
      credentialId: c.credential_id || null,
      earned: monthYear(c.earned_on),
      // Surfaced rather than hidden: a lapsed certification on a CV is a thing a client
      // will check, and the consultant should see it before they do.
      expired: Boolean(c.expires_on && new Date(c.expires_on) < new Date())
    })),
    experience: experiences.map((e) => ({
      company: e.company,
      title: e.title,
      period: period(e.started_on, e.ended_on, e.is_current),
      description: e.description || ''
    })),
    projects: projects.map((p) => ({
      name: p.name,
      client: p.client || null,
      cloud: p.cloud ? moduleLabel(p.cloud) || p.cloud : null,
      role: p.role ? roleLabel(p.role) || p.role : null,
      period: period(p.started_on, p.ended_on),
      description: p.description || ''
    })),
    generatedOn: new Date()
  };
}

module.exports = { build, period, monthYear, displayName };
