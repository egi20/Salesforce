'use strict';

/**
 * The Salesforce consulting role taxonomy.
 *
 * This is the single source of truth. In the Dynamics reference implementation the
 * equivalent list was duplicated across eight files and had already drifted
 * (`pm` vs `project-manager`), so every consumer here imports from this module and
 * nothing re-declares a slug list.
 *
 *   value = the slug stored in `jobs.role` and `consultant_profiles.primary_role`
 *   label = the display string
 *
 * Storing the SLUG (never the label) on both tables is deliberate: the reference
 * implementation stored the label on profiles and the slug on jobs, which made
 * matching and rate bucketing require a fragile label<->slug reverse lookup.
 */
const ROLE_CATEGORIES = [
  {
    category: 'Functional Consultants',
    roles: [
      { value: 'sales-cloud', label: 'Sales Cloud Consultant' },
      { value: 'service-cloud', label: 'Service Cloud Consultant' },
      { value: 'revenue-cloud', label: 'Revenue Cloud Consultant' },
      { value: 'cpq-consultant', label: 'CPQ & Billing Consultant' },
      { value: 'commerce-cloud', label: 'Commerce Cloud Consultant' },
      { value: 'field-service', label: 'Field Service Consultant' },
      { value: 'marketing-cloud', label: 'Marketing Cloud Consultant' },
      { value: 'pardot-mcae', label: 'Account Engagement (Pardot) Consultant' },
      { value: 'experience-cloud', label: 'Experience Cloud Consultant' },
      { value: 'nonprofit-cloud', label: 'Nonprofit / Education Cloud Consultant' },
      { value: 'health-cloud', label: 'Health Cloud Consultant' },
      { value: 'financial-services-cloud', label: 'Financial Services Cloud Consultant' },
      { value: 'psa-consultant', label: 'PSA / Professional Services Consultant' },
      /*
       * These two replace `smb-erp-isv` and `hcm-isv`, which were carried over from the
       * Dynamics reference and named nothing that exists in the Salesforce ecosystem —
       * "SMB ERP" is Business Central and "HCM ISV" is a Dynamics HR partner. Neither had
       * a single entry in ROLE_ALIASES, which is what gave them away: they were two of the
       * only three roles nobody could map a real search term onto, because there was no
       * real term to map. Renaming was free here because nothing stored them — no seed row,
       * no other module, and nothing deployed. Once this application holds data, changing a
       * slug is a migration, not an edit.
       */
      { value: 'appexchange-isv', label: 'AppExchange / ISV Consultant' },
      { value: 'manufacturing-cloud', label: 'Manufacturing / Consumer Goods Cloud Consultant' }
    ]
  },
  {
    category: 'Technical Roles',
    roles: [
      { value: 'apex-developer', label: 'Apex Developer' },
      { value: 'lwc-developer', label: 'LWC Developer' },
      { value: 'platform-developer', label: 'Platform Developer' },
      { value: 'flow-specialist', label: 'Flow / Automation Specialist' },
      // OmniStudio is a module in `config/cloudFamilies.js` and a certification in
      // `config/certifications.js`, and had no role. A catalogue that names a product in
      // two places and offers no way to say you work on it is a gap, not a decision.
      { value: 'omnistudio-developer', label: 'OmniStudio / Vlocity Developer' },
      { value: 'mulesoft-developer', label: 'MuleSoft Developer' },
      { value: 'integration-architect', label: 'Integration Architect' },
      { value: 'crm-analytics', label: 'CRM Analytics Consultant' },
      { value: 'tableau-consultant', label: 'Tableau Consultant' },
      { value: 'data-cloud-consultant', label: 'Data Cloud Consultant' },
      { value: 'data-migration', label: 'Data Migration Specialist' },
      { value: 'devops-engineer', label: 'Salesforce DevOps Engineer' },
      { value: 'qa-engineer', label: 'Salesforce QA Engineer' }
    ]
  },
  {
    category: 'AI & Agentforce',
    roles: [
      { value: 'agentforce-developer', label: 'Agentforce Developer' },
      { value: 'einstein-consultant', label: 'Einstein Consultant' },
      { value: 'ai-architect', label: 'AI Architect' }
    ]
  },
  {
    category: 'Architecture & Leadership',
    roles: [
      { value: 'solution-architect-core', label: 'Solution Architect (Core Clouds)' },
      { value: 'solution-architect-industries', label: 'Solution Architect (Industries)' },
      { value: 'technical-architect', label: 'Technical Architect' },
      { value: 'cta-track', label: 'Certified Technical Architect (CTA)' },
      { value: 'business-analyst', label: 'Business Analyst' }
    ]
  },
  {
    category: 'Program & Business',
    roles: [
      { value: 'project-manager', label: 'Project Manager' },
      { value: 'program-manager', label: 'Programme Manager' },
      { value: 'change-manager', label: 'Change Manager' },
      { value: 'pmo', label: 'PMO' },
      { value: 'business-developer', label: 'Business Developer' }
    ]
  },
  {
    category: 'HR & Recruitment',
    roles: [
      { value: 'hr-manager', label: 'HR Manager' },
      { value: 'recruiter', label: 'Recruiter' }
    ]
  }
];

