'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

const AppSetting = require('../../models/AppSetting');
const { registrationOpen, communityWritable } = require('../../middleware/settingsGates');
const { notFound, errorHandler } = require('../../middleware/errorHandler');

/**
 * The two operational switches, over real HTTP.
 *
 * They are middleware rather than a check inside each handler precisely so that turning
 * one off closes every door at once — so what is worth pinning is the answer SHAPE, which
 * has to match how every other failed guard in this app behaves: a redirect for a
 * top-level navigation, JSON for a background fetch.
 */
function buildApp(gate) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use(express.urlencoded({ extended: true }));

  const flashed = [];
  app.use((req, res, next) => {
    req.session = {};
    req.flash = (type, message) => flashed.push({ type, message });
    res.locals.appName = 'Salesforce Hub';
    res.locals.supportEmail = 'support@example.com';
    res.locals.currentUser = null;
    res.locals.currentPath = req.path;
    res.locals.csrfToken = 'token';
    res.locals.assistantEnabled = false;
    res.locals.assistantMaxChars = 2000;
    res.locals.flash = { success: [], error: [], info: [] };
    res.locals.seo = {
      title: 't', description: 'd', canonical: 'http://x/', ogImage: 'http://x/o.png', indexable: false
    };
    next();
  });

  app.post('/gated', gate, (req, res) => res.json({ reached: true }));
  app.use(notFound);
  app.use(errorHandler);
  app.locals.flashed = flashed;
  return app;
}

describe('the registration switch', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    AppSetting.clearSettingsCache();
  });

  it('lets the request through while registration is open', async () => {
    jest.spyOn(AppSetting, 'get').mockResolvedValue(true);
    const res = await request(buildApp(registrationOpen)).post('/gated');
    expect(res.body).toEqual({ reached: true });
  });

  it('refuses a background fetch with 403 JSON when it is closed', async () => {
    jest.spyOn(AppSetting, 'get').mockResolvedValue(false);
    const res = await request(buildApp(registrationOpen))
      .post('/gated')
      .set('Sec-Fetch-Dest', 'empty');

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/closed/i);
  });

  it('refuses a top-level navigation with a redirect, not a JSON body', async () => {
    // A person who followed a link gets a page and a message, not a raw 403 payload.
    jest.spyOn(AppSetting, 'get').mockResolvedValue(false);
    const res = await request(buildApp(registrationOpen))
      .post('/gated')
      .set('Sec-Fetch-Dest', 'document');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});

describe('the community read-only switch', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    AppSetting.clearSettingsCache();
  });

  it('lets writes through while the community is open', async () => {
    jest.spyOn(AppSetting, 'get').mockResolvedValue(false);
    const res = await request(buildApp(communityWritable)).post('/gated');
    expect(res.body).toEqual({ reached: true });
  });

  it('refuses a write when it is read-only, and says reading still works', async () => {
    jest.spyOn(AppSetting, 'get').mockResolvedValue(true);
    const res = await request(buildApp(communityWritable))
      .post('/gated')
      .set('Sec-Fetch-Dest', 'empty');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/still read/i);
  });
});

describe('an unreadable settings table', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    AppSetting.clearSettingsCache();
  });

  it('falls back to the declared defaults rather than breaking every page', async () => {
    // The site notice is read on nearly every request. A hiccup in a table holding three
    // rows must not be able to take the whole site down, so `all()` swallows and defaults.
    const { promisePool } = require('../../config/database');
    jest.spyOn(promisePool, 'query').mockRejectedValue(new Error('connect ECONNREFUSED'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const values = await AppSetting.all();
    expect(values.registration_open).toBe(true);
    expect(values.community_read_only).toBe(false);
    expect(values.site_notice).toBe('');
  });
});
