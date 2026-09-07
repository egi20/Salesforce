'use strict';

// Requiring any model pulls in config/database, which creates a mysql2 pool. The pool
// does not connect until a query is issued, but it does register a handle that would
// keep Jest alive, so it is closed once the suite finishes.
afterAll(async () => {
  try {
    const { pool } = require('../config/database');
    await new Promise((resolve) => pool.end(resolve));
  } catch {
    // No pool was ever created by this suite.
  }
});
