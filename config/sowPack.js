'use strict';

const { cloudGroups } = require('./cloudFamilies');

/**
 * What the SOW pack pages say about the pack — in ONE place, read by both /quotes/new and
 * /services/document-generator, so the two pages cannot describe the same download
 * differently.
 *
 * Every line under SOW_SECTIONS names the heading in utils/documents/sowDocx.js that produces
 * it, and a test asserts each heading is really there. "Acceptance criteria" is listed because
 * section 2.2 writes it; it was added to the document before it was added here. Optional
 * sections say when they appear. A line copied from somebody else's product page would be a
 * promise the download does not keep.
 */
const SOW_SECTIONS = Object.freeze([
  { label: 'Cover page', heading: 'Prepared for' },
  { label: 'Summary of effort, duration and budget', heading: "'Summary'" },
  { label: 'Scope by cloud and module', heading: '1. Scope' },
  { label: 'AppExchange add-ons', heading: '1.1 Add-on products' },
  { label: 'Integrations', heading: '1.2 Integrations' },
  { label: 'Delivery approach by phase', heading: '2. Approach' },
  { label: 'Timeline and milestones', heading: '2.1 Timeline' },
  { label: 'Acceptance criteria for each phase', heading: '2.2 Acceptance criteria' },
  { label: 'Team and commercials', heading: '3. Team and commercials' },
  { label: 'How the effort was derived', heading: '3.1 How the effort was derived' },
  { label: 'Assumptions', heading: '4. Assumptions' },
  { label: 'Exclusions', heading: '5. Exclusions' },
  { label: 'Validity', heading: '. Validity' },
  { label: 'Your standard terms', note: 'when set', heading: '6. Terms', optional: true },
  { label: 'Executive summary and risks', note: 'when added', heading: "'Executive summary'", optional: true }
]);

/*
 * The other two files, named by what is IN them rather than by a count: a count with no list
 * behind it ("seven slides") is a claim a reader cannot check. A test reads the sheet names and
 * slide titles from the generators and fails if one stops being named here.
 */
const PACK_FILES = Object.freeze([
  { label: 'Work breakdown + Gantt', note: '.xlsx: summary, WBS with a weekly Gantt, scope, team and cost' },
  { label: 'Summary deck', note: '.pptx: title, at a glance, scope, approach, timeline, team and commercials, assumptions and next steps' },
  { label: 'Your branding', note: 'colours, letterhead and standard clauses' },
  { label: 'Figures that reconcile', note: 'all three read the same stored estimate' }
]);

/** "How it works" — the four steps of the estimate form, in its own order. */
const HOW_IT_WORKS = Object.freeze([
  { title: 'Client information', text: 'Enter client details, industry and company size' },
  { title: 'Scope', text: 'Pick Salesforce clouds, modules, add-ons and integrations' },
  { title: 'Review estimate', text: 'Check man-days, phases, team, budget and timeline' },
  { title: 'Download the pack', text: 'SOW (.docx), work breakdown + Gantt (.xlsx) and deck (.pptx)' }
]);

/** Everything the shared SOW partials read (views/partials/sow/). */
function sowPageLocals() {
  return { howItWorks: HOW_IT_WORKS, sowSections: SOW_SECTIONS, packFiles: PACK_FILES, cloudGroups: cloudGroups() };
}

module.exports = { SOW_SECTIONS, PACK_FILES, HOW_IT_WORKS, sowPageLocals };
