'use strict';

const { CLOUD_FAMILIES, MODULE_BASE_EFFORTS, FAMILY_FOUNDATION_EFFORTS } = require('../config/cloudFamilies');
const {
  ISV_SOLUTIONS,
  COMPLEXITY_MULTIPLIERS,
  CUSTOMIZATION_MULTIPLIERS,
  INDUSTRY_MULTIPLIERS,
  COMPANY_SIZE_MULTIPLIERS,
  PHASE_DISTRIBUTION,
  DEFAULT_RESOURCE_ALLOCATION,
  INTEGRATION_DAYS,
  UNMAPPED_ITEM_DAYS,
  PHASE_MILESTONES
} = require('../config/estimation');

/**
 * Project estimation engine.
 *
 * Entirely pure: it reads catalogues and returns a breakdown, touching no database and no
 * clock beyond a single timestamp. That is what makes the invariants below testable, and
 * they are the whole point of the module — an estimate whose parts do not add up to its
 * own total is worse than no estimate, because a client will find the discrepancy.
 *
 * The invariants, each of which is enforced by construction rather than by hoping:
 *
 *   1. Phase days sum EXACTLY to the total.
 *   2. Resource days sum EXACTLY to the same total.
 *   3. Every cost is `days × rate` on integers, so the budget reconciles line by line.
 *   4. The calendar duration is the sum of sequential phase durations, not the whole
 *      project divided by one fully-parallel team.
 */

const AVERAGE_TEAM_SIZE = 4;
const WORKING_DAYS_PER_WEEK = 5;
const MINIMUM_BASE_EFFORT_DAYS = 20;
const UNKNOWN_MODULE_DAYS = 15;

/**
 * Distribute an integer `total` across items by `weights` so the parts sum EXACTLY to
 * `total`.
 *
 * Largest-remainder (Hamilton): floor every share, then hand the leftover units to the
 * items with the largest fractional parts. Independent `Math.round(total * pct / 100)`
 * calls do NOT do this — each rounds in isolation, so the parts drift a unit or two away
 * from the headline figure and the document contradicts itself.
 *
 * @param {number} total integer total to distribute
 * @param {number[]} weights per-item weights, negatives treated as zero
 * @returns {number[]} integer parts summing to `total`
 */
function apportionDays(total, weights) {
  const target = Math.round(total);
  const positive = weights.map((w) => (w > 0 ? w : 0));
  const weightSum = positive.reduce((a, b) => a + b, 0);

  if (weightSum <= 0 || target <= 0) return weights.map(() => 0);

  const exact = positive.map((w) => (target * w) / weightSum);
  const parts = exact.map(Math.floor);

  let remainder = target - parts.reduce((a, b) => a + b, 0);
  const byFraction = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let k = 0; remainder > 0; k += 1, remainder -= 1) {
    parts[byFraction[k % byFraction.length].index] += 1;
  }

  return parts;
}

/**
 * Merge an override map over a defaults map, per key.
 *
 * A key present in the override wins and is shallow-merged over the default, so a partial
 * override like `{ days: 60 }` keeps the default's name and description. Keys absent from
 * the override are untouched. A non-object override is ignored entirely rather than
 * replacing the whole table with rubbish.
 */
function overrideConfigMap(defaults, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return defaults;

  const merged = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = { ...(defaults[key] || {}), ...value };
    }
  }
  return merged;
}

/**
 * Realistic calendar duration in whole weeks.
 *
 * The naive model — `ceil(totalDays / teamSize / daysPerWeek)` — treats the whole project
 * as one bucket of effort worked fully in parallel, which collapses a 300-day programme
 * into fifteen weeks. Salesforce phases run largely sequentially: you cannot build before
 * the sharing model is designed, or run UAT before the build lands. So the span is the SUM
 * of per-phase durations, with the team parallel WITHIN each phase.
 *
 * Excluded phases contribute nothing; every active phase takes at least one week.
 */
function computeProjectDurationWeeks(phaseDays, teamSize = AVERAGE_TEAM_SIZE, daysPerWeek = WORKING_DAYS_PER_WEEK) {
  const team = Math.max(1, teamSize);
  const perWeek = Math.max(1, daysPerWeek);

  const weeks = (phaseDays || []).reduce((sum, days) => {
    const value = Number(days) || 0;
    return value > 0 ? sum + Math.max(1, Math.ceil(value / team / perWeek)) : sum;
  }, 0);

  return Math.max(1, weeks);
}

