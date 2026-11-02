'use strict';

/**
 * The colours the admin charts draw with, in ONE place.
 *
 * The charts are server-drawn inline SVG (no chart library: the CSP allows no CDN), and
 * their colours are SVG presentation ATTRIBUTES rather than classes. That is deliberate and
 * was learned on SAP Hub: an SVG shape with no fill paints black, so a chart whose colours
 * lived in a stylesheet the browser had cached at an older version drew a black square.
 * Attributes carry their own colour wherever the markup goes.
 *
 * DESIGN.md says never to inline a brand colour in a view, and this module is how that
 * rule holds: the views read colours from here, never type a hex. The values are this
 * site's own tokens from `public/css/style.css`, kept in step by hand exactly as
 * `utils/documents/brand.js` is — if a token changes there, change it here too.
 */
const SERIES = Object.freeze([
  '#0176d3', // --primary-blue
  '#032d60', // --primary-navy
  '#c97a00', // --grad-amber's first stop
  '#1d6f4f' // --grad-success's first stop
]);

// The navy-and-blue ramp, not a rainbow: a country ring is one quantity, not seven.
const DONUT = Object.freeze(['#032d60', '#0176d3', '#0b5cab', '#6fd3ff', '#00a1e0', '#5b6abf', '#5a6673']);
const DONUT_OTHER = '#c8d1dc';

const GRID = '#e2e8f0';
const AXIS_TEXT = '#5a6673'; // --text-light, 5.9:1 on white
const POINT_FILL = '#ffffff';

module.exports = { SERIES, DONUT, DONUT_OTHER, GRID, AXIS_TEXT, POINT_FILL };
