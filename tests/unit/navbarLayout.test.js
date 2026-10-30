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
 * `.navbar-expand-lg .navbar-nav .nav-link`, three classes, so the two-class rule written
 * here lost the cascade and nothing said so.
 *
 * These assertions pin the parts of the arrangement that a later edit would undo without
 * noticing. They are deliberately about the SHAPE of the rules, not about pixels — a
 * measurement belongs in a browser, and the browser run is what found each of these.
 */
describe('navbar layout', () => {
  test('the nav-link rule out-specifies the Bootstrap rule that sets its padding', () => {
    // Bootstrap: `.navbar-expand-lg .navbar-nav .nav-link { padding-left/right }` — three
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
    const rule = CSS.match(/\.nav-search \.form-control \{[^}]*\}/)[0];
    expect(rule).not.toMatch(/#fff|#ffffff|rgba\(255,\s*255,\s*255/i);
    expect(rule).toMatch(/color:\s*var\(--text-dark\)/);
  });

  test('the expanded search is out of flow, so opening it moves nothing', () => {
    // Expanding it in flow only moved the overflow from the resting state to the focused
    // one — the open field pushed "Sign up" off the right edge.
    const wide = CSS.match(/@media \(min-width: 992px\) \{\n {2}\/\*\n {3}\* The open field[\s\S]*?\n\}/)[0];
    expect(wide).toMatch(/\.nav-search \{ position: relative; \}/);
    expect(wide).toMatch(/position:\s*absolute/);
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
    const band = CSS.match(/@media \(min-width: 992px\) and \(max-width: 1399\.98px\) \{[\s\S]*?\n\}/)[0];
    expect(band).toMatch(/\.nav-user-name \{/);
    expect(band).not.toMatch(/\.nav-user-name \{[^}]*display:\s*none/);
    expect(band).toMatch(/clip:\s*rect\(0, 0, 0, 0\)/);
    expect(NAV).toMatch(/class="nav-user-name"/);
  });

  test('the menu expands at the width the media queries are written for', () => {
    // `navbar-expand-lg` with rules written at 1200px is two breakpoints disagreeing, and
    // the disagreement is a band where the bar is expanded and none of its sizing applies.
    // It expands at 992px, as SAP Hub's does; at `xl` everything from 992 to 1199px got only
    // the hamburger. Every width rule for the bar has to move with it.
    expect(NAV).toMatch(/navbar navbar-expand-lg navbar-hub/);
    expect(CSS).toMatch(/@media \(max-width: 991\.98px\) \{\n {2}\/\* Collapsed, each item/);
    expect(CSS).not.toMatch(/navbar-expand-xl/);
    expect(NAV).not.toMatch(/navbar-expand-xl/);
  });

  test('the 960px container has its own band, and it hides nothing', () => {
    // Measured in a browser at 992px before this band existed, "Sign Up" hung 41px off the
    // right edge — the overflow the 1200px band was written for, one container size down.
    // The fix trims size and padding; dropping a label or an icon would be a different menu
    // at every width, and a hidden item is one somebody cannot find.
    const band = CSS.match(/@media \(min-width: 992px\) and \(max-width: 1199\.98px\) \{[\s\S]*?\n\}/)[0];
    expect(band).toMatch(/\.navbar-hub \.navbar-nav \.nav-link \{/);
    expect(band).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });
});
