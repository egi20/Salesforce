'use strict';

/**
 * Scanner CSRF refusals are answered and not logged, and fixed errors can be deleted by the
 * filter that shows them (2026-11-06, ported from SAP Hub, where both were found in prod).
 */

jest.mock('../../config/database', () => ({ promisePool: { query: jest.fn(), getConnection: jest.fn() } }));

const express = require('express');
const { promisePool } = require('../../config/database');
const ErrorLog = require('../../models/ErrorLog');
const { isScannerCsrfRefusal } = require('../../middleware/errorHandler');

function appWith() {
  const a = express();
  a.post('/contact', (req, res) => res.end());
  return a;
}

describe('isScannerCsrfRefusal', () => {
  const csrf = { code: 'EBADCSRFTOKEN' };
  const app = appWith();
  const req = (path, cookie, { site, user } = {}) => ({
    app, method: 'POST', path,
    get: (h) => (h === 'cookie' ? cookie : h === 'sec-fetch-site' ? site : undefined),
    session: user ? { user } : {}
  });

  it('is true on a path no route answers, whatever the headers say', () => {
    expect(isScannerCsrfRefusal(csrf, req('/graphql', 'sfhub.sid=s%3Aa', { site: 'same-origin' }))).toBe(true);
    expect(isScannerCsrfRefusal(csrf, req('/', 'sfhub.sid=s%3Aa', { site: 'same-origin' }))).toBe(true);
  });

  it('is true on a real route without the cookie, or with the cookie and no person', () => {
    expect(isScannerCsrfRefusal(csrf, req('/contact', undefined))).toBe(true);
    expect(isScannerCsrfRefusal(csrf, req('/contact', 'sfhub.sid=s%3Aa'))).toBe(true);
  });

  it('is false for a browser or a signed-in session on a real route, and for other errors', () => {
    expect(isScannerCsrfRefusal(csrf, req('/contact', 'sfhub.sid=s%3Aa', { site: 'same-origin' }))).toBe(false);
    expect(isScannerCsrfRefusal(csrf, req('/contact', 'sfhub.sid=s%3Aa', { user: { id: 1 } }))).toBe(false);
    expect(isScannerCsrfRefusal({ code: 'OTHER' }, req('/graphql', undefined))).toBe(false);
  });
});

describe('ErrorLog.buildFilter', () => {
  it('is "1 = 1" with no filter and parameterises every value', () => {
    expect(ErrorLog.buildFilter({}).clause).toBe('1 = 1');
    const { clause, params } = ErrorLog.buildFilter({ q: 'CSRF', statusCode: '403', from: '2026-10-01', to: '2026-11-03' });
    expect(clause).not.toMatch(/CSRF|403|2026/);
    expect(params).toEqual(['%CSRF%', '%CSRF%', 403, '2026-10-01', '2026-11-03']);
    expect(clause).toContain('created_at < DATE_ADD(?, INTERVAL 1 DAY)');
  });

  it('ignores a malformed status or date rather than passing it on', () => {
    expect(ErrorLog.buildFilter({ statusCode: 'x', from: '2026-1-1', to: "1' OR 1" }).clause).toBe('1 = 1');
  });
});

describe('ErrorLog.deleteMatching', () => {
  let conn;
  beforeEach(() => {
    conn = { beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(), query: jest.fn() };
    promisePool.getConnection.mockResolvedValue(conn);
  });

  it('refuses without a filter and touches nothing', async () => {
    await expect(ErrorLog.deleteMatching({}, 5)).rejects.toMatchObject({ code: 'ERROR_LOG_NO_FILTER' });
    expect(promisePool.getConnection).not.toHaveBeenCalled();
  });

  it('deletes nothing when the count shown is stale', async () => {
    conn.query.mockResolvedValueOnce([[{ n: 7, maxId: 90 }]]);
    await expect(ErrorLog.deleteMatching({ q: 'CSRF' }, 5)).rejects.toMatchObject({ code: 'ERROR_LOG_COUNT_MISMATCH' });
    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  it('deletes the filtered rows up to the highest id it counted', async () => {
    conn.query.mockResolvedValueOnce([[{ n: 5, maxId: 90 }]]).mockResolvedValueOnce([{ affectedRows: 5 }]);
    await expect(ErrorLog.deleteMatching({ q: 'CSRF' }, 5)).resolves.toBe(5);
    const [sql, params] = conn.query.mock.calls[1];
    expect(sql).toMatch(/^DELETE FROM error_logs WHERE .* AND id <= \?$/);
    expect(params).toEqual(['%CSRF%', '%CSRF%', 90]);
    expect(conn.commit).toHaveBeenCalled();
  });
});
