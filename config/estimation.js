'use strict';

/**
 * Estimation catalogues and multipliers.
 *
 * The MODULE catalogue is NOT here — it lives in `config/cloudFamilies.js`, which is the
 * single source for cloud families and their modules. This file holds only the things
 * that multiply or distribute that effort.
 *
 * Every number below is editorial: a published starting point, not a measurement. They
 * are gathered in one place precisely so they can be argued with and adjusted, rather
 * than being scattered as magic constants through the calculation.
 */

/**
 * AppExchange and adjacent products that add integration effort of their own.
 * Replaces the Dynamics ISV list (EDIFabric, Continia, BlackLine, ...).
 */
const ISV_SOLUTIONS = {
  'isv-conga': { name: 'Conga CLM / Composer', days: 15, category: 'Documents' },
  'isv-docusign': { name: 'DocuSign', days: 8, category: 'Documents' },
  'isv-certinia': { name: 'Certinia PSA / ERP', days: 25, category: 'Finance' },
  'isv-avalara': { name: 'Avalara Tax Automation', days: 10, category: 'Tax' },
  'isv-vertex': { name: 'Vertex Tax Engine', days: 12, category: 'Tax' },
  'isv-copado': { name: 'Copado DevOps', days: 12, category: 'DevOps' },
  'isv-gearset': { name: 'Gearset DevOps', days: 8, category: 'DevOps' },
  'isv-own': { name: 'Own (OwnBackup) Backup & Recovery', days: 8, category: 'Data' },
  'isv-mulesoft-composer': { name: 'MuleSoft Composer', days: 10, category: 'Integration' },
  'isv-zuora': { name: 'Zuora Billing', days: 22, category: 'Finance' },
  'isv-marketo': { name: 'Marketo (non-native marketing)', days: 15, category: 'Marketing' },
  'isv-nintex': { name: 'Nintex / DocGen', days: 10, category: 'Documents' },
  'isv-cti': { name: 'CTI / Telephony (Genesys, Five9, Amazon Connect)', days: 18, category: 'Contact Centre' },
  'isv-other': { name: 'Other AppExchange solution', days: 10, category: 'Other' }
};

const COMPLEXITY_MULTIPLIERS = {
  simple: { multiplier: 0.8, description: 'Standard configuration, close to out-of-the-box' },
  moderate: { multiplier: 1.0, description: 'Some declarative customisation and a few integrations' },
  complex: { multiplier: 1.4, description: 'Significant Apex/LWC work and multiple integrations' },
  enterprise: { multiplier: 1.8, description: 'Multi-org or global rollout with extensive custom development' }
};

const CUSTOMIZATION_MULTIPLIERS = {
  low: { multiplier: 0.9, description: 'Declarative only — Flow, validation rules, page layouts' },
  medium: { multiplier: 1.0, description: 'Mostly declarative with some Apex and LWC' },
  high: { multiplier: 1.3, description: 'Extensive Apex, LWC and custom data model' }
};

/**
 * Industry weighting. These reflect regulatory and approval burden, not how hard the
 * technology is.
 */
const INDUSTRY_MULTIPLIERS = {
  Technology: { multiplier: 0.95, description: 'Tech-literate users, faster adoption' },
  'Professional Services': { multiplier: 0.95, description: 'Service-focused, simpler data model' },
  Manufacturing: { multiplier: 1.0, description: 'Standard processes' },
  Retail: { multiplier: 1.0, description: 'Standard retail operations' },
  Distribution: { multiplier: 1.05, description: 'Complex logistics and fulfilment' },
  Education: { multiplier: 1.1, description: 'Many stakeholder groups, unusual workflows' },
  Healthcare: { multiplier: 1.2, description: 'Patient data handling and clinical sign-off' },
  'Financial Services': { multiplier: 1.25, description: 'Heavy compliance, audit and approval burden' },
  Government: { multiplier: 1.3, description: 'Procurement, accreditation and audit requirements' },
  Other: { multiplier: 1.0, description: 'Standard implementation' }
};

const COMPANY_SIZE_MULTIPLIERS = {
  'Small (1-50)': { multiplier: 0.85, userEstimate: 25, description: 'Small scope, fast decisions' },
  'Medium (51-500)': { multiplier: 1.0, userEstimate: 150, description: 'Standard deployment' },
  'Large (501-5000)': { multiplier: 1.15, userEstimate: 1500, description: 'Several departments, real governance' },
  'Enterprise (5000+)': { multiplier: 1.35, userEstimate: 5000, description: 'Global rollout, heavy change management' }
};

/**
 * Phase percentages. These must sum to 100; `assertEstimationIntegrity()` checks it at
 * boot, because a table that quietly sums to 98 shifts every estimate.
 *
 * "Deployment" here covers the Salesforce-specific release path — sandbox promotion, a
 * package or change set, and the production cutover — which is why it is not the
 * afterthought it can be on an on-premise ERP project.
 */
