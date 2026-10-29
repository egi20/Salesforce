'use strict';

const fs = require('fs');
const path = require('path');
const IssueReport = require('../../models/IssueReport');
const { promisePool } = require('../../config/database');

const ROOT = path.join(__dirname, '..', '..');
const strip = (sql) => sql.replace(/^\s*--.*$/gm, '');

/**
 * Issue reports' extras (migration 034, from SAP Hub's report form): severity, the content
 * being reported, screenshots, and ideas published with two switches.
 */
describe('what a report stores', () => {
  let query;
  beforeEach(() => { query = jest.spyOn(promisePool, 'query').mockResolvedValue([{ insertId: 4 }]); });
  afterEach(() => jest.restoreAllMocks());
  const base = { summary: 'The button does nothing', detail: 'I pressed it and nothing happened at all.' };
  const stored = () => query.mock.calls[0][1];

  it('keeps a declared severity, and drops an invented one', async () => {
    await IssueReport.create({ ...base, kind: 'bug', severity: 'critical' });
    expect(stored()[4]).toBe('critical');
    query.mockClear();
    await IssueReport.create({ ...base, kind: 'bug', severity: 'apocalyptic' });
    expect(stored()[4]).toBeNull();
  });

  it('asks an idea for no severity and records consent only when ticked', async () => {
    await IssueReport.create({ ...base, kind: 'idea', severity: 'high', publish_consent: 'on' });
    expect(stored()[4]).toBeNull();
    expect(stored()[8]).toBe(1);
    query.mockClear();
    await IssueReport.create({ ...base, kind: 'bug', publish_consent: 'on' });
    expect(stored()[8]).toBe(0);
    query.mockClear();
    await IssueReport.create({ ...base, kind: 'idea' });
    expect(stored()[8]).toBe(0);
  });

  it('keeps the reported content only for that kind, and only as a path on this site', async () => {
    await IssueReport.create({ ...base, kind: 'content', content_path: '/community/a-post' });
    expect(stored()[2]).toBe('/community/a-post');
    query.mockClear();
    await IssueReport.create({ ...base, kind: 'content', content_path: 'javascript:alert(1)' });
    expect(stored()[2]).toBeNull();
    query.mockClear();
    await IssueReport.create({ ...base, kind: 'content', content_path: '//evil.test/x' });
    expect(stored()[2]).toBeNull();
    query.mockClear();
    await IssueReport.create({ ...base, kind: 'bug', content_path: '/community/a-post' });
    expect(stored()[2]).toBeNull();
  });
});

describe('published ideas', () => {
  afterEach(() => jest.restoreAllMocks());

  it('need the kind, the sender\'s consent AND an administrator, in one fragment', () => {
    const { clause, params } = IssueReport.publicIdeaFilter();
    expect(clause).toMatch(/publish_consent = 1/);
    expect(clause).toMatch(/published_at IS NOT NULL/);
    expect(params).toEqual(['idea']);
  });

  it('cannot be published without consent, whatever the form posts', async () => {
    const query = jest.spyOn(promisePool, 'query').mockResolvedValue([{ affectedRows: 0 }]);
    expect(await IssueReport.setIdeaPublished(3, true, 1)).toBe(false);
    expect(query.mock.calls[0][0]).toMatch(/AND publish_consent = 1/);
  });

  it('a vote on anything that is not a published idea is refused before any write', async () => {
    const query = jest.spyOn(promisePool, 'query').mockResolvedValueOnce([[]]);
    expect(await IssueReport.toggleIdeaVote(3, 7)).toEqual({ ok: false });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('the public list selects no name and no address', () => {
    const src = fs.readFileSync(path.join(ROOT, 'models', 'IssueReport.js'), 'utf8');
    const at = src.indexOf('static async publishedIdeas');
    const body = src.slice(at, src.indexOf('static async toggleIdeaVote'));
    expect(body).not.toMatch(/contact_email|u\.name|u\.email|user_id AS|i\.user_id/);
  });
});

describe('screenshots', () => {
  afterEach(() => jest.restoreAllMocks());

  it('are re-encoded by sharp, and something that is not an image is refused', async () => {
    const query = jest.spyOn(promisePool, 'query').mockResolvedValue([{}]);
    const png = await require('sharp')({ create: { width: 4, height: 3, channels: 3, background: '#ffffff' } }).png().toBuffer();
    await IssueReport.addAttachments(5, [png]);
    const [, params] = query.mock.calls[0];
    expect(params[0]).toBe(5);
    expect(params[1].slice(8, 12).toString()).toBe('WEBP');
    await expect(IssueReport.addAttachments(5, [Buffer.from('<?php echo 1; ?>')])).rejects.toThrow();
  });

  it('are purged only from CLOSED reports, timed from closing', async () => {
    const query = jest.spyOn(promisePool, 'query').mockResolvedValue([{ affectedRows: 2 }]);
    expect(await IssueReport.purgeExpiredAttachments()).toBe(2);
    expect(query.mock.calls[0][0]).toMatch(/i\.status = 'closed' AND i\.closed_at IS NOT NULL AND i\.closed_at < DATE_SUB\(NOW\(\), INTERVAL \? DAY\)/);
    expect(query.mock.calls[0][0]).toMatch(/^\s*DELETE a FROM issue_report_attachments a/);
  });

  it('closing stamps closed_at, so the retention clock has a start', async () => {
    const query = jest.spyOn(promisePool, 'query')
      .mockResolvedValueOnce([[{ id: 1, status: 'open' }]])
      .mockResolvedValueOnce([{}]);
    await IssueReport.setStatus(1, 'closed', {});
    expect(query.mock.calls[1][0]).toMatch(/closed_at = CASE WHEN \? = 'closed' THEN NOW\(\) ELSE closed_at END/);
    expect(query.mock.calls[1][1].slice(0, 2)).toEqual(['closed', 'closed']);
  });
});

describe('migration 034', () => {
  it('captures nothing automatically, like 025 before it', () => {
    const sql = strip(fs.readFileSync(path.join(ROOT, 'scripts', 'migrations', '034_issue_report_extras.sql'), 'utf8'));
    for (const column of ['ip_address', 'signup_ip', 'user_agent', 'referrer', 'referer', 'env_info']) {
      expect(sql).not.toMatch(new RegExp(`\\b${column}\\b`, 'i'));
    }
    expect(sql.replace(/CURRENT_TIMESTAMP/g, '')).not.toMatch(/TIMESTAMP/);
  });
});
