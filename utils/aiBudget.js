'use strict';

const ApiUsage = require('../models/ApiUsage');
const {
  GLOBAL_MONTHLY_BUDGET_USD,
  USER_MONTHLY_BUDGET_USD
} = require('../config/assistant');

/**
 * The spend circuit-breaker.
 *
 * A public endpoint that costs money per request needs a cap that is not a rate limiter.
 * Rate limiting bounds requests PER ADDRESS; five hundred addresses each staying politely
 * under the limit still produce an unbounded bill. This is the thing that says "stop".
 *
 * Two decisions worth arguing with rather than discovering:
 *
 *  1. IT FAILS OPEN. If the ledger cannot be read, the call is allowed. A budget lookup
 *     that is briefly unavailable must not take the feature down — the failure mode of
 *     failing closed is a site-wide outage caused by a monitoring query, which is worse
 *     than a few minutes of uncapped spend. The exception is logged so it cannot rot.
 *  2. THE CHECK IS BEFORE, THE LEDGER IS AFTER. The cost of a call is only known once it
 *     returns, so the cap is always crossed by at most one exchange. That is the honest
 *     bound, and it is why the caps are set well below the number that would actually
 *     hurt.
 *
 * Totals are cached for a short window so enforcement costs at most one cheap aggregate
 * per window rather than one per request.
 */

const CACHE_TTL_MS = 45 * 1000;

const cache = {
  global: { value: null, at: 0 },
  perUser: new Map()
};

class BudgetExceededError extends Error {
  constructor(message, scope) {
    super(message);
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    // 'global' or 'user'. The visitor is told different things by each.
    this.scope = scope;
  }
}

function clearBudgetCache() {
  cache.global = { value: null, at: 0 };
  cache.perUser.clear();
}

async function globalMonthToDate() {
  const now = Date.now();
  if (cache.global.value !== null && now - cache.global.at < CACHE_TTL_MS) {
    return cache.global.value;
  }
  const value = await ApiUsage.monthToDateCost();
  cache.global = { value, at: now };
  return value;
}

async function userMonthToDate(userId) {
  const now = Date.now();
  const hit = cache.perUser.get(userId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await ApiUsage.monthToDateCostForUser(userId);
  cache.perUser.set(userId, { value, at: now });
  return value;
}

/**
 * @throws {BudgetExceededError} when a cap that is actually set has been reached.
 * @param {number|null} userId null for an anonymous visitor, who faces only the global cap
 *   — there is nothing durable to key a per-user total on, which is exactly why the IP and
 *   process-wide rate limiters exist.
 */
async function assertWithinBudget(userId = null) {
  try {
    if (GLOBAL_MONTHLY_BUDGET_USD > 0) {
      const spent = await globalMonthToDate();
      if (spent >= GLOBAL_MONTHLY_BUDGET_USD) {
        throw new BudgetExceededError(
          'The assistant has reached its budget for this month. It will be back at the start of next month.',
          'global'
        );
      }
    }

    if (userId && USER_MONTHLY_BUDGET_USD > 0) {
      const spent = await userMonthToDate(userId);
      if (spent >= USER_MONTHLY_BUDGET_USD) {
        throw new BudgetExceededError(
          'You have used your assistant allowance for this month. It resets at the start of next month.',
          'user'
        );
      }
    }
  } catch (err) {
    if (err.code === 'BUDGET_EXCEEDED') throw err;
    // Fail OPEN, loudly. See the note at the top: an unreadable ledger must not be an
    // outage, but it must never be silent either.
    console.error(`aiBudget: could not read the spend ledger, allowing the call — ${err.message}`);
  }
  return true;
}

/** For the admin panel: what has been spent and what the caps are. */
async function budgetStatus() {
  const spent = await ApiUsage.monthToDateCost();
  return {
    spentUsd: spent,
    globalCapUsd: GLOBAL_MONTHLY_BUDGET_USD,
    userCapUsd: USER_MONTHLY_BUDGET_USD,
    capped: GLOBAL_MONTHLY_BUDGET_USD > 0,
    remainingUsd: GLOBAL_MONTHLY_BUDGET_USD > 0 ? Math.max(0, GLOBAL_MONTHLY_BUDGET_USD - spent) : null,
    percentUsed:
      GLOBAL_MONTHLY_BUDGET_USD > 0
        ? Math.min(100, Math.round((spent / GLOBAL_MONTHLY_BUDGET_USD) * 100))
        : 0
  };
}

module.exports = {
  assertWithinBudget,
  budgetStatus,
  clearBudgetCache,
  BudgetExceededError
};
