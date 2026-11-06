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

module.exports = { EU_COUNTRY_CODES };
