'use strict';

const crypto = require('crypto');

const config = require('../config/config');
const { TEST_SUITE, testKeyFor } = require('../config/adminTests');
const AdminTestRun = require('../models/AdminTestRun');

/**
 * Runs one test: a real HTTP request against the running app, on its own base URL — not a
 * simulated request object. `redirect: 'manual'` is what lets a protected page's 302 be
 * read as a 302 instead of silently following it to the login page and grading that 200.
 */
async function runOne(test) {
  const started = Date.now();
  const url = `${config.app.baseUrl}${test.endpoint}`;
  const headers = test.api ? { Accept: 'application/json' } : {};

  try {
    const response = await fetch(url, { method: test.method, headers, redirect: 'manual' });
    const durationMs = Date.now() - started;
    return {
      actualStatus: response.status,
      passed: response.status === test.expectedStatus,
      error: null,
      durationMs
    };
  } catch (err) {
    return {
      actualStatus: null,
      passed: false,
      error: err.message.slice(0, 290),
      durationMs: Date.now() - started
    };
  }
}

/**
 * Runs the whole suite, or one category of it, and records every result under one batch id
 * so "the last run" is a query, not a guess. Sequential rather than Promise.all — this is
 * an admin clicking a button, not a load test, and running tests one at a time is what
 * keeps a flaky failure from being "the app fell over because we hit it with 30 requests
 * at once" instead of a real finding.
 */
async function runSuite({ category = null, runBy = null } = {}) {
  const runBatch = crypto.randomUUID();
  const groups = category ? TEST_SUITE.filter((g) => g.category === category) : TEST_SUITE;
  const rows = [];

  for (const group of groups) {
    for (const test of group.tests) {
      const result = await runOne(test);
      rows.push({
        testKey: testKeyFor(group.category, test.name),
        category: group.category,
        name: test.name,
        method: test.method,
        endpoint: test.endpoint,
        expectedStatus: test.expectedStatus,
        ...result
      });
    }
  }

  await AdminTestRun.recordBatch(runBatch, runBy, rows);

  return {
    runBatch,
    total: rows.length,
    passed: rows.filter((r) => r.passed).length
  };
}

module.exports = { runSuite };