const ALL_ROLES = ROLE_CATEGORIES.flatMap((c) => c.roles);
const ROLE_SLUGS = ALL_ROLES.map((r) => r.value);
const ROLE_LABELS = new Map(ALL_ROLES.map((r) => [r.value, r.label]));

/**
 * Curated editorial base day rates (EUR) per role slug.
 *
 * Every slug in ROLE_SLUGS must appear here. `assertTaxonomyIntegrity()` enforces
 * that at boot: in the reference implementation a missing slug fell back silently to
 * a flat default, which quietly flattened whole rate buckets.
 */
const BASE_DAY_RATES = {
  'sales-cloud': 650,
  'service-cloud': 650,
  'revenue-cloud': 780,
  'cpq-consultant': 800,
  'commerce-cloud': 750,
  'field-service': 720,
  'marketing-cloud': 700,
  'pardot-mcae': 620,
  'experience-cloud': 650,
  'nonprofit-cloud': 550,
  'health-cloud': 720,
  'financial-services-cloud': 760,
  'psa-consultant': 700,
  'appexchange-isv': 720,
  'manufacturing-cloud': 700,
  'apex-developer': 680,
  'lwc-developer': 660,
  'platform-developer': 650,
  'flow-specialist': 600,
  'omnistudio-developer': 760,
  'mulesoft-developer': 800,
  'integration-architect': 900,
  'crm-analytics': 720,
  'tableau-consultant': 700,
  'data-cloud-consultant': 820,
  'data-migration': 640,
  'devops-engineer': 700,
  'qa-engineer': 550,
  'agentforce-developer': 850,
  'einstein-consultant': 800,
  'ai-architect': 950,
  'solution-architect-core': 950,
  'solution-architect-industries': 980,
  'technical-architect': 1000,
  'cta-track': 1200,
  'business-analyst': 600,
  'project-manager': 700,
  'program-manager': 850,
  'change-manager': 650,
  pmo: 550,
  'business-developer': 600,
  'hr-manager': 500,
  recruiter: 450
};

/**
 * Aliases used by the matcher so that a job asking for "CPQ" still scores against a
 * consultant whose primary role is `revenue-cloud`. A missing alias does not break
 * anything loudly — it just makes matches score low — which is exactly why the
 * integrity assertion below also checks that every alias target is a real slug.
 */
