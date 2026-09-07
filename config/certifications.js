'use strict';

/**
 * Salesforce credentials, replacing the MB-/PL-/MS- exam list of the reference
 * implementation. Grouped the way Trailhead groups them so the profile builder can
 * render optgroups without a second mapping.
 */
const CERTIFICATIONS = [
  {
    group: 'Administrator',
    items: [
      'Salesforce Certified Administrator',
      'Salesforce Certified Advanced Administrator',
      'Salesforce Certified Business Analyst'
    ]
  },
  {
    group: 'Developer',
    items: [
      'Salesforce Certified Platform App Builder',
      'Salesforce Certified Platform Developer I',
      'Salesforce Certified Platform Developer II',
      'Salesforce Certified JavaScript Developer I',
      'Salesforce Certified OmniStudio Developer'
    ]
  },
  {
    group: 'Consultant',
    items: [
      'Salesforce Certified Sales Cloud Consultant',
      'Salesforce Certified Service Cloud Consultant',
      'Salesforce Certified Experience Cloud Consultant',
      'Salesforce Certified Field Service Consultant',
      'Salesforce Certified CPQ Specialist',
      'Salesforce Certified Data Cloud Consultant',
      'Salesforce Certified Marketing Cloud Consultant',
      'Salesforce Certified Marketing Cloud Email Specialist',
      'Salesforce Certified Marketing Cloud Account Engagement Consultant',
      'Salesforce Certified Nonprofit Cloud Consultant',
      'Salesforce Certified Education Cloud Consultant',
      'Salesforce Certified Tableau CRM and Einstein Discovery Consultant'
    ]
  },
  {
    group: 'Architect',
    items: [
      'Salesforce Certified Integration Architect',
      'Salesforce Certified Data Architect',
      'Salesforce Certified Sharing and Visibility Architect',
      'Salesforce Certified Identity and Access Management Architect',
      'Salesforce Certified Development Lifecycle and Deployment Architect',
      'Salesforce Certified Application Architect',
      'Salesforce Certified System Architect',
      'Salesforce Certified Technical Architect (CTA)'
    ]
  },
  {
    group: 'AI',
    items: [
      'Salesforce Certified AI Associate',
      'Salesforce Certified AI Specialist',
      'Salesforce Certified Agentforce Specialist'
    ]
  },
  {
    group: 'MuleSoft & Tableau',
    items: [
      'MuleSoft Certified Developer - Level 1',
      'MuleSoft Certified Platform Architect - Level 1',
      'MuleSoft Certified Integration Architect - Level 1',
      'Tableau Certified Data Analyst',
      'Tableau Desktop Specialist'
    ]
  }
];

const ALL_CERTIFICATIONS = CERTIFICATIONS.flatMap((g) => g.items);
const CERTIFICATION_SET = new Set(ALL_CERTIFICATIONS);

function isKnownCertification(name) {
  return CERTIFICATION_SET.has(name);
}

module.exports = { CERTIFICATIONS, ALL_CERTIFICATIONS, isKnownCertification };
