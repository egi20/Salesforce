'use strict';

const fs = require('fs');
const path = require('path');
const SiteReview = require('../../models/SiteReview');

const src = fs.readFileSync(path.join(__dirname, '../../routes/index.js'), 'utf8');
const hub = src.slice(src.indexOf("'/companies-hub'"), src.indexOf("router.get('/about'"));

describe('the Companies Hub promises only what the Hub does', () => {
  it('names no service level the platform does not run', () => {
    // Comments are stripped: the code explains why these are absent, and may name them doing so.
    const code = hub.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/24\/7|\bSLA\b|guarantee|monthly report/i);
  });
  it('speaks to companies about privacy, not to consultants about their profile', () => {
    expect(hub).toMatch(/COMPANY_PRIVACY_BENEFIT/);
    expect(src).toMatch(/Applicants and estimates stay in your account/);
  });
  it('builds its social proof from rows, never from literals', () => {
    expect(hub).toMatch(/SiteReview\.list\(\{ author_roles: \['company', 'recruiter'\] \}/);
    expect(hub).toMatch(/HIRING_LOGOS_MIN/);
  });
});

describe('reviews by author role go through the one builder', () => {
  it('adds a parameterised IN clause and ignores unknown roles', () => {
    const { clause, params } = SiteReview.buildFilter({ author_roles: ['company', 'recruiter', 'admin'] });
    expect(clause).toMatch(/r\.author_role IN \(\?, \?\)/);
    expect(params).toEqual(['company', 'recruiter']);
    expect(clause).toMatch(/r\.approved_at IS NOT NULL/);
  });
});
