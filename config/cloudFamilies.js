'use strict';

/**
 * Salesforce product families and their modules.
 *
 * Replaces the Dynamics 365 product/module tree. Used by the job posting form
 * (required skills context), the consultant profile builder and the forum-style
 * category tree once community lands.
 *
 * `baseEffortDays` is the editorial baseline used by the estimator: the number of
 * consultant-days a greenfield implementation of that module typically takes before
 * complexity, integration and data-migration multipliers are applied.
 */
const CLOUD_FAMILIES = [
  {
    value: 'sales-cloud',
    label: 'Sales Cloud',
    modules: [
      { value: 'lead-management', label: 'Lead Management', baseEffortDays: 8 },
      { value: 'opportunity-management', label: 'Opportunity Management', baseEffortDays: 10 },
      { value: 'forecasting', label: 'Collaborative Forecasting', baseEffortDays: 12 },
      { value: 'sales-engagement', label: 'Sales Engagement / Cadences', baseEffortDays: 9 },
      { value: 'territory-management', label: 'Enterprise Territory Management', baseEffortDays: 14 }
    ]
  },
  {
    value: 'service-cloud',
    label: 'Service Cloud',
    modules: [
      { value: 'case-management', label: 'Case Management', baseEffortDays: 10 },
      { value: 'omni-channel', label: 'Omni-Channel Routing', baseEffortDays: 12 },
      { value: 'knowledge', label: 'Salesforce Knowledge', baseEffortDays: 9 },
      { value: 'service-voice', label: 'Service Cloud Voice', baseEffortDays: 20 },
      { value: 'digital-engagement', label: 'Digital Engagement / Messaging', baseEffortDays: 14 }
    ]
  },
  {
    value: 'revenue-cloud',
    label: 'Revenue Cloud',
    modules: [
      { value: 'cpq', label: 'CPQ (Configure Price Quote)', baseEffortDays: 30 },
      { value: 'billing', label: 'Billing & Invoicing', baseEffortDays: 28 },
      { value: 'subscription-management', label: 'Subscription Management', baseEffortDays: 22 },
      { value: 'product-catalog', label: 'Product Catalogue & Price Books', baseEffortDays: 12 }
    ]
  },
  {
    value: 'marketing-cloud',
    label: 'Marketing Cloud',
    modules: [
      { value: 'engagement', label: 'Marketing Cloud Engagement', baseEffortDays: 25 },
      { value: 'journey-builder', label: 'Journey Builder', baseEffortDays: 15 },
      { value: 'account-engagement', label: 'Account Engagement (Pardot)', baseEffortDays: 14 },
      { value: 'personalization', label: 'Personalisation / Interaction Studio', baseEffortDays: 20 }
    ]
  },
  {
    value: 'data-cloud',
    label: 'Data Cloud',
    modules: [
      { value: 'ingestion', label: 'Data Streams & Ingestion', baseEffortDays: 18 },
      { value: 'identity-resolution', label: 'Identity Resolution', baseEffortDays: 16 },
      { value: 'calculated-insights', label: 'Calculated Insights', baseEffortDays: 12 },
      { value: 'activation', label: 'Segments & Activation', baseEffortDays: 14 }
    ]
  },
  {
    value: 'field-service',
    label: 'Field Service',
    modules: [
      { value: 'work-orders', label: 'Work Orders & Service Appointments', baseEffortDays: 16 },
      { value: 'scheduling-optimization', label: 'Scheduling & Optimisation', baseEffortDays: 22 },
      { value: 'mobile-app', label: 'Field Service Mobile', baseEffortDays: 12 },
      { value: 'asset-management', label: 'Assets & Maintenance Plans', baseEffortDays: 14 }
    ]
  },
  {
    value: 'commerce-cloud',
    label: 'Commerce Cloud',
    modules: [
      { value: 'b2b-commerce', label: 'B2B Commerce', baseEffortDays: 35 },
      { value: 'b2c-commerce', label: 'B2C Commerce', baseEffortDays: 45 },
      { value: 'order-management', label: 'Order Management', baseEffortDays: 25 }
    ]
  },
  {
    value: 'experience-cloud',
    label: 'Experience Cloud',
    modules: [
      { value: 'partner-portal', label: 'Partner Portal', baseEffortDays: 18 },
      { value: 'customer-portal', label: 'Customer Self-Service Portal', baseEffortDays: 16 },
      { value: 'public-site', label: 'Public Site & SEO', baseEffortDays: 10 }
    ]
  },
  {
    value: 'platform',
    label: 'Salesforce Platform',
    modules: [
      { value: 'custom-objects', label: 'Custom Objects & Data Model', baseEffortDays: 10 },
      { value: 'lwc', label: 'Lightning Web Components', baseEffortDays: 14 },
      { value: 'apex', label: 'Apex Services & Triggers', baseEffortDays: 16 },
      { value: 'flow', label: 'Flow & Flow Orchestration', baseEffortDays: 10 },
      { value: 'sharing-security', label: 'Sharing Model & Security', baseEffortDays: 12 }
    ]
  },
  {
    value: 'integration',
    label: 'Integration',
    modules: [
      { value: 'rest-api', label: 'REST / Composite API', baseEffortDays: 10 },
      { value: 'bulk-api', label: 'Bulk API 2.0 Loads', baseEffortDays: 8 },
      { value: 'platform-events', label: 'Platform Events / CDC', baseEffortDays: 12 },
      { value: 'mulesoft', label: 'MuleSoft Anypoint', baseEffortDays: 30 },
      { value: 'salesforce-connect', label: 'Salesforce Connect / External Objects', baseEffortDays: 14 }
    ]
  },
  {
    value: 'analytics',
    label: 'Analytics',
    modules: [
      { value: 'reports-dashboards', label: 'Reports & Dashboards', baseEffortDays: 8 },
      { value: 'crm-analytics', label: 'CRM Analytics', baseEffortDays: 20 },
      { value: 'tableau', label: 'Tableau', baseEffortDays: 18 }
    ]
  },
  {
    value: 'agentforce',
    label: 'Agentforce & Einstein',
    modules: [
      { value: 'agents', label: 'Agentforce Agents', baseEffortDays: 20 },
      { value: 'prompt-builder', label: 'Prompt Builder & Templates', baseEffortDays: 10 },
      { value: 'einstein-bots', label: 'Einstein Bots', baseEffortDays: 14 },
      { value: 'predictions', label: 'Einstein Predictions / NBA', baseEffortDays: 16 }
    ]
  },
  {
    value: 'industries',
    label: 'Industry Clouds',
    modules: [
      { value: 'health-cloud', label: 'Health Cloud', baseEffortDays: 30 },
      { value: 'financial-services-cloud', label: 'Financial Services Cloud', baseEffortDays: 32 },
      { value: 'nonprofit-cloud', label: 'Nonprofit Cloud', baseEffortDays: 22 },
      { value: 'education-cloud', label: 'Education Cloud', baseEffortDays: 22 },
      { value: 'manufacturing-cloud', label: 'Manufacturing Cloud', baseEffortDays: 28 },
      { value: 'omnistudio', label: 'OmniStudio / Vlocity', baseEffortDays: 26 }
    ]
  }
];

const ALL_MODULES = CLOUD_FAMILIES.flatMap((f) =>
  f.modules.map((m) => ({ ...m, family: f.value, familyLabel: f.label }))
);

const MODULE_BASE_EFFORTS = Object.fromEntries(ALL_MODULES.map((m) => [m.value, m.baseEffortDays]));
const MODULE_LABELS = new Map(ALL_MODULES.map((m) => [m.value, m.label]));
const FAMILY_LABELS = new Map(CLOUD_FAMILIES.map((f) => [f.value, f.label]));

function isValidModule(slug) {
  return MODULE_LABELS.has(slug);
}

function moduleLabel(slug) {
  return MODULE_LABELS.get(slug) || slug || '';
}

function familyLabel(slug) {
  return FAMILY_LABELS.get(slug) || slug || '';
}

module.exports = {
  CLOUD_FAMILIES,
  ALL_MODULES,
  MODULE_BASE_EFFORTS,
  isValidModule,
  moduleLabel,
  familyLabel
};
