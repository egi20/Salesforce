'use strict';

const { format } = require('util');

/**
 * One-time messages carried in the session across a redirect: `req.flash(type, msg)` adds,
 * `req.flash(type)` reads and clears one type, `req.flash()` reads and clears them all.
 *
 * This replaces `connect-flash` 0.1.1 with the same interface. That package was last released
 * in 2013 and calls `util.isArray`, which Node 24 deprecates at runtime (DEP0044) — the first
 * sign-in on every fresh process printed a deprecation warning into the production log, and a
 * later Node is free to remove the function outright. Twenty lines we own are cheaper than a
 * dependency nobody maintains.
 */
function flash() {
  return function flashMiddleware(req, res, next) {
    if (!req.flash) req.flash = readOrAdd;
    next();
  };
}

function readOrAdd(type, msg, ...rest) {
  if (this.session === undefined) throw new Error('req.flash() requires sessions');
  const store = (this.session.flash = this.session.flash || {});

  if (type && msg !== undefined && msg !== null && msg !== '') {
    const list = (store[type] = store[type] || []);
    if (rest.length) list.push(format(msg, ...rest));
    else if (Array.isArray(msg)) list.push(...msg);
    else list.push(msg);
    return list.length;
  }
  if (type) {
    const list = store[type] || [];
    delete store[type];
    return list;
  }
  this.session.flash = {};
  return store;
}

module.exports = flash;
