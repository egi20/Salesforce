'use strict';

const fs = require('fs');
const path = require('path');
const Application = require('../../models/Application');

const ROOT = path.join(__dirname, '..', '..');

/**
 * /admin/applications reads every company's applications through the SAME builder as an
 * employer's own board. Widening it must be impossible by accident and possible on purpose.
 */
describe('the oversight scope', () => {
  it('a missing scope throws rather than meaning "everybody"', () => {
    expect(() => Application.buildFilter(undefined, {})).toThrow(/scoped/);
    expect(() => Application.buildFilter(null, {})).toThrow(/scoped/);
    expect(() => Application.buildFilter(0, {})).toThrow(/scoped/);
  });

  it('only the exported sentinel widens it, and nothing a request can carry equals that', () => {
    const { clause, params } = Application.buildFilter(Application.ALL_COMPANIES, {});
    expect(clause).not.toMatch(/company_user_id/);
    expect(params).toEqual([]);
    expect(() => Application.buildFilter('all', {})).not.toThrow();
    expect(Application.buildFilter('all', {}).clause).toMatch(/j\.company_user_id = \?/);
  });

  it('escapes a search before it becomes a LIKE pattern', () => {
    const { params } = Application.buildFilter(Application.ALL_COMPANIES, { q: '50%' });
    expect(params).toEqual(['%50\\%%', '%50\\%%', '%50\\%%']);
  });

  it('reads "stalled" and "reached" from the event log, parameterised', () => {
    const { clause, params } = Application.buildFilter(Application.ALL_COMPANIES, { stalledDays: 14, reached: 'interviewing' });
    expect(clause).toMatch(/NOT EXISTS \(SELECT 1 FROM application_events/);
    expect(clause).toMatch(/ae\.to_status = \?/);
    expect(clause).toContain('INTERVAL ? DAY');
    expect(params).toEqual(['interviewing', 14]);
  });

  it('hides withdrawn only when asked, so the employer board is unchanged', () => {
    expect(Application.buildFilter(7, {}).clause).toBe('j.company_user_id = ?');
    expect(Application.buildFilter(7, { hideWithdrawn: true }).clause).toMatch(/<> 'withdrawn'/);
    // Asking for a status by name wins over the toggle.
    expect(Application.buildFilter(7, { hideWithdrawn: true, status: 'withdrawn' }).params).toEqual([7, 'withdrawn']);
  });

  it('the route is superadmin, uses the sentinel, and reads named query fields only', () => {
    const admin = fs.readFileSync(path.join(ROOT, 'routes', 'admin.js'), 'utf8');
    const at = admin.indexOf("router.get(\n  '/applications',");
    const body = admin.slice(at, admin.indexOf('\n);\n', at));
    expect(body).toMatch(/'\/applications',\s*\n\s*isSuperadmin,/);
    expect(body).toMatch(/Application\.ALL_COMPANIES/);
    expect(body).not.toMatch(/\.\.\.req\.query/);
  });

  it('the screen shows the state of an application, never its content', () => {
    const view = fs.readFileSync(path.join(ROOT, 'views', 'admin', 'applications.ejs'), 'utf8');
    expect(view).not.toMatch(/cover_letter|day_rate/);
  });
});
