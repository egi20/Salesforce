'use strict';

const ApiUsage = require('../../models/ApiUsage');
const { assertWithinBudget, clearBudgetCache, BudgetExceededError } = require('../../utils/aiBudget');
const { GLOBAL_MONTHLY_BUDGET_USD, USER_MONTHLY_BUDGET_USD } = require('../../config/assistant');

/**
 * The spend circuit-breaker.
 *
 * It is the only bound that actually caps the invoice: rate limiting bounds requests per
 * address, and a distributed flood keeps every address under the limit. So its two
 * behaviours have to be pinned — that it stops when the cap is reached, and that a
 * database it cannot read does NOT take the feature down with it.
 */
describe('the AI spend circuit-breaker', () => {
  let globalSpy;
  let userSpy;

  beforeEach(() => {
    clearBudgetCache();
    globalSpy = jest.spyOn(ApiUsage, 'monthToDateCost');
    userSpy = jest.spyOn(ApiUsage, 'monthToDateCostForUser');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    clearBudgetCache();
  });

  it('allows a call while spend is below the cap', async () => {
    globalSpy.mockResolvedValue(0);
    userSpy.mockResolvedValue(0);
    await expect(assertWithinBudget(null)).resolves.toBe(true);
  });

  it('stops every call once the global cap is reached', async () => {
    globalSpy.mockResolvedValue(GLOBAL_MONTHLY_BUDGET_USD);
    await expect(assertWithinBudget(null)).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
      scope: 'global'
    });
  });

  it('stops one account once its own cap is reached, without stopping everyone else', async () => {
    globalSpy.mockResolvedValue(0);
    userSpy.mockResolvedValue(USER_MONTHLY_BUDGET_USD);

    await expect(assertWithinBudget(7)).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
      scope: 'user'
    });
    // The anonymous path never consults the per-user total; it has nothing to key on.
    await expect(assertWithinBudget(null)).resolves.toBe(true);
  });

  it('does not consult the per-user total for an anonymous visitor', async () => {
    globalSpy.mockResolvedValue(0);
    await assertWithinBudget(null);
    expect(userSpy).not.toHaveBeenCalled();
  });

  it('FAILS OPEN when the ledger cannot be read', async () => {
    // A budget lookup that is briefly unavailable must not become a site-wide outage of
    // the feature. Failing closed here would mean a monitoring query taking the
    // assistant down.
    globalSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));
    userSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(assertWithinBudget(7)).resolves.toBe(true);
    // Open, but never silent.
    expect(warn).toHaveBeenCalled();
  });

  it('re-throws a budget block rather than swallowing it as a read failure', async () => {
    // The fail-open catch must not eat the very exception it is wrapped around.
    globalSpy.mockResolvedValue(GLOBAL_MONTHLY_BUDGET_USD * 10);
    await expect(assertWithinBudget(null)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('caches the total, so enforcement is not one aggregate query per request', async () => {
    globalSpy.mockResolvedValue(0);
    await assertWithinBudget(null);
    await assertWithinBudget(null);
    await assertWithinBudget(null);
    expect(globalSpy).toHaveBeenCalledTimes(1);
  });
});
