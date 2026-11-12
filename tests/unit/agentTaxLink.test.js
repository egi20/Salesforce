'use strict';

/**
 * A sales agent's Tax Optimization link (/t/<code>, 2026-11-12): the same code as the
 * sign-up link, counted by the same person and preview filters, once per session per agent,
 * in its OWN session list. Unlike the sign-up link a signed-in visitor counts — tax
 * optimisation is for people who already have an account — except the agent themselves.
 */
jest.mock('../../models/SalesAgent', () => ({ countOpen: jest.fn(), countTaxOpen: jest.fn() }));

const SalesAgent = require('../../models/SalesAgent');
const { shouldCountTax, countTaxOpenOnce, countOpenOnce } = require('../../utils/salesAgentOpens');

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const agent = { user_id: 7, code: 'AB12CD34' };
const reqWith = (ua, session = {}) => ({ session, get: () => ua });

beforeEach(() => jest.clearAllMocks());

describe('what counts as one open of an agent tax link', () => {
  test('a person, the first time this session', () => {
    expect(shouldCountTax({ viewerId: null, agentUserId: 7, userAgent: BROWSER, alreadyCounted: [], code: 'AB12CD34' })).toBe(true);
  });
  test('a signed-in member counts — the programme is for people who already have an account', () => {
    expect(shouldCountTax({ viewerId: 99, agentUserId: 7, userAgent: BROWSER, alreadyCounted: [], code: 'AB12CD34' })).toBe(true);
  });
  test('never the agent checking their own link', () => {
    expect(shouldCountTax({ viewerId: 7, agentUserId: 7, userAgent: BROWSER, alreadyCounted: [], code: 'AB12CD34' })).toBe(false);
  });
  test('not a link-preview fetcher, and once per session', () => {
    expect(shouldCountTax({ viewerId: null, agentUserId: 7, userAgent: 'WhatsApp/2.23.20.0 A', alreadyCounted: [], code: 'AB12CD34' })).toBe(false);
    expect(shouldCountTax({ viewerId: null, agentUserId: 7, userAgent: BROWSER, alreadyCounted: ['AB12CD34'], code: 'AB12CD34' })).toBe(false);
  });
});

describe('countTaxOpenOnce', () => {
  test('writes one dated row per session and never touches the sign-up counter', async () => {
    const req = reqWith(BROWSER);
    expect(await countTaxOpenOnce(req, agent)).toBe(true);
    expect(await countTaxOpenOnce(req, agent)).toBe(false);
    expect(SalesAgent.countTaxOpen).toHaveBeenCalledTimes(1);
    expect(SalesAgent.countTaxOpen).toHaveBeenCalledWith(7);
    expect(SalesAgent.countOpen).not.toHaveBeenCalled();
  });

  test('opening the sign-up link does not use up the tax-link open', async () => {
    const req = reqWith(BROWSER);
    expect(await countOpenOnce(req, agent)).toBe(true);
    expect(await countTaxOpenOnce(req, agent)).toBe(true);
  });

  test('a failed write never throws', async () => {
    SalesAgent.countTaxOpen.mockRejectedValueOnce(new Error('no table'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await countTaxOpenOnce(reqWith(BROWSER), agent)).toBe(false);
    spy.mockRestore();
  });
});
