'use strict';

/**
 * Country groups the profile's country picker offers as one click.
 *
 * The EU's 27 members as ISO 3166-1 alpha-2 codes. "Anywhere in EU" ticks exactly these,
 * so what is stored is the list a company filtering by country will match — not a label
 * that only this page knows how to read.
 */
const EU_COUNTRY_CODES = Object.freeze([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'
]);

if (EU_COUNTRY_CODES.length !== 27 || new Set(EU_COUNTRY_CODES).size !== 27) {
  throw new Error('config/regions.js: the EU list must hold 27 distinct codes');
}

/**
 * Where somebody asking about the Albania program is likely to live: the EU, the rest of
 * Europe, and the handful of other countries Salesforce contractors commonly work from. The
 * full ISO list has 249 entries, Antarctica and Bouvet Island among them, and a select that
 * long buries the forty that matter. Somebody elsewhere picks "Other" in the calculator, or
 * finds their country under "All other countries" on the enquiry form, which needs a code.
 */
const RESIDENCE_COUNTRY_CODES = Object.freeze([
  ...EU_COUNTRY_CODES,
  'GB', 'CH', 'NO', 'IS', 'LI', 'MC', 'AD', 'SM',
  'AL', 'MK', 'ME', 'RS', 'BA', 'MD', 'UA', 'TR', 'GE',
  'US', 'CA', 'AU', 'NZ', 'AE', 'IL', 'IN', 'SG', 'ZA', 'BR', 'MX'
]);

/** Territories with no resident population to speak of: never a tax residence. */
const UNINHABITED = new Set(['AQ', 'BV', 'HM', 'TF', 'UM', 'GS', 'IO', 'CX', 'CC', 'NF', 'PN', 'SJ', 'EH']);

/**
 * The country select in three groups: `top` (where most consultants on the Hub are, measured,
 * in that order), `relevant` (the list above, alphabetical, minus anything already in `top`)
 * and `rest` (every other inhabited country, for a form that needs a real code).
 */
function countryGroups(countries, topCodes = []) {
  const byCode = new Map(countries.map((c) => [c.code, c]));
  const top = topCodes.filter((code) => byCode.has(code)).map((code) => byCode.get(code));
  const taken = new Set(top.map((c) => c.code));
  const relevantCodes = new Set(RESIDENCE_COUNTRY_CODES);
  const byName = (a, b) => a.name.localeCompare(b.name, 'en');
  const relevant = countries.filter((c) => relevantCodes.has(c.code) && !taken.has(c.code)).sort(byName);
  const rest = countries
    .filter((c) => !relevantCodes.has(c.code) && !taken.has(c.code) && !UNINHABITED.has(c.code))
    .sort(byName);
  return { top, relevant, rest };
}

module.exports = { EU_COUNTRY_CODES, RESIDENCE_COUNTRY_CODES, countryGroups };
