'use strict';

const { socialLinks, problemWith, PLATFORMS } = require('../../config/social');
const settings = require('../../config/settings');

/**
 * Social links (ported from SAP Hub): an operational setting per platform, host-checked
 * when saved and again where rendered, and absent from the page until one is set.
 */
describe('social links', () => {
  it('renders nothing until a link is saved', () => {
    expect(socialLinks({})).toEqual([]);
    expect(socialLinks(settings.defaults())).toEqual([]);
  });

  it('every platform is a declared setting, so setMany can write it and nothing else', () => {
    PLATFORMS.forEach((p) => expect(settings.isValidKey(`social_${p.key}`)).toBe(true));
    expect(settings.assertSettingsIntegrity()).toBe(true);
  });

  it('refuses http, a foreign host, a look-alike host and an embedded login', () => {
    expect(settings.problemFor('social_linkedin', 'http://www.linkedin.com/company/x')).toMatch(/https/);
    expect(settings.problemFor('social_linkedin', 'https://linkedin.com.evil.test/x')).toMatch(/not LinkedIn/);
    expect(settings.problemFor('social_x', 'https://user:pw@x.com/hub')).toMatch(/user name or password/);
    expect(settings.problemFor('social_youtube', 'not a url')).toMatch(/web address/);
    expect(settings.problemFor('social_youtube', '')).toBeNull();
    expect(settings.problemFor('registration_open', 'https://evil.test')).toBeNull();
  });

  it('drops a bad value at render time too, whatever route it took into the table', () => {
    const out = socialLinks({ social_linkedin: 'https://www.linkedin.com/company/sforcehub', social_x: 'https://evil.test/' });
    expect(out).toEqual([{ key: 'linkedin', label: 'LinkedIn', icon: 'bi-linkedin', href: 'https://www.linkedin.com/company/sforcehub' }]);
    expect(problemWith(PLATFORMS[0], 'https://www.linkedin.com/x')).toBeNull();
  });

  it('a __proto__ key is not a setting', () => {
    expect(settings.problemFor('__proto__', 'x')).toBeNull();
    expect(settings.isValidKey('__proto__')).toBe(false);
  });
});
