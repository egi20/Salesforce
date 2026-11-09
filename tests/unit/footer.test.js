'use strict';

const path = require('path');
const ejs = require('ejs');

const FOOTER = path.join(__dirname, '..', '..', 'views', 'partials', 'footer.ejs');

function render(locals = {}) {
  return ejs.renderFile(FOOTER, { appName: 'Salesforce Hub', currentUser: null, assetVersion: '', ...locals });
}

const hrefs = (html) => [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);

describe('footer', () => {
  it('links each page once: the rate index sits under Consultant Hub only', async () => {
    const links = hrefs(await render()).filter((h) => h.startsWith('/'));
    const dupes = links.filter((h, i) => links.indexOf(h) !== i);
    expect(dupes).toEqual([]);
  });

  it('names its links in one style', async () => {
    const html = await render({ currentUser: { id: 1 } });
    for (const label of ['Rate Calculator', 'Recruitment Agencies', 'Daily Challenges', 'Privacy Policy', 'Terms of Service', 'Cookie Policy']) {
      expect(html).toContain(`>${label}</a>`);
    }
    expect(html).not.toMatch(/>(Privacy policy|Terms of service|Rate calculator|Recruitment agencies|Daily challenges)</);
  });

  it('points the cookie policy at the privacy policy’s own Cookies section', async () => {
    expect(hrefs(await render())).toContain('/legal/privacy#cookies');
  });

  it('offers Company Details and names the company only when the legal entity is set', async () => {
    const unset = await render({ footerCompany: null, footerCompanyLink: false });
    expect(unset).not.toContain('Company Details');
    expect(unset).not.toContain('operated by');

    const set = await render({ footerCompany: 'Example Sh.p.k.', footerCompanyLink: true });
    expect(hrefs(set)).toContain('/about#who-runs-it');
    expect(set).toMatch(/&copy; \d{4} Salesforce Hub, operated by Example Sh\.p\.k\.\. All rights reserved\./);
  });

  it('renders no icon row until an account or a real email exists, then the same ones as the rail', async () => {
    expect(await render()).not.toContain('footer-social');
    const html = await render({
      socialLinks: [{ key: 'linkedin', label: 'LinkedIn', icon: 'bi-linkedin', href: 'https://www.linkedin.com/company/x' }],
      socialEmail: 'hello@salesforcehub.example.org'
    });
    expect(html).toContain('href="https://www.linkedin.com/company/x"');
    expect(html).toContain('href="mailto:hello@salesforcehub.example.org"');
    const rail = await ejs.renderFile(path.join(__dirname, '..', '..', 'views', 'partials', 'social-rail.ejs'), {
      currentUser: null,
      socialLinks: [{ key: 'linkedin', label: 'LinkedIn', icon: 'bi-linkedin', href: 'https://www.linkedin.com/company/x' }],
      socialEmail: 'hello@salesforcehub.example.org'
    });
    expect(rail).toContain('href="mailto:hello@salesforcehub.example.org"');
  });
});