const PHASE_DISTRIBUTION = {
  discovery: {
    name: 'Discovery & Requirements',
    percentage: 10,
    description: 'Process mapping, user stories, org assessment, gap analysis'
  },
  design: {
    name: 'Solution Design',
    percentage: 15,
    description: 'Data model, sharing and security model, integration and identity design'
  },
  build: {
    name: 'Build & Configuration',
    percentage: 35,
    description: 'Declarative configuration, Apex and LWC, integrations, permission sets'
  },
  testing: {
    name: 'Testing & QA',
    percentage: 15,
    description: 'Apex tests to the 75% deploy gate, integration testing, UAT'
  },
  migration: {
    name: 'Data Migration',
    percentage: 10,
    description: 'Cleansing, external-id mapping, Bulk API 2.0 loads, reconciliation'
  },
  training: {
    name: 'Training & Adoption',
    percentage: 8,
    description: 'Role-based training, documentation, adoption tracking'
  },
  deployment: {
    name: 'Deployment & Go-Live',
    percentage: 5,
    description: 'Sandbox promotion, packaging or change sets, cutover'
  },
  support: {
    name: 'Hypercare',
    percentage: 2,
    description: 'Post-go-live support, defect triage, optimisation'
  }
};

/**
 * Default team shape and day rates.
 *
 * Percentages must sum to 100 for the same reason the phases must — the apportionment
 * distributes the project's man-days across these roles, and the result has to reconcile
 * with the phase total and the headline number.
 */
const DEFAULT_RESOURCE_ALLOCATION = {
  'solution-architect': { name: 'Solution Architect', percentage: 10, rate: 1100 },
  'technical-architect': { name: 'Technical Architect', percentage: 8, rate: 1200 },
  'functional-consultant': { name: 'Functional Consultant', percentage: 24, rate: 850 },
  'apex-developer': { name: 'Apex / LWC Developer', percentage: 24, rate: 800 },
  'integration-developer': { name: 'Integration Developer', percentage: 10, rate: 900 },
  'qa-engineer': { name: 'QA Engineer', percentage: 8, rate: 650 },
  'project-manager': { name: 'Project Manager', percentage: 11, rate: 850 },
  'change-manager': { name: 'Change & Adoption Lead', percentage: 5, rate: 750 }
};

/** Days added per integration, by how involved the integration is. */
const INTEGRATION_DAYS = { simple: 15, medium: 20, complex: 30 };

/** Effort assumed for each free-text item the client lists but we cannot map. */
const UNMAPPED_ITEM_DAYS = { module: 15, isv: 10 };

/** Phase-completion milestones surfaced on the timeline. */
const PHASE_MILESTONES = {
  discovery: 'Requirements sign-off',
  design: 'Design approved',
  build: 'Build complete',
  testing: 'UAT sign-off',
  migration: 'Data migration complete',
  training: 'Training complete',
  deployment: 'Go-live',
  support: 'Hypercare complete'
};

/**
 * Fail the boot rather than ship a silently wrong estimate.
 * Returns a list of problems; empty means consistent.
 */
function estimationProblems() {
  const problems = [];

  const phaseTotal = Object.values(PHASE_DISTRIBUTION).reduce((sum, p) => sum + p.percentage, 0);
  if (phaseTotal !== 100) problems.push(`PHASE_DISTRIBUTION sums to ${phaseTotal}, not 100`);

  const resourceTotal = Object.values(DEFAULT_RESOURCE_ALLOCATION).reduce((sum, r) => sum + r.percentage, 0);
  if (resourceTotal !== 100) problems.push(`DEFAULT_RESOURCE_ALLOCATION sums to ${resourceTotal}, not 100`);

  for (const [id, phase] of Object.entries(PHASE_DISTRIBUTION)) {
    if (!PHASE_MILESTONES[id]) problems.push(`phase "${id}" has no milestone`);
    if (!phase.name || !phase.description) problems.push(`phase "${id}" is missing a name or description`);
  }

  for (const [id, resource] of Object.entries(DEFAULT_RESOURCE_ALLOCATION)) {
    if (!(resource.rate > 0)) problems.push(`resource "${id}" has no positive day rate`);
  }

  return problems;
}

function assertEstimationIntegrity() {
  const problems = estimationProblems();
  if (problems.length) {
    throw new Error(`Estimation configuration is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
}

module.exports = {
  ISV_SOLUTIONS,
  COMPLEXITY_MULTIPLIERS,
  CUSTOMIZATION_MULTIPLIERS,
  INDUSTRY_MULTIPLIERS,
  COMPANY_SIZE_MULTIPLIERS,
  PHASE_DISTRIBUTION,
  DEFAULT_RESOURCE_ALLOCATION,
  INTEGRATION_DAYS,
  UNMAPPED_ITEM_DAYS,
  PHASE_MILESTONES,
  estimationProblems,
  assertEstimationIntegrity
};

/**
 * A fingerprint of every number that can move an estimate.
 *
 * Stored alongside each saved quote so a quote produced under an older catalogue can be
 * identified as stale rather than silently compared against today's figures. It is derived
 * rather than hand-maintained, because a version anyone has to remember to bump is a
 * version that is wrong.
 */
function catalogueVersion() {
  const crypto = require('crypto');
  const { MODULE_BASE_EFFORTS, FAMILY_FOUNDATION_EFFORTS } = require('./cloudFamilies');

  const material = JSON.stringify({
    MODULE_BASE_EFFORTS,
    FAMILY_FOUNDATION_EFFORTS,
    ISV_SOLUTIONS,
    COMPLEXITY_MULTIPLIERS,
    CUSTOMIZATION_MULTIPLIERS,
    INDUSTRY_MULTIPLIERS,
    COMPANY_SIZE_MULTIPLIERS,
    PHASE_DISTRIBUTION,
    DEFAULT_RESOURCE_ALLOCATION,
    INTEGRATION_DAYS,
    UNMAPPED_ITEM_DAYS
  });

  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 12);
}

module.exports.catalogueVersion = catalogueVersion;
