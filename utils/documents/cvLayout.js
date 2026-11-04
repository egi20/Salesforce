'use strict';

const { availabilityLabel } = require('../../config/availability');

/**
 * What goes on a CV, in order, as plain blocks — read by BOTH the .docx generator and the
 * on-page preview.
 *
 * The preview is only worth having if it is the document. Two renderers each deciding what
 * a CV contains would drift the first time somebody added a line to one of them, and the
 * consultant would download something other than what they approved. So the decisions —
 * which sections, in which order, which lines, what each says — are made HERE, once, and
 * both renderers only lay the blocks out: `cvDocx.js` as Word paragraphs, the view as HTML.
 *
 * Like the rest of the document generators this RENDERS the dossier and writes nothing of
 * its own: every string below is either something the consultant entered or a fixed label.
 *
 * Block kinds: name, headline, contact, heading, para, fact, line, bullet, entry, subtitle.
 */

/** The sections a consultant may leave out. Anything not listed here is always present. */
const OPTIONAL_SECTIONS = Object.freeze([
  { key: 'projects', label: 'Projects (delivery history)' },
  { key: 'experience', label: 'Employment' },
  { key: 'certifications', label: 'Certifications' },
  { key: 'trailhead', label: 'Trailhead' },
  { key: 'rate', label: 'Day rate' }
]);
const SECTION_KEYS = OPTIONAL_SECTIONS.map((s) => s.key);

/**
 * The starting selection. Everything is in except the rate, which follows the profile's own
 * "Show my rates" switch: a CV is forwarded to people the consultant never meets, and a
 * figure they chose to keep "on request" on the Hub must not leave on a document by default.
 */
function defaultOptions(dossier = {}) {
  return {
    projects: true,
    experience: true,
    certifications: true,
    trailhead: true,
    rate: Boolean(dossier.rateVisible)
  };
}

/**
 * Options from a query string. `opts=1` marks a form that was actually submitted: an
 * unticked checkbox posts nothing, so without the marker "every box unticked" and "nothing
 * chosen yet" would look identical and the defaults would silently come back.
 */
function optionsFrom(query = {}, dossier = {}) {
  if (query.opts !== '1') return defaultOptions(dossier);
  const raw = query.include;
  const chosen = new Set((Array.isArray(raw) ? raw : raw ? [raw] : []).map(String));
  const out = {};
  for (const key of SECTION_KEYS) out[key] = chosen.has(key);
  return out;
}

function trailheadLine(dossier) {
  const t = dossier.trailhead || {};
  const parts = [t.rank ? `${t.rank} rank` : null, t.badges ? `${t.badges} badges` : null].filter(Boolean);
  return parts.join(' · ');
}

/** Free text split on blank lines, exactly as typed. */
function paragraphs(value) {
  return String(value || '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((text) => ({ kind: 'para', text }));
}

function cvBlocks(dossier, options = defaultOptions(dossier)) {
  const blocks = [{ kind: 'name', text: dossier.name }];
  if (dossier.headline) blocks.push({ kind: 'headline', text: dossier.headline });

  const links = dossier.links || {};
  const contact = [dossier.email, dossier.location, links.linkedin, links.website, links.trailblazer].filter(Boolean);
  if (contact.length) blocks.push({ kind: 'contact', text: contact.join('  ·  ') });

  if (dossier.bio) blocks.push({ kind: 'heading', text: 'Profile' }, ...paragraphs(dossier.bio));

  // The things a client screening a contractor checks first, one line each.
  const facts = [];
  if (dossier.roleLabel) facts.push(['Role', dossier.seniority ? `${dossier.roleLabel} (${dossier.seniority})` : dossier.roleLabel]);
  if (dossier.yearsExperience) facts.push(['Experience', `${dossier.yearsExperience} years`]);
  if (dossier.workMode) facts.push(['Working', dossier.willingToTravel ? `${dossier.workMode}, willing to travel` : dossier.workMode]);
  if (dossier.availability && dossier.availability !== 'not_available') {
    const when = availabilityLabel(dossier.availability);
    facts.push(['Available', dossier.availableFrom ? `${when} (from ${dossier.availableFrom})` : when]);
  }
  if (options.rate && dossier.dayRate) facts.push(['Day rate', `${dossier.dayRate} ${dossier.currency}`]);
  if (options.rate && dossier.hourlyRate) facts.push(['Hourly rate', `${dossier.hourlyRate} ${dossier.currency}`]);
  if (facts.length) {
    blocks.push({ kind: 'heading', text: 'At a glance' }, ...facts.map(([label, value]) => ({ kind: 'fact', label, value })));
  }

  if (dossier.skills && dossier.skills.length) {
    // One wrapped line rather than a bulleted column: a parser reads it the same way and it
    // costs a tenth of the page.
    blocks.push({ kind: 'heading', text: 'Skills' }, { kind: 'line', text: dossier.skills.join('  ·  ') });
  }

  if (options.certifications && dossier.certifications && dossier.certifications.length) {
    blocks.push({ kind: 'heading', text: 'Certifications' });
    for (const cert of dossier.certifications) {
      const suffix = [cert.earned, cert.credentialId ? `ID ${cert.credentialId}` : null].filter(Boolean).join(' · ');
      // An expired certification is LABELLED rather than dropped: hiding it would conceal
      // from the consultant exactly the thing a client is about to check.
      blocks.push({ kind: 'bullet', text: `${cert.name}${suffix ? ` — ${suffix}` : ''}${cert.expired ? ' (expired)' : ''}` });
    }
  }

  const trailhead = trailheadLine(dossier);
  if (options.trailhead && trailhead) blocks.push({ kind: 'heading', text: 'Trailhead' }, { kind: 'line', text: trailhead });

  // Delivery history BEFORE employment: for a contractor the engagements are the substance.
  if (options.projects && dossier.projects && dossier.projects.length) {
    blocks.push({ kind: 'heading', text: 'Delivery history' });
    for (const project of dossier.projects) {
      blocks.push({ kind: 'entry', left: project.name, right: project.period });
      const subtitle = [project.client, project.cloud, project.role].filter(Boolean).join(' · ');
      if (subtitle) blocks.push({ kind: 'subtitle', text: subtitle });
      blocks.push(...paragraphs(project.description));
    }
  }

  if (options.experience && dossier.experience && dossier.experience.length) {
    blocks.push({ kind: 'heading', text: 'Employment' });
    for (const role of dossier.experience) {
      blocks.push({ kind: 'entry', left: role.title ? `${role.title} — ${role.company}` : role.company, right: role.period });
      blocks.push(...paragraphs(role.description));
    }
  }

  return blocks;
}

module.exports = { OPTIONAL_SECTIONS, SECTION_KEYS, defaultOptions, optionsFrom, cvBlocks };
