'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');

/**
 * The assistant's mascot (ported from SAP Hub): the launcher is the robot, the panel's
 * avatar is its head, both decorative, both versioned against the cache.
 */
describe('the assistant mascot', () => {
  const render = (locals = {}) => ejs.renderFile(path.join(ROOT, 'views', 'partials', 'assistant-widget.ejs'), {
    assistantMaxChars: 2000, supportEmail: 's@x.test', assetVersion: 'abc123', ...locals
  });

  test('the launcher is the robot with an AI tag, named for a screen reader', async () => {
    const out = await render();
    // Versioned, so a new robot is not hidden behind a week of cache.
    expect(out).toMatch(/<img class="sf-assistant-launcher-img" src="\/images\/sf-assistant\.webp\?v=abc123" alt=""/);
    expect(out).toMatch(/<img class="sf-assistant-avatar" src="\/images\/sf-assistant-head\.webp\?v=abc123" alt=""/);
    expect(out).toContain('class="sf-assistant-launcher-tag"');
    expect(out).toMatch(/aria-label="Open the Hub assistant, an AI"/);
  });

  test('every image is decorative and carries its size, so nothing reflows while it loads', async () => {
    const out = await render();
    for (const img of out.match(/<img[^>]*>/g)) {
      expect(img).toMatch(/alt=""/);
      expect(img).toMatch(/width="\d+" height="\d+"/);
    }
  });

  test('renders without an asset version too (a test harness, a partial rendered alone)', async () => {
    await expect(render({ assetVersion: undefined })).resolves.toMatch(/sf-assistant\.webp\?v="/);
  });

  test('both images exist, are WebP with transparency, and the launcher keeps its proportions', async () => {
    const sharp = require('sharp');
    const full = await sharp(path.join(ROOT, 'public', 'images', 'sf-assistant.webp')).metadata();
    const head = await sharp(path.join(ROOT, 'public', 'images', 'sf-assistant-head.webp')).metadata();
    expect([full.format, full.hasAlpha, head.format, head.hasAlpha]).toEqual(['webp', true, 'webp', true]);
    // 68x78 in the markup; the file is 313x360. A launcher drawn at another ratio squashes him.
    expect(Math.abs(full.width / full.height - 68 / 78)).toBeLessThan(0.01);
    expect(head.width).toBe(head.height);
  });

  test('the widget is still emitted only where the assistant is configured', () => {
    const layoutEnd = fs.readFileSync(path.join(ROOT, 'views', 'partials', 'layout-end.ejs'), 'utf8');
    expect(layoutEnd).toMatch(/<% if \(assistantEnabled\) \{ %>\s*<%- include\('assistant-widget'\) %>/);
  });
});
