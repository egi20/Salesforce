'use strict';

/**
 * The estimate form, read and written.
 *
 * `inputsFrom` turns the posted form into the estimator's input shape and `valuesFromQuote`
 * turns a stored quote back into the form's field names — two directions, one mapping, kept
 * in one file so a field added to one cannot be forgotten in the other (a test round-trips a
 * quote through both). The preview and the save both read the form through here, which is
 * what makes the running total on the page the figure that gets stored.
 */

const {
  ISV_SOLUTIONS,
  COMPLEXITY_MULTIPLIERS,
  CUSTOMIZATION_MULTIPLIERS,
  INDUSTRY_MULTIPLIERS,
  COMPANY_SIZE_MULTIPLIERS
} = require('../config/estimation');
const { isValidFamily, isValidModule } = require('../config/cloudFamilies');
const { toPlainText } = require('./sanitize');

/*
 * `hasOwnProperty`, never a truthiness check on the lookup: `COMPLEXITY_MULTIPLIERS['__proto__']`
 * is `Object.prototype`, which is truthy, so `?complexity=__proto__` used to reach the
 * estimator as a complexity it would then read `.multiplier` from. The same trap
 * `AppSetting.isValidKey` and `ImageBlob`'s table lookup avoid.
 */
const own = (table, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);

/**
 * Read the wizard form into the estimator's input shape.
 *
 * Everything the client can send is filtered against the catalogue here, so an unknown
 * slug is dropped rather than silently costed at a default. Free text survives as free
 * text and is costed explicitly as unmapped scope.
 */
function inputsFrom(form) {
  const asArray = (value) => (Array.isArray(value) ? value : [value].filter(Boolean));

  return {
    selectedFamilies: asArray(form.families).filter(isValidFamily),
    selectedModules: asArray(form.modules).filter(isValidModule),
    selectedIsvs: asArray(form.isvs).filter((id) => own(ISV_SOLUTIONS, id)),
    complexity: own(COMPLEXITY_MULTIPLIERS, form.complexity) ? form.complexity : 'moderate',
    customizationLevel: own(CUSTOMIZATION_MULTIPLIERS, form.customization_level) ? form.customization_level : 'medium',
    clientIndustry: own(INDUSTRY_MULTIPLIERS, form.client_industry) ? form.client_industry : '',
    companySize: own(COMPANY_SIZE_MULTIPLIERS, form.company_size) ? form.company_size : '',
    numberOfUsers: form.number_of_users,
    numberOfOrgs: form.number_of_orgs,
    numberOfIntegrations: form.number_of_integrations,
    integrationComplexity: ['simple', 'medium', 'complex'].includes(form.integration_complexity)
      ? form.integration_complexity
      : 'medium',
    includeTraining: form.include_training === 'on',
    includeSupport: form.include_support === 'on',
    supportDurationDays: Math.max(0, Math.min(365, parseInt(form.support_duration_days, 10) || 0)),
    otherModules: String(form.other_modules || '').slice(0, 1000),
    otherIsvs: String(form.other_isvs || '').slice(0, 1000),
    otherIntegrations: String(form.other_integrations || '').slice(0, 1000)
  };
}

/** The two options that are not inputs to the effort, read the same way for preview and save. */
function optionsFrom(form) {
  return {
    contingencyPercentage: Math.max(0, Math.min(50, parseInt(form.contingency_percentage, 10) || 15)),
    currency: /^[A-Z]{3}$/.test(form.currency || '') ? form.currency : 'EUR'
  };
}

function hasScope(inputs) {
  return Boolean(
    inputs.selectedFamilies.length || inputs.selectedModules.length || inputs.selectedIsvs.length || inputs.otherModules.trim()
  );
}

/*
 * A stored quote read back into the form's field names — the inverse of `inputsFrom`. The
 * values are re-filtered on save exactly as typed ones are, so a module dropped from the
 * catalogue since is simply not ticked. The summary was stored as sanitised HTML and goes
 * back into a plain text input as text.
 */
function valuesFromQuote(quote) {
  const i = quote.inputs || {};
  const e = quote.estimate || {};
  const on = (flag) => (flag ? 'on' : '');
  return {
    client_company: quote.client_company,
    client_name: quote.client_name,
    client_email: quote.client_email || '',
    client_industry: quote.client_industry || '',
    company_size: quote.company_size || '',
    project_name: quote.project_name,
    project_summary: toPlainText(quote.project_summary || ''),
    families: i.selectedFamilies || [],
    modules: i.selectedModules || [],
    isvs: i.selectedIsvs || [],
    other_modules: i.otherModules || '',
    other_integrations: i.otherIntegrations || '',
    number_of_integrations: i.numberOfIntegrations || 0,
    integration_complexity: i.integrationComplexity || 'medium',
    complexity: i.complexity || 'moderate',
    customization_level: i.customizationLevel || 'medium',
    number_of_users: i.numberOfUsers || 50,
    number_of_orgs: i.numberOfOrgs || 1,
    include_training: on(i.includeTraining),
    include_support: on(i.includeSupport),
    support_duration_days: i.supportDurationDays || 0,
    contingency_percentage: e.contingencyPercentage ?? 15,
    currency: e.currency || 'EUR'
  };
}

module.exports = { inputsFrom, optionsFrom, hasScope, valuesFromQuote };
