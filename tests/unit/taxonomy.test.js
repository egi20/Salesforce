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

describe('this is a Salesforce site, and the catalogues are the proof', () => {
  /*
   * The whole application is ported from a Dynamics 365 marketplace, so the failure mode
   * is not a hostile edit — it is a label that was never translated. Two survived the
   * original port: `smb-erp-isv` ("SMB / ERP ISV Consultant") and `hcm-isv`, which name
   * Business Central and a Dynamics HR partner and mean nothing in this ecosystem. What
   * gave them away was ROLE_ALIASES: they were two of the only three roles with no search
   * terms at all, because there was no real term to map onto them.
   *
   * So this scans every user-visible label in every catalogue that feeds a dropdown. It is
   * cheap and it is the only thing standing between a careless paste and a Salesforce site
   * offering somebody a Dynamics role.
   */
  const FOREIGN = [
    /\bmicrosoft\b/i, /\bdynamics\b/i, /\bd365\b/i, /\bnavision\b/i, /\baxapta\b/i,
    /\bbusiness central\b/i, /\bpower (apps|bi|automate|platform)\b/i, /\bazure\b/i,
    /\bdataverse\b/i, /\bcommon data service\b/i, /\bdual.?write\b/i, /\bx\+\+/i,
    /\bsap\b/i, /\bnetsuite\b/i, /\bhubspot\b/i, /\bzoho\b/i, /\bsugarcrm\b/i,
    // "SMB ERP" and "HCM" are the specific Dynamics-market phrases that got through.
    /\bsmb\b/i, /\bhcm\b/i, /\berp isv\b/i
  ];

  function labelsOf(source) {
    return source.filter(Boolean).map(String);
  }

  const catalogues = {
    roles: labelsOf(taxonomy.ALL_ROLES.map((r) => r.label)),
    roleCategories: labelsOf(taxonomy.ROLE_CATEGORIES.map((c) => c.category)),
    seniorities: labelsOf(taxonomy.SENIORITY_LEVELS.map((s) => s.label || s.value)),
    modules: labelsOf(clouds.ALL_MODULES.map((m) => m.label)),
    families: labelsOf(clouds.CLOUD_FAMILIES.map((f) => f.label)),
    // Plain strings, not objects — the `length > 0` guard above is what caught that, and
    // is why it is there: a catalogue read through the wrong key is an empty list, and an
    // empty list passes every "nothing forbidden here" assertion.
    certifications: labelsOf(require('../../config/certifications').ALL_CERTIFICATIONS.map((c) => (typeof c === 'string' ? c : c.label || c.name))),
    isvSolutions: labelsOf(Object.values(require('../../config/estimation').ISV_SOLUTIONS).map((i) => i.name))
  };

  for (const [name, labels] of Object.entries(catalogues)) {
    it(`${name}: no label names another vendor's product`, () => {
      expect(labels.length).toBeGreaterThan(0);
      const offenders = labels.filter((label) => FOREIGN.some((re) => re.test(label)));
      expect(offenders).toEqual([]);
    });
  }

  it('the two Dynamics-era role slugs are gone and do not validate', () => {
    for (const slug of ['smb-erp-isv', 'hcm-isv']) {
      expect(taxonomy.isValidRole(slug)).toBe(false);
      expect(taxonomy.BASE_DAY_RATES[slug]).toBeUndefined();
    }
  });

  it('every role carries at least one search alias', () => {
    // The absence of an alias is what exposed both stale roles: nobody could name a term
    // for a product that is not in this ecosystem. Keeping the invariant keeps the signal.
    const withoutAliases = taxonomy.ROLE_SLUGS.filter((slug) => {
      const aliases = taxonomy.ROLE_ALIASES[slug];
      return !Array.isArray(aliases) || aliases.length === 0;
    });
    expect(withoutAliases).toEqual([]);
  });

  it('no alias names another vendor either', () => {
    for (const [slug, aliases] of Object.entries(taxonomy.ROLE_ALIASES)) {
      for (const alias of aliases) {
        const hit = FOREIGN.find((re) => re.test(alias));
        expect(hit ? `${slug}: ${alias}` : null).toBeNull();
      }
    }
  });
});
