'use strict';

/**
 * The people behind Salesforce Hub, as shown on /about. Same operator and same team as
 * Dynamics Hub — Salesforce Hub is its sister platform.
 *
 * NOTHING HERE IS PUBLISHED UNTIL ITS PERSON HAS APPROVED IT. A biography is a statement made
 * in somebody's name; these were adapted from Dynamics Hub's for this site, so each carries
 * `approved: false` until that person has read it. An unapproved bio is shown in development
 * with a "Draft" label and left out in production, where the card shows the name and the role
 * only — the same rule `config/tax-program.json` follows: what nobody confirmed stays hidden.
 *
 * `linkedin` and `photo` are null until somebody supplies the real ones. A photo is a file
 * served from this origin (`/images/team/...`) — the CSP allows no other host — and a card
 * without one shows initials, never a stock face.
 */
const TEAM = Object.freeze([
  Object.freeze({
    name: 'Joni Pjetri',
    role: 'Founder & CEO',
    bio: 'A Dynamics 365 Solution Architect who spent years delivering programmes in Western Europe, then completed an MBA at Oxford’s Saïd Business School. He relocated to Albania, founded Dynamics Hub, and now Salesforce Hub as its sister platform for the Salesforce ecosystem.',
    approved: false,
    linkedin: null,
    photo: null
  }),
  Object.freeze({
    name: 'Malda Shushku',
    role: 'Commercial Director',
    bio: 'Leads the commercial side of Dynamics Hub and Salesforce Hub: the companies that hire through the platforms and the partnerships behind them.',
    approved: false,
    linkedin: null,
    photo: null
  })
]);

const LINKEDIN = /^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?$/;
const PHOTO = /^\/images\/team\/[a-z0-9-]+\.(webp|jpg|jpeg|png)$/;

/** The team as one environment should show it: bios only where approved, unless in development. */
function teamFor({ isProduction }) {
  return TEAM.map((m) => ({
    name: m.name,
    role: m.role,
    bio: m.approved || !isProduction ? m.bio : null,
    draft: !m.approved,
    linkedin: m.linkedin,
    photo: m.photo,
    initials: m.name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase()
  }));
}

/** Asserted at boot: a malformed link or a photo from another host fails here, not on the page. */
function assertTeam() {
  for (const m of TEAM) {
    if (!m.name || !m.role || !m.bio) throw new Error(`Team: ${m.name || 'an entry'} needs a name, a role and a bio`);
    if (typeof m.approved !== 'boolean') throw new Error(`Team: ${m.name} must say whether the bio is approved`);
    if (m.linkedin !== null && !LINKEDIN.test(m.linkedin)) throw new Error(`Team: ${m.name} has a LinkedIn link that is not a linkedin.com/in/ profile`);
    if (m.photo !== null && !PHOTO.test(m.photo)) throw new Error(`Team: ${m.name}'s photo must be served from /images/team/`);
  }
  return true;
}

module.exports = { TEAM, teamFor, assertTeam };
