'use strict';

const fs = require('fs');
const path = require('path');
const Application = require('../../models/Application');
const { summary, followUpDue, timeline, statusLabel, STATUS_ORDER } = require('../../utils/applicationStats');

const NOW = new Date('2026-11-20T12:00:00Z');
const days = (n) => new Date(NOW.getTime() - n * 86400000);

describe('the figures at the top of the tracker', () => {
  it('counts this month, the share seen and the average wait for a first response', () => {
    const rows = [
      { created_at: days(2), seen_at: days(1) }, // 1 day
      { created_at: days(10), seen_at: days(7) }, // 3 days
      { created_at: days(30), seen_at: null }
    ];
    expect(summary(rows, NOW)).toEqual({ total: 3, thisMonth: 2, seenPercent: 67, avgResponseDays: 2 });
  });

  it('says nothing rather than zero when there is nothing to measure', () => {
    expect(summary([], NOW)).toEqual({ total: 0, thisMonth: 0, seenPercent: null, avgResponseDays: null });
    expect(summary([{ created_at: days(1), seen_at: null }], NOW).avgResponseDays).toBeNull();
  });
});

describe('the follow-up nudge', () => {
  const base = { status: 'submitted', seen_at: null, job_status: 'open', created_at: days(15) };
  it('appears after 14 days of silence on an open role', () => {
    expect(followUpDue(base, NOW)).toBe(true);
    expect(followUpDue({ ...base, created_at: days(13) }, NOW)).toBe(false);
  });
  it('never chases a company that answered, a moved application or a closed role', () => {
    expect(followUpDue({ ...base, seen_at: days(3) }, NOW)).toBe(false);
    expect(followUpDue({ ...base, status: 'reviewing' }, NOW)).toBe(false);
    expect(followUpDue({ ...base, job_status: 'closed' }, NOW)).toBe(false);
  });
});

describe('the timeline under each application', () => {
  it('reads the event log and slots "Viewed by company" in by time', () => {
    const steps = timeline({ viewed_at: days(5) }, [
      { from_status: null, to_status: 'submitted', created_at: days(6) },
      { from_status: 'submitted', to_status: 'interviewing', created_at: days(2) }
    ]);
    expect(steps.map((s) => s.label)).toEqual(['Applied', 'Viewed by company', 'Interview']);
  });
  it('calls a re-application what it is', () => {
    const steps = timeline({}, [
      { from_status: null, to_status: 'submitted', created_at: days(9) },
      { from_status: 'submitted', to_status: 'withdrawn', created_at: days(8) },
      { from_status: 'withdrawn', to_status: 'submitted', created_at: days(7) }
    ]);
    expect(steps.map((s) => s.label)).toEqual(['Applied', 'Withdrawn', 'Applied again']);
  });
  it('labels every status the pipeline can hold', () => {
    for (const st of Application.STATUSES) expect(STATUS_ORDER).toContain(st);
    expect(statusLabel('interviewing')).toBe('Interview');
  });
});

describe('one filter builder, both sides of the table', () => {
  it('scopes to the consultant from the scope object, never from a filter', () => {
    const { clause, params } = Application.buildFilter(Application.forConsultant(7), { archived: false, engagement: 'contract', q: 'cpq' });
    expect(clause).toMatch(/a\.consultant_user_id = \?/);
    expect(clause).not.toMatch(/j\.company_user_id/);
    expect(clause).toMatch(/NOT \(a\.status IN \('hired','rejected','withdrawn'\) OR j\.status <> 'open'\)/);
    expect(params[0]).toBe(7);
    expect(params).toContain('contract');
  });
  it('still refuses a missing scope', () => {
    expect(() => Application.buildFilter(null, {})).toThrow(/scoped/);
    expect(() => Application.forConsultant('x')).toThrow();
  });
});

describe('private notes stay private', () => {
  it('live in their own table, which no employer-side query reads', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../models/Application.js'), 'utf8');
    const employerSide = src.slice(src.indexOf('static async listForJob'), src.indexOf('// ----'));
    expect(employerSide).not.toMatch(/application_notes/);
    const migration = fs.readFileSync(path.join(__dirname, '../../scripts/migrations/040_application_tracking.sql'), 'utf8');
    expect(migration).not.toMatch(/ADD COLUMN\s+\w*note/i);
  });
});