const ROLE_ALIASES = {
  'sales-cloud': ['sales', 'crm', 'sfdc sales', 'opportunity management'],
  'service-cloud': ['service', 'case management', 'omni-channel', 'contact center'],
  'revenue-cloud': ['cpq', 'billing', 'subscription management', 'quote to cash'],
  'cpq-consultant': ['cpq', 'configure price quote', 'steelbrick'],
  'commerce-cloud': ['b2b commerce', 'b2c commerce', 'demandware', 'sfcc'],
  'field-service': ['fsl', 'work orders', 'service appointments', 'scheduling'],
  'marketing-cloud': ['sfmc', 'marketing cloud engagement', 'journey builder', 'ampscript'],
  'pardot-mcae': ['pardot', 'mcae', 'account engagement'],
  'experience-cloud': ['community cloud', 'portal', 'partner portal'],
  'health-cloud': ['health'],
  'financial-services-cloud': ['fsc', 'banking', 'insurance'],
  'psa-consultant': ['certinia', 'financialforce', 'professional services automation'],
  'nonprofit-cloud': ['npsp', 'nonprofit success pack', 'education cloud', 'eda'],
  'appexchange-isv': ['appexchange', 'isv', 'managed package', '2gp', 'packaging'],
  'manufacturing-cloud': ['manufacturing cloud', 'consumer goods cloud', 'sales agreements', 'rebate management'],
  'apex-developer': ['apex', 'soql', 'triggers', 'batch apex'],
  'lwc-developer': ['lightning web components', 'lwc', 'aura', 'lightning'],
  'platform-developer': ['platform app builder', 'declarative', 'admin developer'],
  'flow-specialist': ['flow', 'flow orchestration', 'process builder', 'automation'],
  'omnistudio-developer': ['omnistudio', 'vlocity', 'omniscript', 'flexcard', 'dataraptor'],
  'mulesoft-developer': ['mulesoft', 'anypoint', 'dataweave'],
  'integration-architect': ['integration', 'api', 'platform events', 'change data capture'],
  'crm-analytics': ['tableau crm', 'einstein analytics', 'saql'],
  'tableau-consultant': ['tableau'],
  'data-cloud-consultant': ['data cloud', 'cdp', 'customer 360'],
  'data-migration': ['data loader', 'bulk api', 'etl', 'migration'],
  'devops-engineer': ['sfdx', 'devops center', 'gearset', 'copado', 'ci/cd'],
  'qa-engineer': ['test automation', 'provar', 'selenium', 'qa'],
  'agentforce-developer': ['agentforce', 'einstein copilot', 'prompt builder'],
  'einstein-consultant': ['einstein', 'einstein bots', 'next best action'],
  'ai-architect': ['ai', 'llm', 'generative ai'],
  'solution-architect-core': ['solution architect', 'sales service architect'],
  'solution-architect-industries': ['industries', 'vlocity', 'omnistudio'],
  'technical-architect': ['technical architect', 'ta'],
  'cta-track': ['cta', 'certified technical architect'],
  'business-analyst': ['ba', 'requirements', 'user stories'],
  'project-manager': ['pm', 'delivery manager'],
  'program-manager': ['programme manager'],
  'change-manager': ['ocm', 'organisational change'],
  pmo: ['project management office'],
  'business-developer': ['bizdev', 'sales manager'],
  'hr-manager': ['people manager'],
  recruiter: ['talent acquisition', 'headhunter']
};

const SENIORITY_LEVELS = [
  { value: 'junior', label: 'Junior (0-2 yrs)', multiplier: 0.65 },
  { value: 'mid', label: 'Mid (3-5 yrs)', multiplier: 0.85 },
  { value: 'senior', label: 'Senior (6-9 yrs)', multiplier: 1.0 },
  { value: 'lead', label: 'Lead / Principal (10+ yrs)', multiplier: 1.25 }
];

const SENIORITY_MULTIPLIERS = new Map(SENIORITY_LEVELS.map((s) => [s.value, s.multiplier]));

/**
 * Fail fast at boot rather than degrade silently at runtime.
 * Returns the list of problems; an empty array means the taxonomy is consistent.
 */
function taxonomyProblems() {
  const problems = [];
  const seen = new Set();

  for (const slug of ROLE_SLUGS) {
    if (seen.has(slug)) problems.push(`duplicate role slug: ${slug}`);
    seen.add(slug);
    if (!/^[a-z0-9-]+$/.test(slug)) problems.push(`role slug is not kebab-case: ${slug}`);
    if (!(slug in BASE_DAY_RATES)) problems.push(`role slug missing from BASE_DAY_RATES: ${slug}`);
  }

  for (const slug of Object.keys(BASE_DAY_RATES)) {
    if (!seen.has(slug)) problems.push(`BASE_DAY_RATES has an unknown role slug: ${slug}`);
  }

  for (const slug of Object.keys(ROLE_ALIASES)) {
    if (!seen.has(slug)) problems.push(`ROLE_ALIASES has an unknown role slug: ${slug}`);
  }

  return problems;
}

function assertTaxonomyIntegrity() {
  const problems = taxonomyProblems();
  if (problems.length) {
    throw new Error(`Role taxonomy is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
}

function isValidRole(slug) {
  return ROLE_LABELS.has(slug);
}

function roleLabel(slug) {
  return ROLE_LABELS.get(slug) || slug || '';
}

function baseDayRate(slug) {
  return BASE_DAY_RATES[slug] ?? null;
}

module.exports = {
  ROLE_CATEGORIES,
  ALL_ROLES,
  ROLE_SLUGS,
  BASE_DAY_RATES,
  ROLE_ALIASES,
  SENIORITY_LEVELS,
  SENIORITY_MULTIPLIERS,
  taxonomyProblems,
  assertTaxonomyIntegrity,
  isValidRole,
  roleLabel,
  baseDayRate
};
