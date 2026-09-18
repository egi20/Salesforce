'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'views');
const PUBLIC = path.join(ROOT, 'public');

function walk(dir, ext) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, ext);
    return full.endsWith(ext) ? [full] : [];
  });
}

const viewFiles = walk(VIEWS, '.ejs');

describe('brand assets', () => {
  /*
   * WHY THIS FILE EXISTS.
   *
   * The site's own footer, its FAQ and its terms all say it is NOT affiliated with
   * Salesforce, Inc. That sentence is what makes an independent marketplace using the word
   * "Salesforce" in its name defensible, and it is contradicted the instant a Salesforce
   * logo appears in the header or the browser tab: a mark states affiliation far more
   * loudly than a footnote denies it.
   *
   * So the mark this site wears is its own — a hub, not a cloud. These tests hold both
   * halves of that in place: the notice must stay, and the assets must not become a cloud
   * in Salesforce blue the next time somebody redraws them.
   */

  it('the non-affiliation notice is on every page, via the footer', () => {
    const footer = fs.readFileSync(path.join(VIEWS, 'partials', 'footer.ejs'), 'utf8');
    expect(footer).toMatch(/not affiliated with salesforce/i);
    expect(footer).toMatch(/trademarks/i);
  });

  it('the terms page states it plainly too', () => {
    const terms = fs.readFileSync(path.join(VIEWS, 'legal', 'terms.ejs'), 'utf8');
    expect(terms).toMatch(/not affiliated with|endorsed by|sponsored by/i);
  });

  it('no image asset claims to be a Salesforce logo', () => {
    const images = walk(path.join(PUBLIC, 'images'), '.svg');
    expect(images.length).toBeGreaterThan(0);

    for (const file of images) {
      const name = path.basename(file).toLowerCase();
      // A file called salesforce-logo.svg is somebody having pasted the real thing in.
      expect(name).not.toMatch(/salesforce.*(logo|cloud|mark)|sfdc/);

      const body = fs.readFileSync(file, 'utf8');
      // An <image> element is how a bitmap of somebody's logo gets smuggled into an SVG.
      expect(body).not.toMatch(/<image\b/i);
      /*
       * And nothing should be pulling a mark off someone else's server. Checked on the
       * things that actually FETCH — an href, an xlink:href, a CSS url() — and not on a
       * bare "http", because `xmlns="http://www.w3.org/2000/svg"` is a required namespace
       * declaration that fetches nothing. The first version of this assertion failed on
       * every file in the directory for exactly that reason.
       */
      expect(body).not.toMatch(/(?:xlink:)?href\s*=\s*"https?:/i);
      expect(body).not.toMatch(/url\(\s*['"]?https?:/i);
    }
  });

  it('every image referenced by a template exists on disk', () => {
    // A missing favicon is invisible in a passing test suite and obvious to every visitor.
    // This is what noticed the site had no favicon at all.
    const missing = [];
    for (const file of viewFiles) {
      const body = fs.readFileSync(file, 'utf8');
      const refs = body.match(/(?:src|href)="(\/images\/[^"<>]+)"/g) || [];
      for (const ref of refs) {
        const rel = ref.match(/"(\/images\/[^"]+)"/)[1].split('?')[0];
        if (!fs.existsSync(path.join(PUBLIC, rel))) {
          missing.push(`${path.relative(VIEWS, file)} -> ${rel}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('the page carries a favicon and a touch icon', () => {
    const head = fs.readFileSync(path.join(VIEWS, 'partials', 'head.ejs'), 'utf8');
    expect(head).toMatch(/rel="icon"/);
    expect(head).toMatch(/rel="apple-touch-icon"/);
  });

  it('the navbar mark is decorative, because the wordmark beside it already names the site', () => {
    // alt="" plus aria-hidden: a screen reader announcing both reads "Salesforce Hub"
    // twice in a row, which is worse than not announcing the image at all.
    const nav = fs.readFileSync(path.join(VIEWS, 'partials', 'navigation.ejs'), 'utf8');
    const mark = nav.match(/<img[^>]*brand-mark[^>]*>/);
    expect(mark).not.toBeNull();
    expect(mark[0]).toMatch(/alt=""/);
    expect(mark[0]).toMatch(/width="\d+"\s+height="\d+"/);
  });

  it('every SVG carries a width and a height, so nothing reflows while it loads', () => {
    for (const file of walk(path.join(PUBLIC, 'images'), '.svg')) {
      const body = fs.readFileSync(file, 'utf8');
      expect(body).toMatch(/<svg[^>]+width="\d+"/);
      expect(body).toMatch(/<svg[^>]+height="\d+"/);
    }
  });
});
