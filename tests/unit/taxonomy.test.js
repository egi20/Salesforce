'use strict';

const taxonomy = require('../../config/roleTaxonomy');
const clouds = require('../../config/cloudFamilies');

describe('role taxonomy integrity', () => {
  it('has no problems, so boot will not throw', () => {
    expect(taxonomy.taxonomyProblems()).toEqual([]);
    expect(() => taxonomy.assertTaxonomyIntegrity()).not.toThrow();
  });

  it('gives every role slug a base day rate', () => {
    // A missing slug used to fall back silently to a flat default, quietly flattening
    // whole rate buckets. It is now a boot failure instead.
    for (const slug of taxonomy.ROLE_SLUGS) {
      expect(typeof taxonomy.baseDayRate(slug)).toBe('number');
    }
  });

  it('gives every role slug a display label', () => {
    for (const slug of taxonomy.ROLE_SLUGS) {
      expect(taxonomy.roleLabel(slug)).not.toBe(slug);
    }
  });

  it('has unique, kebab-case slugs', () => {
    const seen = new Set();
    for (const slug of taxonomy.ROLE_SLUGS) {
      expect(seen.has(slug)).toBe(false);
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      seen.add(slug);
    }
  });

  it('only aliases slugs that exist', () => {
    for (const slug of Object.keys(taxonomy.ROLE_ALIASES)) {
      expect(taxonomy.isValidRole(slug)).toBe(true);
    }
  });

  it('rejects an unknown role', () => {
    expect(taxonomy.isValidRole('x++-developer')).toBe(false);
    expect(taxonomy.isValidRole('')).toBe(false);
  });
});

describe('cloud families', () => {
  it('has unique module slugs across every family', () => {
    const seen = new Set();
    for (const m of clouds.ALL_MODULES) {
      expect(seen.has(m.value)).toBe(false);
      seen.add(m.value);
    }
  });

  it('gives every module a positive base effort', () => {
    for (const m of clouds.ALL_MODULES) {
      expect(clouds.MODULE_BASE_EFFORTS[m.value]).toBeGreaterThan(0);
    }
  });

  it('validates module slugs', () => {
    expect(clouds.isValidModule('cpq')).toBe(true);
    expect(clouds.isValidModule('dual-write')).toBe(false);
  });
});
