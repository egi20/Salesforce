'use strict';

const { promisePool } = require('../../config/database');
const RateSubmission = require('../../models/RateSubmission');

/**
 * Voided submissions must never reach an aggregate.
 *
 * This is the quietest failure in the application. A single figure entered in the wrong
 * unit — an annual salary in a day-rate field — moves a published percentile for
 * everybody, and nothing anywhere raises. So the query is inspected directly rather than
 * trusted: the exclusion either is in the SQL or it is not.
 */
describe('the rate index query', () => {
  let spy;

  beforeEach(() => {
    spy = jest.spyOn(promisePool, 'query').mockResolvedValue([[]]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('excludes voided submissions from the rows the aggregator sees', async () => {
    await RateSubmission.rowsFor({ role: 'admin', seniority: 'senior' });
    const [sql] = spy.mock.calls[0];
    expect(sql).toMatch(/voided_at IS NULL/);
  });

  it('excludes them for every filter combination', async () => {
    const combinations = [
      {},
      { role: 'apex-developer' },
      { country: 'DE' },
      { seniority: 'lead', engagementType: 'permanent' },
      { periods: ['2026-01', '2026-02'] }
    ];

    for (const filters of combinations) {
      spy.mockClear();
      // eslint-disable-next-line no-await-in-loop
      await RateSubmission.rowsFor(filters);
      expect(spy.mock.calls[0][0]).toMatch(/voided_at IS NULL/);
    }
  });

  it('offers no way to turn the exclusion off', async () => {
    // Deliberately not an option. A caller that could ask for voided rows would eventually
    // be a caller that did.
    await RateSubmission.rowsFor({ includeVoided: true, voided: true, include_voided: '1' });
    expect(spy.mock.calls[0][0]).toMatch(/voided_at IS NULL/);
  });

  it('keeps parameters aligned with the clause', async () => {
    // The exclusion takes no placeholder; a stray one would shift every value after it.
    await RateSubmission.rowsFor({ role: 'admin', country: 'IE', periods: ['2026-01'] });
    const [sql, params] = spy.mock.calls[0];
    expect((sql.match(/\?/g) || []).length).toBe(params.length);
  });

  it('counts only contributors whose submission still counts', async () => {
    spy.mockResolvedValue([[{ count: 0 }]]);
    await RateSubmission.totalContributors();
    expect(spy.mock.calls[0][0]).toMatch(/voided_at IS NULL/);
  });
});
