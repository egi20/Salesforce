'use strict';

const fs = require('fs');
const path = require('path');

const Application = require('../../models/Application');

const ROOT = path.join(__dirname, '..', '..');

describe('the single filter builder for an employer\'s applications', () => {
  it('always scopes to the company, whatever else is asked for', () => {
    // The scope is not a filter and never comes from the query string: it is the session's
    // account. A board that could be widened by a parameter would be every company's
    // applications behind one URL.
    const { clause, params } = Application.buildFilter(7, {});
    expect(clause).toBe('j.company_user_id = ?');
    expect(params).toEqual([7]);
  });

  it('keeps the company scope even when every other filter is supplied', () => {
    const { clause, params } = Application.buildFilter(7, {
      status: 'shortlisted',
      jobId: 42,
      sinceDays: 30
    });
    expect(clause).toContain('j.company_user_id = ?');
    expect(params[0]).toBe(7);
    expect(params).toEqual([7, 'shortlisted', 42, 30]);
  });

  it('drops a status that is not a declared pipeline state', () => {
    const { clause, params } = Application.buildFilter(7, { status: 'promoted' });
    expect(clause).not.toContain('a.status = ?');
    expect(params).toEqual([7]);
  });

  it('is not fooled by an inherited property name', () => {
    // `TRANSITIONS['constructor']` is truthy on a plain object, so a truthiness check on
    // the lookup would let it through — the same trap `config/settings.js` documents.
    const { clause } = Application.buildFilter(7, { status: 'constructor' });
    expect(clause).not.toContain('a.status = ?');
  });

  it('parameterises the date window rather than building an interval expression', () => {
    const { clause, params } = Application.buildFilter(7, { sinceDays: 30 });
    expect(clause).toContain('INTERVAL ? DAY');
    expect(clause).not.toContain('INTERVAL 30');
    expect(params).toEqual([7, 30]);
  });

  it('parameterises every value, so a hostile one cannot reach the SQL', () => {
    const { clause } = Application.buildFilter(7, { jobId: "1; DROP TABLE applications; --" });
    expect(clause).not.toContain('DROP TABLE');
  });
});

describe('the board and its tabs cannot disagree', () => {
  afterEach(() => jest.restoreAllMocks());

  it('counts under the same filters as the list, minus the status itself', async () => {
    // A tab row whose counts collapsed the moment you picked a tab would make every other
    // stage read as empty — so `countsForCompany` drops the status and keeps the rest.
    const spy = jest.spyOn(Application, 'buildFilter');
    const { promisePool } = require('../../config/database');
    jest.spyOn(promisePool, 'query').mockResolvedValue([[]]);

    await Application.countsForCompany(7, { status: 'hired', jobId: 42, sinceDays: 7 });

    expect(spy).toHaveBeenCalledWith(7, { status: '', jobId: 42, sinceDays: 7 });
  });

  it('the list and the total come from ONE clause, built once', async () => {
    const { promisePool } = require('../../config/database');
    const query = jest.spyOn(promisePool, 'query')
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ total: 0 }]]);

    await Application.browseForCompany(7, { status: 'offered' }, { limit: 10, offset: 0 });

    const [listSql] = query.mock.calls[0];
    const [countSql] = query.mock.calls[1];
    // Same predicate in both, so "4 offered" is provably the number of rows behind it.
    expect(listSql).toContain('j.company_user_id = ? AND a.status = ?');
    expect(countSql).toContain('j.company_user_id = ? AND a.status = ?');
  });
});

describe('the board route', () => {
  const source = fs.readFileSync(path.join(ROOT, 'routes', 'dashboard.js'), 'utf8');

  it('is behind the company guard', () => {
    expect(source).toMatch(/'\/applicants',\s*\n?\s*isCompany,/);
  });

  it('reads named query fields rather than spreading the request', () => {
    // A field added to the form must not reach the builder unnoticed.
    expect(source).not.toMatch(/buildFilter\([^)]*\.\.\.req\.query/);
    expect(source).toMatch(/req\.query\.job/);
    expect(source).toMatch(/req\.query\.since/);
    expect(source).toMatch(/req\.query\.status/);
  });

  it('never writes: every transition stays on the application page', () => {
    // A board that moved rows itself would be a second write path into a table whose
    // state machine, audit event and notification are written in one transaction
    // elsewhere. The first path to drift is the one nobody is looking at.
    const board = source.slice(source.indexOf("'/applicants'"), source.indexOf("'/applications'"));
    expect(board).not.toMatch(/Application\.transition/);
    expect(board).not.toMatch(/router\.post/);
  });
});

describe('the board view', () => {
  const view = fs.readFileSync(path.join(ROOT, 'views', 'dashboard', 'applicants.ejs'), 'utf8');

  it('works without JavaScript: the filter is a plain GET form', () => {
    expect(view).toMatch(/<form[^>]*method="get"[^>]*action="\/dashboard\/applicants"/);
    expect(view).not.toMatch(/<script/i);
  });

  it('carries no CSRF token, because reading a board changes nothing', () => {
    expect(view).not.toContain('_csrf');
  });

  it('a capped column offers the stage its own page rather than hiding the rest', () => {
    expect(view).toMatch(/col\.total > cardsPerColumn/);
    expect(view).toMatch(/See all/);
  });
});
