'use strict';

const Job = require('../../models/Job');
const ConsultantProfile = require('../../models/ConsultantProfile');
const Moderation = require('../../models/Moderation');
const { csvCell } = require('../../utils/csv');

/**
 * A moderator's takedown lives in the ONE builder each list uses, with no opt-out, so a page
 * cannot forget it — the same rule `Post.buildFilter` holds for hidden posts.
 */
describe('takedowns are enforced by the builders', () => {
  it('no job list can include an advert a moderator took down, whatever else it asks', () => {
    for (const filters of [{}, { status: 'draft' }, { company_user_id: 7 }, { include_hidden: true }]) {
      expect(Job.buildFilter(filters).clause).toMatch(/j\.admin_hidden_at IS NULL/);
    }
  });

  it('the directory requires both the member\'s switch and the moderator\'s to be clear', () => {
    const { clause } = ConsultantProfile.buildFilter({ include_hidden: true });
    expect(clause).toMatch(/cp\.is_public = 1/);
    expect(clause).toMatch(/cp\.admin_hidden_at IS NULL/);
  });

  it('the moderation log knows the two new subjects', () => {
    expect(Moderation.SUBJECT_TYPES).toEqual(expect.arrayContaining(['consultant_profile', 'job']));
  });

  it('the owner cannot publish a profile an administrator took down', async () => {
    const { promisePool } = require('../../config/database');
    const conn = {
      query: jest.fn().mockResolvedValue([[{ completeness: 100, admin_hidden_at: new Date() }]]),
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn()
    };
    jest.spyOn(promisePool, 'getConnection').mockResolvedValue(conn);
    const result = await ConsultantProfile.setPublic(5, true);
    expect(result).toMatchObject({ published: false, adminHidden: true });
    expect(conn.query).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });
});

describe('csvCell', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx'])('prefixes %p so a spreadsheet does not run it', (v) => {
    expect(csvCell(v).startsWith('"\'')).toBe(true);
  });
  it('quotes everything and doubles quotes', () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell(null)).toBe('""');
  });
});
