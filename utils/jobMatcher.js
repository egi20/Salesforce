'use strict';

const { ROLE_ALIASES, roleLabel } = require('../config/roleTaxonomy');

/**
 * Score how well a consultant profile matches a job, 0..100.
 *
 * Pure function over plain objects so it is unit-testable and so the same scoring is
 * used by the "recommended jobs" panel, the employer's candidate ranking and the
 * matching e-mail digest. Divergent copies of this logic were how the reference
 * implementation ended up with a list view and an alert that disagreed.
 *
 * The weights are editorial, not learned. They are stated here rather than buried so
 * they can be argued with:
 */
const WEIGHTS = {
  role: 40, // the single strongest signal
  skills: 25,
  seniority: 12,
  location: 10,
  rate: 8,
  availability: 5
};

const MAX_SCORE = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

const SENIORITY_ORDER = ['junior', 'mid', 'senior', 'lead'];

function normaliseText(value) {
  return String(value || '').toLowerCase();
}

/** Role match: exact slug, else alias overlap against the job's title/description. */
function roleScore(job, profile) {
  if (!profile.primary_role || !job.role) return 0;
  if (profile.primary_role === job.role) return WEIGHTS.role;

  const haystack = `${normaliseText(job.title)} ${normaliseText(job.description)}`;
  const aliases = ROLE_ALIASES[profile.primary_role] || [];
  const label = normaliseText(roleLabel(profile.primary_role));

  if (label && haystack.includes(label)) return Math.round(WEIGHTS.role * 0.7);
  if (aliases.some((alias) => haystack.includes(alias))) return Math.round(WEIGHTS.role * 0.5);
  return 0;
}

/** Proportion of the job's required skills the consultant holds. */
function skillScore(jobSkillIds, consultantSkillIds) {
  const required = new Set(jobSkillIds || []);
  if (required.size === 0) return Math.round(WEIGHTS.skills * 0.5); // no stated skills: neutral
  const held = new Set(consultantSkillIds || []);
  let hits = 0;
  for (const id of required) if (held.has(id)) hits += 1;
  return Math.round(WEIGHTS.skills * (hits / required.size));
}

/** Exact seniority scores full; one level either side scores half; further scores 0. */
function seniorityScore(job, profile) {
  const jobIndex = SENIORITY_ORDER.indexOf(job.seniority);
  const profileIndex = SENIORITY_ORDER.indexOf(profile.seniority);
  if (jobIndex < 0 || profileIndex < 0) return 0;
  const distance = Math.abs(jobIndex - profileIndex);
  if (distance === 0) return WEIGHTS.seniority;
  if (distance === 1) return Math.round(WEIGHTS.seniority / 2);
  return 0;
}

/** A remote job matches anyone; otherwise country must agree. */
function locationScore(job, profile) {
  if (job.work_mode === 'remote') return WEIGHTS.location;
  if (!job.country || !profile.country) return 0;
  if (job.country === profile.country) return WEIGHTS.location;
  return profile.willing_to_travel ? Math.round(WEIGHTS.location / 2) : 0;
}

/**
 * Rate fit. A consultant whose rate sits inside the band scores full. Below the band
 * is not penalised (the employer is under budget); above the band decays to zero at
 * 25% over the maximum.
 */
function rateScore(job, profile) {
  const rate = Number(profile.day_rate);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  const min = Number(job.rate_min);
  const max = Number(job.rate_max);
  if (!Number.isFinite(max) || max <= 0) return Math.round(WEIGHTS.rate * 0.5);
  if (Number.isFinite(min) && rate < min) return WEIGHTS.rate;
  if (rate <= max) return WEIGHTS.rate;
  const overshoot = (rate - max) / max;
  if (overshoot >= 0.25) return 0;
  return Math.round(WEIGHTS.rate * (1 - overshoot / 0.25));
}

function availabilityScore(profile) {
  switch (profile.availability) {
    case 'immediate':
      return WEIGHTS.availability;
    case 'two_weeks':
      return Math.round(WEIGHTS.availability * 0.8);
    case 'one_month':
      return Math.round(WEIGHTS.availability * 0.5);
    default:
      return 0;
  }
}

/**
 * @returns {{score:number, breakdown:Object}} score is 0..100.
 */
function matchScore(job, profile, { jobSkillIds = [], consultantSkillIds = [] } = {}) {
  const breakdown = {
    role: roleScore(job, profile),
    skills: skillScore(jobSkillIds, consultantSkillIds),
    seniority: seniorityScore(job, profile),
    location: locationScore(job, profile),
    rate: rateScore(job, profile),
    availability: availabilityScore(profile)
  };

  const raw = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score: Math.round((raw / MAX_SCORE) * 100), breakdown };
}

module.exports = { matchScore, WEIGHTS, MAX_SCORE };
