'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const NAV = fs.readFileSync(path.join(ROOT, 'views', 'partials', 'navigation.ejs'), 'utf8');

/*
 * WHY THIS FILE EXISTS.
 *
 * Three header defects were reported as one — "Sign in" on two lines, an icon with no
 * image, and the plain links standing taller than the dropdowns beside them. None of them
 * is visible to a unit test that renders a template, because all three are layout, and the
 * first fix for the padding was silently ignored for a week: Bootstrap sets it with
 * `.navbar-expand-xl .navbar-nav .nav-link`, three classes, so the two-class rule written
 * here lost the cascade and nothing said so.
 *
 * These assertions pin the parts of the arrangement that a later edit would undo without
 * noticing. They are deliberately about the SHAPE of the rules, not about pixels — a
 * measurement belongs in a browser, and the browser run is what found each of these.
 */
describe('navbar layout', () => {
  test('the nav-link rule out-specifies the Bootstrap rule that sets its padding', () => {
    // Bootstrap: `.navbar-expand-xl .navbar-nav .nav-link { padding-left/right }` — three
    // classes. A `.navbar-hub .nav-link` rule is two and loses, so the padding written here
    // would never apply and the bar would overflow at its own breakpoint.
    expect(CSS).toMatch(/\.navbar-hub \.navbar-nav \.nav-link \{/);
    expect(CSS).not.toMatch(/\.navbar-hub \.nav-link \{/);
  });

  test('a nav link keeps its icon and its label on one line', () => {
    // A dropdown toggle gets `display: flex` from Bootstrap and a plain link does not, so
    // Home and About wrapped their icon above their text and stood 62px tall beside 38px
    // neighbours. The rule below is what makes every item the same height.
    const rule = CSS.match(/\.navbar-hub \.navbar-nav \.nav-link \{[^}]*\}/)[0];
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/align-items:\s*center/);
    expect(rule).toMatch(/white-space:\s*nowrap/);
  });

  test('the search field is not painted for a dark bar', () => {
    // It was `color: #fff` on a translucent white background over a white navbar: an
    // invisible value, an invisible placeholder, and a control reported as "an empty icon".
    // The field now lives in a white panel under the search toggle, so its own white
    // background is fine — what must never come back is white TEXT.
    const rule = CSS.match(/\.nav-search-panel \.form-control \{[^}]*\}/)[0];
    expect(rule).not.toMatch(/(^|[^-])color:\s*(#fff|#ffffff|rgba\(255,\s*255,\s*255)/i);
    expect(rule).toMatch(/color:\s*var\(--text-dark\)/);
  });

  test('the search panel is out of flow, so opening it moves nothing', () => {
    // Expanding a field in flow only moved the overflow from the resting state to the
    // focused one — the open field pushed "Sign up" off the right edge. The toggle is all
    // the bar ever holds; the panel opens beneath it, absolutely positioned.
    expect(CSS).toMatch(/\.nav-search \{ position: relative; \}/);
    expect(CSS).toMatch(/\.nav-search-panel \{[^}]*position:\s*absolute/);
    expect(NAV).toMatch(/<details class="nav-search/);
  });

  test('the search panel is opaque, like every other menu', () => {
    const rule = CSS.match(/\.nav-search-panel \{[^}]*\}/)[0];
    expect(rule).toMatch(/background:\s*#fff\s*;/);
    expect(rule).not.toMatch(/--glass-bg|backdrop-filter/);
  });

  test('an open dropdown is opaque', () => {
    // It was `--glass-bg-heavy` (white at 85%) with a blur, and over the home hero the h1
    // read straight through the panel and across the item labels. A menu opens over
    // whatever the page happens to be, so the only background that works everywhere is one
    // that lets nothing through — the same reason `.sf-assistant-panel` is `#fff`.
    const rule = CSS.match(/\.navbar-hub \.dropdown-menu \{[^}]*\}/)[0];
    expect(rule).toMatch(/background:\s*#fff\s*;/);
    expect(rule).not.toMatch(/rgba|--glass-bg|backdrop-filter/);
    // Translucency was doing the separating. The border and the shadow have to now.
    expect(rule).toMatch(/border:\s*1px solid/);
    expect(rule).toMatch(/box-shadow:/);
  });

  test('the auth links are a matched pair that cannot wrap', () => {
    expect(NAV).toMatch(/btn btn-outline-primary btn-sm btn-auth/);
    expect(NAV).toMatch(/btn btn-primary btn-sm btn-auth/);
    expect(CSS).toMatch(/\.navbar-hub \.btn-auth \{[^}]*white-space:\s*nowrap/);
  });

  test('the account name is clipped, never removed, when the bar is tight', () => {
    // `display: none` would leave the dropdown toggle with an empty-alt avatar and no
    // accessible name at all.
    const band = CSS.match(/@media \(min-width: 1200px\) and \(max-width: 1399\.98px\) \{[\s\S]*?\n\}/)[0];
    expect(band).toMatch(/\.nav-user-name \{/);
    expect(band).not.toMatch(/\.nav-user-name \{[^}]*display:\s*none/);
    expect(band).toMatch(/clip:\s*rect\(0, 0, 0, 0\)/);
    expect(NAV).toMatch(/class="nav-user-name"/);
  });

  test('the menu expands at the width the media queries are written for', () => {
    // `navbar-expand-lg` with rules written at 1200px is two breakpoints disagreeing, and
    // the disagreement is a band where the bar is expanded and none of its sizing applies.
    expect(NAV).toMatch(/navbar navbar-expand-xl navbar-hub/);
    expect(CSS).toMatch(/@media \(max-width: 1199\.98px\)/);
  });
});
