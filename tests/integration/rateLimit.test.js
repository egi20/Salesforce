'use strict';

const express = require('express');
const request = require('supertest');

const { ipLimiter, globalLimiter } = require('../../middleware/rateLimit');

/**
 * The two limiters, and the difference between them.
 *
 * On an endpoint that costs money per request this is not a detail: a per-IP limiter
 * bounds one visitor, and five hundred visitors each staying politely under it still
 * produce five hundred times that many paid calls. Only a counter that ignores the IP
 * sees the aggregate — which is the whole reason `globalLimiter` exists and why its
 * keyGenerator deliberately returns a constant.
 */
function appWith(limiter) {
  const app = express();
  /*
   * Without this, `req.ip` is the socket address for every request and X-Forwarded-For is
   * ignored — so a per-IP limiter behind a proxy would put the whole internet in ONE
   * bucket. server.js sets the same thing in production, and it is the reason the setting
   * is not optional there.
   */
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    req.flash = () => {};
    next();
  });
  app.use(limiter);
  app.get('/x', (req, res) => res.json({ ok: true }));
  return app;
}

async function hit(app, ip) {
  const res = await request(app)
    .get('/x')
    .set('Sec-Fetch-Dest', 'empty')
    .set('Accept', 'application/json')
    .set('X-Forwarded-For', ip);
  return res.status;
}

describe('the process-wide backstop limiter', () => {
  it('counts requests from DIFFERENT addresses into the same bucket', async () => {
    const app = appWith(globalLimiter({ windowMs: 60000, max: 3, message: 'busy' }));

    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      // A fresh address every time — exactly the distributed flood a per-IP limiter
      // waves through.
      // eslint-disable-next-line no-await-in-loop
      statuses.push(await hit(app, `10.0.0.${i}`));
    }

    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('answers JSON, because the only caller is a widget', async () => {
    const app = appWith(globalLimiter({ windowMs: 60000, max: 1, message: 'busy' }));
    await hit(app, '10.0.0.1');
    const res = await request(app).get('/x').set('X-Forwarded-For', '10.0.0.2');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ success: false, error: 'busy' });
  });
});

describe('the per-IP limiter', () => {
  it('does NOT count separate addresses together', async () => {
    // The contrast that justifies having both. Each address gets its own allowance.
    const app = appWith(ipLimiter({ windowMs: 60000, max: 1, message: 'slow down' }));

    expect(await hit(app, '10.0.0.1')).toBe(200);
    expect(await hit(app, '10.0.0.1')).toBe(429);
    expect(await hit(app, '10.0.0.2')).toBe(200);
  });
});
