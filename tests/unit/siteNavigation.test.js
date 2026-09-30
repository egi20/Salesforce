'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const NAV = fs.readFileSync(path.join(ROOT, 'views', 'partials', 'navigation.ejs'), 'utf8');
const FOOTER = fs.readFileSync(path.join(ROOT, 'views', 'partials', 'footer.ejs'), 'utf8');
const { PUBLIC_PATHS, PAGE_META } = require('../../config/seoMeta');

/*
 * WHY THIS FILE EXISTS.
 *
 * The footer used to group by intent — "Find work", "Hire", "About" — while the menu two
 * screens above grouped by hub. One site, two taxonomies: a page sat under one name at the
 * top and another at the bottom, so somebody who could not find it in the menu could not
 * find it in the footer either, because they were looking for the name they had already
 * failed to find.
 *
 * These assertions hold the two together. They are about NAMES and REACHABILITY, which is
 * what drifts; nothing here asserts a layout.
 */
describe('site navigation', () => {
  /*
   * The footer's links are DATA, not markup: one `[path, label]` pair per entry, rendered in
   * a loop. So the paths are read out of the array rather than out of `href=` attributes,
   * of which the template has exactly one.
   */
  const footerPaths = [...FOOTER.matchAll(/\['(\/[^']*)',\s*'/g)].map((m) => m[1]);

  test('the footer carries a column for every menu group, under the same name', () => {
    for (const group of ['Consultant Hub', 'Companies Hub', 'Services', 'Community']) {
      expect(NAV).toContain(group);
      expect(FOOTER).toContain(`['${group}', [`);
    }
  });

  test('the footer does not reintroduce the old intent-based names', () => {
    // Either taxonomy is defensible. Having both is what is not.
    expect(FOOTER).not.toMatch(/<h3>Find work<\/h3>|\['Find work', \[/);
    expect(FOOTER).not.toMatch(/\['Hire', \[/);
  });

  test('/contact is reachable from the footer', () => {
    // The privacy policy promised "ask us and your data is removed" while /contact was
    // 404 and linked from nowhere. It exists now; a page nothing links to is still gone.
    expect(footerPaths).toContain('/contact');
  });

  test('About in the menu points at /about, not at the FAQ', () => {
    expect(NAV).toMatch(/href="\/about"[^>]*>(\s|<[^>]*>)*About/);
    expect(footerPaths).toEqual(expect.arrayContaining(['/about', '/faq']));
  });

  test('/about is indexable and has its own meta', () => {
    expect(PUBLIC_PATHS).toContain('/about');
    expect(PAGE_META['/about']).toBeDefined();
    expect(PAGE_META['/about'].description.length).toBeGreaterThan(50);
  });

  test('the footer links nothing a signed-out visitor cannot open', () => {
    // `/challenges` answers 401 to a visitor, so it is inside the `currentUser` branch.
    // A footer link whose only outcome is a login page is a dead link wearing a name.
    const signedOutBlock = FOOTER.replace(/\.\.\.\(currentUser \? \[[\s\S]*?\] : \[\]\)/g, '');
    expect(signedOutBlock).not.toContain('/challenges');
    expect(FOOTER).toContain('/challenges');
  });

  test('the trademark disclaimer stays in the last row', () => {
    // It is what makes an independent marketplace using the word "Salesforce" defensible.
    expect(FOOTER).toMatch(/Not affiliated with Salesforce, Inc\./);
  });
});
