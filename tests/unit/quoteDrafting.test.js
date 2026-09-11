'use strict';

const drafting = require('../../utils/quoteDrafting');
const { numbersIn } = require('../../utils/draftVerification');
const { SECTIONS } = require('../../config/drafting');
const { calculateEstimation } = require('../../utils/sowEstimation');

/**
 * What the model is told, and what it is NOT told.
 *
 * Rule 1 of the prompt is "never write a numeral". These tests check the thing that makes
 * that rule enforceable rather than merely requested: the facts handed to the model
 * contain no day count, no cost, no rate and no week number, so it cannot repeat one. A
 * prompt that asks for restraint while supplying the temptation is a prompt that will
 * eventually be ignored.
 */
const ESTIMATE = calculateEstimation({
  modules: ['lead-management', 'opportunity-management', 'b2b-commerce'],
  complexity: 'complex',
  customization: 'heavy',
  industry: 'Technology',
  companySize: 'Large (501-5000)',
  isvSolutions: [],
  includeTraining: true,
  includeHypercare: true
});

const QUOTE = {
  id: 1,
  reference: 'Q-TEST',
  client_company: 'BigCo',
  client_name: 'A Person',
  client_industry: 'Technology',
  company_size: 'Large (501-5000)',
  project_name: 'Commerce rollout',
  project_summary: 'Replace three spreadsheets with one pipeline.',
  catalogue_version: 'abc123',
  inputs: {
    modules: ['lead-management', 'opportunity-management', 'b2b-commerce'],
    isvSolutions: [],
    complexity: 'complex',
    customization: 'heavy',
    includeTraining: true,
    includeHypercare: true
  },
  estimate: ESTIMATE
};

describe('the facts given to the model', () => {
  const facts = drafting.factsFor(QUOTE);

  it('carries no effort, cost, rate or duration figure', () => {
    // The central property. Every commercially meaningful figure is absent from the
    // prompt, so "never write a numeral" is something the prompt SUPPORTS rather than
    // merely asks for.
    const given = new Set(numbersIn(facts));
    for (const figure of [
      ESTIMATE.totalManDays,
      ESTIMATE.totalBudget,
      ESTIMATE.averageDailyRate,
      ESTIMATE.projectDurationWeeks,
      ESTIMATE.contingencyDays,
      ESTIMATE.implementationBudget,
      ESTIMATE.supportBudget
    ]) {
      expect(given.has(figure)).toBe(false);
    }
    for (const resource of ESTIMATE.resourceAllocation) {
      expect(given.has(resource.dailyRate)).toBe(false);
      expect(given.has(resource.totalCost)).toBe(false);
    }
  });

  it('hands over ONLY numerals that came from a name, never from a figure', () => {
    /*
     * The precise version of the rule above, and the one worth stating: a phase day count
     * can coincidentally equal a numeral in a product name ("Bulk API 2.0" against a
     * two-day phase), so asserting "no phase day appears" would fail on a collision that
     * is not a leak. What actually matters is provenance — every numeral the model sees
     * traces back to a label or a description it was given, not to a computed figure.
     *
     * The two real examples in this catalogue are "Bulk API 2.0" and "Apex tests to the
     * 75% deploy gate": platform facts, not commercial terms.
     */
    const fromNames = new Set(
      numbersIn(
        [
          ...ESTIMATE.phaseBreakdown.map((p) => `${p.name} ${p.description}`),
          ...ESTIMATE.resourceAllocation.map((r) => r.name),
          ...(QUOTE.inputs.modules || []),
          QUOTE.project_summary,
          QUOTE.project_name,
          QUOTE.client_company,
          'B2B Commerce'
        ].join(' ')
      )
    );

    for (const value of numbersIn(facts)) {
      expect(fromNames.has(value)).toBe(true);
    }
  });

  it('turns the client-size band into a phrase, so its digits are not handed over', () => {
    // "Large (501-5000)" would put 501 and 5000 in front of a model told to write no
    // numerals. The sense is worth keeping; the range is not.
    expect(facts).toMatch(/a large organisation/);
    expect(facts).not.toMatch(/501/);
    expect(facts).not.toMatch(/5000/);
  });

  it('names modules by their label rather than their slug', () => {
    expect(facts).toMatch(/B2B Commerce/);
    expect(facts).not.toMatch(/b2b-commerce/);
  });

  it('states what is out of scope as well as what is in', () => {
    // "Training is NOT in scope" is a fact the narrative needs; leaving it out invites the
    // model to assume it is included.
    const withoutExtras = drafting.factsFor({
      ...QUOTE,
      inputs: { ...QUOTE.inputs, includeTraining: false, includeHypercare: false }
    });
    expect(withoutExtras).toMatch(/Training is NOT in scope/);
    expect(withoutExtras).toMatch(/Hypercare is NOT in scope/);
  });

  it('survives a quote with almost nothing filled in', () => {
    const bare = drafting.factsFor({ project_name: 'P', inputs: {}, estimate: {} });
    expect(typeof bare).toBe('string');
    expect(bare).toMatch(/Project: P/);
  });
});

describe('the prompt', () => {
  it('leads with the numeral rule', () => {
    // Order matters in a list of rules a model is asked to follow.
    expect(drafting.ROLE).toMatch(/^[\s\S]{0,800}NEVER WRITE A NUMERAL/);
  });

  it('forbids commitments and invented facts', () => {
    expect(drafting.ROLE).toMatch(/NEVER MAKE A COMMITMENT/);
    expect(drafting.ROLE).toMatch(/NEVER INVENT A FACT/);
    expect(drafting.ROLE).toMatch(/Leave no placeholder/);
  });

  it('tells the model its drafts are checked', () => {
    // Stating the consequence is part of the instruction, not decoration.
    expect(drafting.ROLE).toMatch(/rejected automatically/);
  });

  it('is byte-identical between calls, so the prompt cache can hit', () => {
    expect(drafting.ROLE).toBe(drafting.ROLE);
    expect(drafting.ROLE).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('states each section\'s boundary in its own instruction', () => {
    for (const section of Object.values(SECTIONS)) {
      const instruction = drafting.instructionFor(section);
      expect(instruction).toMatch(/must NOT include/);
      expect(instruction).toMatch(new RegExp(section.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      expect(instruction).toMatch(/Return the section body only/);
    }
  });
});

describe('with no API key configured', () => {
  it('is switched off', () => {
    expect(drafting.isConfigured()).toBe(false);
  });

  it('refuses rather than throwing, so the page still renders', async () => {
    await expect(drafting.draftSection(QUOTE, 'executive_summary')).resolves.toEqual({
      ok: false,
      reason: 'not configured'
    });
  });

  it('refuses an unknown section before anything else happens', async () => {
    await expect(drafting.draftSection(QUOTE, 'pricing')).resolves.toEqual({
      ok: false,
      reason: 'unknown section'
    });
  });
});
