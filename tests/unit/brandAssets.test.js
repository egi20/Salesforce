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
   * So the mark this site wears is its own — an S-cube, not a cloud. These tests hold both
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

describe('nothing is loaded from another origin', () => {
  /*
   * DESIGN.md and CLAUDE.md both state that the CSP allows no CDN at all, and until Inter
   * was self-hosted that was not true: the head carried two <link> tags to Google and the
   * policy carried two Google hosts to permit them. The documentation and the policy
   * disagreed, and nothing noticed because nothing checked.
   *
   * It was not theoretical. Driving the running site through a real browser, the Google
   * stylesheet request FAILED with ERR_CERT_AUTHORITY_INVALID behind a proxy — the exact
   * failure the rule predicts — and the page had been quietly falling back to system fonts.
   */
  const EXTERNAL = /(?:src|href)\s*=\s*["']https?:\/\//i;
  const webAnalytics = require('../../config/webAnalytics');

  function isConditionalBeacon(file, line) {
    if (path.relative(VIEWS, file) !== path.join('partials', 'footer.ejs')) return false;
    const src = (line.match(/src="(https:\/\/[^/"]+)\//) || [])[1];
    if (!src || !webAnalytics.CLOUDFLARE_HOSTS.script.includes(src)) return false;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const at = lines.findIndex((l) => l === line);
    // The guard is within the two lines above (the second is a comment).
    return lines.slice(Math.max(0, at - 2), at).some((l) => /<% if \(wa\.cloudflareToken && /.test(l));
  }

  it('no template pulls a stylesheet, script or font from another host', () => {
    const offenders = [];
    for (const file of viewFiles) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        // Only the tags that FETCH into the page. An <a href="https://..."> is a link
        // somebody clicks, which is an entirely different thing.
        if (/<(?:link|script|img|iframe|source)\b/i.test(line) && EXTERNAL.test(line)) {
          // The video embed allowlist is the one deliberate exception and lives in
          // utils/videoEmbed.js, built at render time — never hardcoded into a template.
          //
          // The Cloudflare analytics beacon is the other, and it is narrow on purpose: the
          // footer only, a host from config/webAnalytics.js, and only inside the guard that
          // renders it when CF_WEB_ANALYTICS_TOKEN is set. Anything else from another host
          // still fails here.
          if (isConditionalBeacon(file, line)) continue;
          offenders.push(`${path.relative(VIEWS, file)}: ${line.trim().slice(0, 100)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the CSP names no third-party host for styles, scripts or fonts', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const csp = server.slice(server.indexOf('contentSecurityPolicy'), server.indexOf('contentSecurityPolicy') + 2000);

    for (const directive of ['styleSrc', 'scriptSrc', 'fontSrc', 'connectSrc']) {
      const line = (csp.match(new RegExp(`${directive}:\\s*\\[[^\\]]*\\]`)) || [''])[0];
      expect(line).not.toMatch(/https?:\/\//);
      /*
       * And nothing but keywords and the analytics spread. The two analytics providers are
       * the one sanctioned way a host reaches these directives, and only through
       * `WEB_ANALYTICS_CSP` from config/webAnalytics.js — so a host typed in here directly,
       * or a constant from anywhere else, still fails.
       */
      const entries = line.replace(/^\w+:\s*\[|\]$/g, '').split(',').map((e) => e.trim()).filter(Boolean);
      // An empty list would pass the loop below silently.
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry).toMatch(/^"'(?:self|unsafe-inline)'"$|^\.\.\.WEB_ANALYTICS_CSP\.(?:script|connect)$/);
      }
    }
    // frameSrc is the exception: it carries EMBED_HOSTS, shared from utils/videoEmbed.js so
    // the policy and the allowlist cannot drift apart.
    expect(csp).toMatch(/frameSrc/);
  });

  it('names an analytics host only while that provider is configured', () => {
    // Unset: the policy is exactly what it was, with no third party at all.
    const webAnalytics = require('../../config/webAnalytics');
    expect(webAnalytics.cspAdditions(webAnalytics.load({}))).toEqual({ script: [], connect: [] });
    // Set: exactly that provider's hosts, and nothing from the other.
    const cf = webAnalytics.cspAdditions(webAnalytics.load({ CF_WEB_ANALYTICS_TOKEN: 'a'.repeat(32) }));
    expect([...cf.script, ...cf.connect].every((h) => /cloudflareinsights\.com$/.test(h))).toBe(true);
    const ga = webAnalytics.cspAdditions(webAnalytics.load({ GA4_MEASUREMENT_ID: 'G-ABC123XYZ' }));
    expect([...ga.script, ...ga.connect].every((h) => /google(?:tagmanager|-analytics)?\.com$|analytics\.google\.com$/.test(h))).toBe(true);
  });

  it('Inter is served from this origin and the stylesheet asks for files that exist', () => {
    const css = fs.readFileSync(path.join(PUBLIC, 'css', 'inter.css'), 'utf8');
    const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);

    for (const url of urls) {
      expect(url.startsWith('/vendor/inter/')).toBe(true);
      const onDisk = path.join(ROOT, 'node_modules', '@fontsource', 'inter', url.replace('/vendor/inter/', ''));
      expect(fs.existsSync(onDisk)).toBe(true);
    }
  });

  it('every weight the stylesheets actually set is a weight that gets downloaded', () => {
    /*
     * 800 was listed in DESIGN.md and set in five rules in style.css — including every h1,
     * the largest text on every page — and was in neither the old Google Fonts request nor
     * the first self-hosted version. So every heading on this site was a FAUX bold: the
     * browser smearing the 700 face instead of drawing the real one. Documented, used, and
     * never loaded, which is the combination nothing catches by reading.
     */
    const site = fs.readFileSync(path.join(PUBLIC, 'css', 'style.css'), 'utf8');
    const inter = fs.readFileSync(path.join(PUBLIC, 'css', 'inter.css'), 'utf8');

    const declared = new Set((inter.match(/font-weight:\s*(\d+)/g) || []).map((m) => m.match(/\d+/)[0]));
    const used = new Set((site.match(/font-weight:\s*(\d{3})/g) || []).map((m) => m.match(/\d+/)[0]));

    expect(declared.size).toBeGreaterThan(0);
    const synthesised = [...used].filter((w) => !declared.has(w));
    expect(synthesised).toEqual([]);
  });

  it('latin-ext is included, because Albanian ë and ç live there', () => {
    // Not cosmetic: without it every consultant and company name carrying a diacritic
    // renders in a fallback face, and the explicit unicode-range is what keeps the file
    // from being downloaded by pages that never show one.
    const css = fs.readFileSync(path.join(PUBLIC, 'css', 'inter.css'), 'utf8');
    expect(css).toMatch(/latin-ext/);
    expect((css.match(/unicode-range:/g) || []).length).toBe((css.match(/@font-face/g) || []).length);
  });
});
