'use strict';

// A company profile is created on first use and defaults to public, so a company that only
// opened /jobs/new used to be listed in the directory as an empty card. The directory, its
// count and search list a company only once it has something to show; a picker can ask for
// every public company, because hiding from an employer must not depend on that employer
// having written a tagline.

jest.mock('../../config/database', () => ({ promisePool: { query: jest.fn() } }));

const { promisePool } = require('../../config/database');
const CompanyProfile = require('../../models/CompanyProfile');

function sqlOfBrowse(filters) {
  promisePool.query.mockReset();
  promisePool.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]]);
  return CompanyProfile.browse(filters, { limit: 5, offset: 0 }).then(() =>
    promisePool.query.mock.calls.map((c) => c[0])
  );
}

describe('company directory lists only companies with something to show', () => {
  test('the list AND its count both carry the content clause by default', async () => {
    const [list, count] = await sqlOfBrowse({});
    expect(list).toContain(CompanyProfile.HAS_CONTENT);
    expect(count).toContain(CompanyProfile.HAS_CONTENT);
  });

  test('search goes through the same rule', async () => {
    const [list] = await sqlOfBrowse({ q: 'acme' });
    expect(list).toContain(CompanyProfile.HAS_CONTENT);
  });

  test('a picker may include empty public profiles, still never private ones', async () => {
    const [list, count] = await sqlOfBrowse({ include_empty: true });
    expect(list).not.toContain(CompanyProfile.HAS_CONTENT);
    expect(count).not.toContain(CompanyProfile.HAS_CONTENT);
    expect(list).toContain('cp.is_public = 1');
  });

  test('content means a tagline, an about or an open role', () => {
    expect(CompanyProfile.HAS_CONTENT).toMatch(/cp\.tagline/);
    expect(CompanyProfile.HAS_CONTENT).toMatch(/cp\.about/);
    expect(CompanyProfile.HAS_CONTENT).toMatch(/status = 'open'/);
  });
});
