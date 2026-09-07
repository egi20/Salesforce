'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bodyParser = require('body-parser');
const helmet = require('helmet');
const morgan = require('morgan');
const flash = require('connect-flash');

const config = require('./config/config');
const { pool } = require('./config/database');
const { assertTaxonomyIntegrity } = require('./config/roleTaxonomy');
const { seoLocals } = require('./config/seoMeta');
const { validateActiveAccount } = require('./middleware/auth');
const { csrfProtection } = require('./middleware/csrf');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { visitGeo } = require('./middleware/visitGeo');
const { sanitizeRichText, toPlainText, jsonForScript } = require('./utils/sanitize');
const { roleLabel } = require('./config/roleTaxonomy');
const { moduleLabel, familyLabel } = require('./config/cloudFamilies');

// Fail fast rather than degrade silently: a taxonomy with a slug that has no base rate
// or no label produces a UI that half-works and rate buckets that quietly flatten.
assertTaxonomyIntegrity();

const app = express();

if (config.isProduction) {
  // Required for `req.ip` to be the client rather than the load balancer, which is what
  // every IP-keyed rate limiter depends on.
  app.set('trust proxy', 1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('x-powered-by', false);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-inline' is required by the per-page vanilla-JS islands in the views.
        // 'unsafe-eval' is deliberately NOT allowed: no client code may use eval or
        // new Function, and adding a library that needs it is a decision, not an oversight.
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"]
      }
    },
    hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
    // No referrer at all. CONSEQUENCE, and it is load-bearing: `req.get('Referer')` is
    // empty on real browser POSTs, so "go back to where you came from" must use an
    // explicit allow-listed hidden field, never Referer sniffing.
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false
  })
);

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), browsing-topics=()');
  next();
});

app.use(morgan(config.isProduction ? 'combined' : 'dev'));

// 5 MB rather than the 100 kB default: long rich-text bodies were being rejected with a
// bare 413 that gave the author no way to recover their draft.
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));
app.use(bodyParser.json({ limit: '5mb' }));

app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: config.isProduction ? '7d' : 0,
    etag: true
  })
);

const sessionStore = new MySQLStore(
  {
    // The table is created by a migration, not by the store, so the whole schema stays
    // under migration control.
    createDatabaseTable: false,
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000,
    expiration: config.session.cookie.maxAge,
    schema: {
      tableName: 'sessions',
      columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' }
    }
  },
  pool
);

app.use(
  session({
    key: 'sfhub.sid',
    secret: config.session.secret,
    store: sessionStore,
    resave: config.session.resave,
    saveUninitialized: config.session.saveUninitialized,
    rolling: config.session.rolling,
    cookie: config.session.cookie
  })
);

app.use(flash());
app.use(csrfProtection());
app.use(validateActiveAccount);
app.use(visitGeo);
app.use(seoLocals);

// Locals every template can rely on.
app.use((req, res, next) => {
  res.locals.appName = config.app.name;
  res.locals.currentUser = req.session.user || null;
  res.locals.currentPath = req.path;
  res.locals.query = req.query;
  res.locals.flash = {
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info')
  };
  res.locals.sanitizeRichText = sanitizeRichText;
  res.locals.toPlainText = toPlainText;
  res.locals.jsonForScript = jsonForScript;
  res.locals.roleLabel = roleLabel;
  res.locals.moduleLabel = moduleLabel;
  res.locals.familyLabel = familyLabel;
  next();
});

app.use('/', require('./routes/index'));
app.use('/auth', require('./routes/auth'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/profile', require('./routes/profile'));
app.use('/consultants', require('./routes/consultants'));
app.use('/companies', require('./routes/companies'));
app.use('/jobs', require('./routes/jobs'));
app.use('/applications', require('./routes/applications'));
app.use('/rates', require('./routes/rates'));
app.use('/notifications', require('./routes/notifications'));
app.use('/admin', require('./routes/admin'));

app.use(notFound);
app.use(errorHandler);

if (require.main === module) {
  const server = app.listen(config.app.port, () => {
    console.log(`${config.app.name} listening on port ${config.app.port} (${config.env})`);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down.`);
    server.close(() => {
      pool.end(() => process.exit(0));
    });
    // Do not wait forever for a hung connection to drain.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