/** Count comma-, semicolon- or newline-separated items in a free-text field. */
function countFreeTextItems(text) {
  if (!text || !String(text).trim()) return 0;
  return String(text)
    .split(/[,;\n]+/)
    .filter((item) => item.trim().length > 0).length;
}

/** Look up which family a module slug belongs to. */
const MODULE_PARENT = new Map();
for (const family of CLOUD_FAMILIES) {
  for (const module of family.modules) MODULE_PARENT.set(module.value, family.value);
}

/**
 * Calculate a full project estimate.
 *
 * @param {Object} input scope chosen by the client
 * @param {Object} config rates, contingency, currency and optional catalogue overrides
 * @returns {Object} the complete breakdown
 */
function calculateEstimation(input = {}, config = {}) {
  const {
    selectedFamilies = [],
    selectedModules = [],
    selectedIsvs = [],
    complexity = 'moderate',
    numberOfUsers = 50,
    numberOfOrgs = 1,
    numberOfIntegrations = 0,
    integrationComplexity = 'medium',
    customizationLevel = 'medium',
    clientIndustry = '',
    companySize = '',
    includeTraining = true,
    includeSupport = true,
    supportDurationDays = 30,
    otherModules = '',
    otherIsvs = '',
    otherIntegrations = ''
  } = input;

  const { contingencyPercentage = 15, currency = 'EUR' } = config;

  // Config-supplied values override the defaults per key, so a partial override can never
  // break the apportionment below.
  const moduleEfforts = { ...MODULE_BASE_EFFORTS, ...(config.moduleEfforts || {}) };
  const foundationEfforts = { ...FAMILY_FOUNDATION_EFFORTS, ...(config.foundationEfforts || {}) };
  const complexityMultipliers = overrideConfigMap(COMPLEXITY_MULTIPLIERS, config.complexityMultipliers);
  const customizationMultipliers = overrideConfigMap(CUSTOMIZATION_MULTIPLIERS, config.customizationMultipliers);
  const phaseDistribution = overrideConfigMap(PHASE_DISTRIBUTION, config.phaseDistribution);
  const resourceAllocationConfig = overrideConfigMap(DEFAULT_RESOURCE_ALLOCATION, config.resourceRates);

  // --- Step 1: base effort from the chosen scope -------------------------------------
  // Per family: max(foundation, sum of its selected modules). A cloud selected with no
  // modules still costs its platform setup; a cloud with modules costs at least their sum.
  const moduleBreakdown = [];
  const moduleDaysByFamily = {};

  for (const moduleSlug of selectedModules) {
    const familySlug = MODULE_PARENT.get(moduleSlug);
    const days = moduleEfforts[moduleSlug] ?? UNKNOWN_MODULE_DAYS;
    moduleDaysByFamily[familySlug || moduleSlug] = (moduleDaysByFamily[familySlug || moduleSlug] || 0) + days;
    moduleBreakdown.push({ id: moduleSlug, family: familySlug || null, days });
  }

  // A module whose family was not ticked still counts: the client chose the work.
  const families = new Set([...selectedFamilies, ...Object.keys(moduleDaysByFamily)]);

  let baseEffort = 0;
  const familyBreakdown = [];

  for (const familySlug of families) {
    const foundation = foundationEfforts[familySlug] ?? 0;
    const moduleDays = moduleDaysByFamily[familySlug] || 0;
    const effectiveDays = Math.max(foundation, moduleDays);
    baseEffort += effectiveDays;
    familyBreakdown.push({ id: familySlug, foundationDays: foundation, moduleDays, effectiveDays });
  }

  const isvBreakdown = [];
  for (const isvId of selectedIsvs) {
    const isv = ISV_SOLUTIONS[isvId];
    const days = isv ? isv.days : ISV_SOLUTIONS['isv-other'].days;
    baseEffort += days;
    isvBreakdown.push({ id: isvId, name: isv ? isv.name : isvId, category: isv ? isv.category : 'Other', days });
  }

  if (baseEffort === 0) baseEffort = MINIMUM_BASE_EFFORT_DAYS;

  // --- Step 2: multipliers -----------------------------------------------------------
  const complexityEntry = complexityMultipliers[complexity] || { multiplier: 1.0, description: '' };
  baseEffort *= complexityEntry.multiplier;

  // User scaling is logarithmic and floored: doubling the seat count does not double the
  // work, and a tiny pilot never falls below 80% of the baseline.
  const users = Math.max(1, parseInt(numberOfUsers, 10) || 50);
  const userMultiplier = Math.max(0.8, 1 + Math.log10(users / 50) * 0.2);
  baseEffort *= userMultiplier;

  // Each additional org is a whole extra deployment path, sandbox chain and data model.
  const orgs = Math.max(1, parseInt(numberOfOrgs, 10) || 1);
  const orgMultiplier = 1 + (orgs - 1) * 0.2;
  baseEffort *= orgMultiplier;

  const customizationEntry = customizationMultipliers[customizationLevel] || { multiplier: 1.0, description: '' };
  baseEffort *= customizationEntry.multiplier;

  const industryEntry = INDUSTRY_MULTIPLIERS[clientIndustry] || { multiplier: 1.0, description: '' };
  baseEffort *= industryEntry.multiplier;

  const companySizeEntry = COMPANY_SIZE_MULTIPLIERS[companySize] || { multiplier: 1.0, description: '' };
  baseEffort *= companySizeEntry.multiplier;

  // --- Step 3: additive effort -------------------------------------------------------
  const integrations = Math.max(0, parseInt(numberOfIntegrations, 10) || 0);
  const daysPerIntegration = INTEGRATION_DAYS[integrationComplexity] || INTEGRATION_DAYS.medium;
  baseEffort += integrations * daysPerIntegration;

  // Anything the client typed that we could not map to the catalogue is still scope, and
  // costing it at zero is how a quote becomes an argument later.
  const unmappedModules = countFreeTextItems(otherModules);
  const unmappedIsvs = countFreeTextItems(otherIsvs);
  const unmappedIntegrations = countFreeTextItems(otherIntegrations);
  const unmappedEffort =
    unmappedModules * UNMAPPED_ITEM_DAYS.module +
    unmappedIsvs * UNMAPPED_ITEM_DAYS.isv +
    unmappedIntegrations * daysPerIntegration;
  baseEffort += unmappedEffort;

  const totalBaseEffort = Math.round(baseEffort);

  // --- Step 4: contingency -----------------------------------------------------------
  const contingencyDays = Math.round(totalBaseEffort * (contingencyPercentage / 100));
  const totalEffort = totalBaseEffort + contingencyDays;

  // --- Step 5: phases ----------------------------------------------------------------
  // Percentages are finalised first (excluded phases zeroed, the slack redistributed into
  // build), and only then are days apportioned — so the phases sum exactly to the total.
  const phases = Object.entries(phaseDistribution).map(([id, phase]) => {
    let percentage = phase.percentage;
    if (id === 'training' && !includeTraining) percentage = 0;
    if (id === 'support' && !includeSupport) percentage = 0;
    return { id, name: phase.name, description: phase.description, percentage, days: 0 };
  });

  const declaredPercentage = phases.reduce((sum, p) => sum + p.percentage, 0);
  if (declaredPercentage < 100) {
    const build = phases.find((p) => p.id === 'build') || phases[0];
    build.percentage += 100 - declaredPercentage;
  }

  const phaseDays = apportionDays(totalEffort, phases.map((p) => p.percentage));
  phases.forEach((phase, index) => {
    phase.days = phaseDays[index];
  });

  // --- Step 6: resources -------------------------------------------------------------
  const resourceEntries = Object.entries(resourceAllocationConfig);
  const resourceDays = apportionDays(totalEffort, resourceEntries.map(([, r]) => r.percentage));
  const resourceAllocation = resourceEntries.map(([id, resource], index) => {
    const days = resourceDays[index];
    const dailyRate = Math.round(resource.rate);
    return {
      id,
      name: resource.name,
      percentage: resource.percentage,
      days,
      dailyRate,
      // Integer arithmetic on integers: the line items add up to the budget exactly.
      totalCost: days * dailyRate
    };
  });

  const implementationBudget = resourceAllocation.reduce((sum, r) => sum + r.totalCost, 0);

  // --- Step 7: duration, rate, hypercare ---------------------------------------------
  const projectDurationWeeks = computeProjectDurationWeeks(phases.map((p) => p.days));
  const averageDailyRate = Math.round(implementationBudget / totalEffort);

  let supportBudget = 0;
  if (includeSupport && supportDurationDays > 0) {
    // Hypercare is a reduced team: two people for the working days in the window.
    const supportWorkingDays = Math.ceil(supportDurationDays / 7) * WORKING_DAYS_PER_WEEK;
    supportBudget = supportWorkingDays * averageDailyRate * 2;
  }

  return {
    totalManDays: totalEffort,
    baseEffort: totalBaseEffort,
    contingencyDays,
    contingencyPercentage,

    implementationBudget,
    supportBudget,
    totalBudget: implementationBudget + supportBudget,
    averageDailyRate,
    currency,

    projectDurationWeeks,
    projectDurationMonths: Math.max(1, Math.round(projectDurationWeeks / 4.33)),

    familyBreakdown,
    moduleBreakdown,
    isvBreakdown,
    phaseBreakdown: phases,
    resourceAllocation,
    timeline: generateTimeline(phases),

    unmapped: {
      modules: unmappedModules,
      isvs: unmappedIsvs,
      integrations: unmappedIntegrations,
      days: unmappedEffort
    },

    multipliers: {
      complexity: { value: complexityEntry.multiplier, description: complexityEntry.description },
      users: { value: Number(userMultiplier.toFixed(2)), count: users },
      orgs: { value: Number(orgMultiplier.toFixed(2)), count: orgs },
      customization: { value: customizationEntry.multiplier, description: customizationEntry.description },
      industry: { value: industryEntry.multiplier, name: clientIndustry || 'Not specified', description: industryEntry.description },
      companySize: { value: companySizeEntry.multiplier, name: companySize || 'Not specified', description: companySizeEntry.description },
      integrations: { count: integrations, daysEach: daysPerIntegration, complexity: integrationComplexity }
    },

    options: { includeTraining, includeSupport, supportDurationDays },
    calculatedAt: new Date().toISOString()
  };
}

