'use strict';

const { cloudGroups } = require('./cloudFamilies');

/**
 * What the SOW pack pages say about the pack, in ONE place. /quotes/new is the page that
 * introduces it (how it works, the clouds, what the SOW contains) and the form; the
 * document-generator page shows only what is its own — the three files, why they agree, a
 * sample timeline. Two pages carrying the same three sections was two places to disagree.
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
 * The three files, one card each on /services/document-generator. Every card lists what is IN
 * its file rather than counting it — a count with no list behind it ("seven slides") is a claim
 * a reader cannot check. A test reads the SOW's numbered headings, the workbook's sheet names
 * and the deck's slide titles from the generators and fails if a card stops naming one.
 */
const PACK_CARDS = Object.freeze([
  {
    title: 'Statement of work',
    ext: '.docx',
    icon: 'bi-file-earmark-word',
    intro: 'Numbered sections, ready to edit in Word:',
    items: [
      'Scope, add-ons and integrations',
      'Approach, timeline and acceptance criteria',
      'Team and commercials, and how the effort was derived',
      'Assumptions, exclusions, your terms and validity'
    ]
  },
  {
    title: 'Work breakdown + Gantt',
    ext: '.xlsx',
    icon: 'bi-file-earmark-spreadsheet',
    intro: 'One sheet each:',
    items: ['Summary of effort, duration and budget', 'WBS with a week-by-week Gantt', 'Scope by cloud and module', 'Team & cost, line by line']
  },
  {
    title: 'Summary deck',
    ext: '.pptx',
    icon: 'bi-file-earmark-slides',
    intro: 'One slide each:',
    items: ['Title', 'At a glance', 'Scope', 'Approach', 'Timeline', 'Team and commercials', 'Assumptions and next steps']
  }
]);

/** "How it works" — the four steps of the estimate form, in its own order. */
const HOW_IT_WORKS = Object.freeze([
  { title: 'Client information', text: 'Enter client details, industry and company size' },
  { title: 'Scope', text: 'Pick Salesforce clouds, modules, add-ons and integrations' },
  { title: 'Review estimate', text: 'Check man-days, phases, team, budget and timeline' },
  { title: 'Download the pack', text: 'SOW (.docx), work breakdown + Gantt (.xlsx) and deck (.pptx)' }
]);

/** Everything the SOW partials on /quotes/new read (views/partials/sow/). */
function sowPageLocals() {
  return { howItWorks: HOW_IT_WORKS, sowSections: SOW_SECTIONS, cloudGroups: cloudGroups() };
}

module.exports = { SOW_SECTIONS, PACK_CARDS, HOW_IT_WORKS, sowPageLocals };
