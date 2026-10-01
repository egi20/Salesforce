'use strict';

const fs = require('fs');
const path = require('path');

const { PUBLIC_ROLES } = require('../../models/User');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('the sign-up form', () => {
  const view = read('views/auth/register.ejs');
  const css = read('public/css/style.css');
  const js = read('public/js/main.js');

  it('offers exactly the roles a person may give themselves', () => {
    /*
     * THE SECURITY POINT, not a presentation one. The reference's `user_types[]` POST was a
     * real privilege escalation rather than a missing checkbox, and a card for a withheld
     * role here would be that escalation with a nicer target. The list on the form and the
     * list the server accepts are asserted to be the SAME list, so neither can drift.
     */
    const offered = [...view.matchAll(/value:\s*'([a-z]+)'/g)].map((m) => m[1]);
    expect(offered.sort()).toEqual([...PUBLIC_ROLES].sort());
    expect(offered).not.toContain('admin');
  });

  it('the cards are real checkboxes, not something JavaScript interprets', () => {
    // With scripting off the first question on the form still has to work.
    expect(view).toMatch(/type="checkbox"\s+name="user_types"/);
    expect(view).toMatch(/class="role-card-input"/);
    // The label is tied to the input by `for`, so a click and a space bar both work.
    expect(view).toMatch(/<label class="role-card-face" for="t-<%= r\.value %>">/);
  });

  it('hides the input without removing it from the keyboard', () => {
    /*
     * `display: none` or `visibility: hidden` would drop the control out of the tab order and
     * out of the accessibility tree — the card would be unusable by keyboard and invisible to
     * a screen reader, while looking perfectly fine. `opacity: 0` keeps both.
     */
    const rule = css.slice(css.indexOf('.role-card-input {'), css.indexOf('.role-card-face {'));
    expect(rule).toMatch(/opacity:\s*0/);
    expect(rule).not.toMatch(/display:\s*none/);
    expect(rule).not.toMatch(/visibility:\s*hidden/);
    // And the focus ring is driven from the hidden input onto the visible face, or a keyboard
    // user tabbing through sees nothing move.
    expect(css).toMatch(/\.role-card-input:focus-visible \+ \.role-card-face/);
  });

  it('does not signal the answer with colour alone', () => {
    // Somebody who cannot separate the tinted card from the plain one still has to see which
    // ones are selected.
    expect(css).toMatch(/\.role-card-input:checked \+ \.role-card-face::after/);
  });

  it('the password toggle is built by script, so there is no dead button without one', () => {
    /*
     * Written into the markup it would be a control that does nothing with scripting off.
     * Built here, it simply does not exist then, and the field is an ordinary password field —
     * which is the correct behaviour, and the rule the rest of public/js/main.js follows.
     */
    expect(view).not.toMatch(/class="password-toggle"/);
    expect(js).toMatch(/data-toggle-visibility/);
    expect(js).toMatch(/createElement\('button'\)/);
    // Explicitly type="button": inside a form an unspecified type SUBMITS it, so pressing
    // this would sign somebody up rather than show them what they typed.
    const toggle = js.slice(js.indexOf('data-toggle-visibility'), js.indexOf('Ending an experience'));
    expect(toggle).toMatch(/button\.type = 'button'/);
    // And it has to say what it does, since its face is an icon.
    expect(toggle).toMatch(/aria-label/);
  });

  it('keeps the selection when a submit is rejected', () => {
    // A validation error that silently resets the first question is how somebody ends up with
    // an account that holds a role they did not pick.
    expect(view).toMatch(/chosen\.includes\(r\.value\)/);
  });
});