/**
 * Sequential timeline over the active phases.
 *
 * Weeks come from the same per-phase calculation as the headline duration, so the Gantt
 * and the summary agree. Deriving them from a percentage of the total instead is how the
 * two end up contradicting each other.
 */
function generateTimeline(phases) {
  const timeline = [];
  let cursor = 0;

  for (const phase of phases) {
    if (phase.days <= 0) continue;
    const weeks = Math.max(1, Math.ceil(phase.days / AVERAGE_TEAM_SIZE / WORKING_DAYS_PER_WEEK));
    timeline.push({
      phase: phase.name,
      phaseId: phase.id,
      startWeek: cursor + 1,
      endWeek: cursor + weeks,
      durationWeeks: weeks,
      days: phase.days,
      milestone: PHASE_MILESTONES[phase.id] || 'Phase complete'
    });
    cursor += weeks;
  }

  return timeline;
}

/**
 * Cross-check a finished estimate against its own invariants.
 *
 * Called by the route before an estimate is ever shown or stored. If this returns
 * anything, the estimate contradicts itself and must not be presented as a quote.
 */
function reconciliationProblems(estimate) {
  const problems = [];

  const phaseSum = estimate.phaseBreakdown.reduce((sum, p) => sum + p.days, 0);
  if (phaseSum !== estimate.totalManDays) {
    problems.push(`phase days sum to ${phaseSum}, but the total is ${estimate.totalManDays}`);
  }

  const resourceSum = estimate.resourceAllocation.reduce((sum, r) => sum + r.days, 0);
  if (resourceSum !== estimate.totalManDays) {
    problems.push(`resource days sum to ${resourceSum}, but the total is ${estimate.totalManDays}`);
  }

  const costSum = estimate.resourceAllocation.reduce((sum, r) => sum + r.days * r.dailyRate, 0);
  if (costSum !== estimate.implementationBudget) {
    problems.push(`resource costs sum to ${costSum}, but the implementation budget is ${estimate.implementationBudget}`);
  }

  if (estimate.baseEffort + estimate.contingencyDays !== estimate.totalManDays) {
    problems.push('base effort plus contingency does not equal the total');
  }

  const timelineWeeks = estimate.timeline.reduce((sum, t) => sum + t.durationWeeks, 0);
  if (timelineWeeks !== estimate.projectDurationWeeks) {
    problems.push(`timeline spans ${timelineWeeks} weeks, but the headline duration is ${estimate.projectDurationWeeks}`);
  }

  return problems;
}

module.exports = {
  apportionDays,
  overrideConfigMap,
  computeProjectDurationWeeks,
  countFreeTextItems,
  calculateEstimation,
  generateTimeline,
  reconciliationProblems,
  AVERAGE_TEAM_SIZE,
  WORKING_DAYS_PER_WEEK
};
