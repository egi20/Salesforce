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
const { assertAdvisoryIntegrity } = require('./config/taxAdvisory');
const { assertChallengeIntegrity } = require('./config/challenges');
const { assertCrmIntegrity } = require('./config/crm');
const { EMBED_HOSTS } = require('./utils/videoEmbed');
const { assertEstimationIntegrity } = require('./config/estimation');
const { assertCommunityIntegrity } = require('./config/community');
const { seoLocals } = require('./config/seoMeta');
const { assertPaymentIntegrity, WEBHOOK_PATH } = require('./config/payments');
const assistantConfig = require('./config/assistant');
const { assertSettingsIntegrity } = require('./config/settings');
const { assertReferralIntegrity } = require('./config/referrals');
const { assertLinkedInIntegrity, isConfigured: linkedInConfigured } = require('./config/linkedin');
const { assertDraftingIntegrity } = require('./config/drafting');
const { assertCompanyTemplateIntegrity } = require('./config/companyTemplates');
const { assertFinanceIntegrity } = require('./config/finance');
const legal = require('./config/legal');
const { assertIssueIntegrity } = require('./config/issues');
const { assertPlacementIntegrity } = require('./config/placements');
const { assertTestSuiteIntegrity } = require('./config/adminTests');
const AppSetting = require('./models/AppSetting');
const { validateActiveAccount } = require('./middleware/auth');
const { csrfProtection } = require('./middleware/csrf');
const { notFound, errorHandler, asyncHandler } = require('./middleware/errorHandler');
const { visitGeo } = require('./middleware/visitGeo');
const { sanitizeRichText, toPlainText, jsonForScript } = require('./utils/sanitize');
const { roleLabel } = require('./config/roleTaxonomy');
const { moduleLabel, familyLabel } = require('./config/cloudFamilies');

// Fail fast rather than degrade silently: a taxonomy with a slug that has no base rate
// or no label produces a UI that half-works and rate buckets that quietly flatten.
assertTaxonomyIntegrity();
assertAdvisoryIntegrity();
// And for the challenge bank: a question whose answer index is outside its options is a
// question nobody can get right, and it would only show up as a puzzled member.
assertChallengeIntegrity();
// And the CRM pipeline: every non-terminal status must reach `unsubscribed` in one step,
// because somebody asking to be left alone should never depend on where the board is.
assertCrmIntegrity();
// Same reasoning: phase and resource percentages that do not sum to 100 shift every
// estimate by a silent few per cent rather than failing visibly.
assertEstimationIntegrity();
assertCommunityIntegrity();
// And again for money: a product with no resolver, or a deposit floor above its cap, is
// a silently wrong charge rather than a visible failure.
assertPaymentIntegrity();
// And for the one feature that spends money per request: a negative cap or a non-numeric
// price does not fail at request time, it fails as an invoice at the end of the month.
assistantConfig.assertAssistantIntegrity();
assertSettingsIntegrity();
// And for the scheme that owes people money: a rate above its own ceiling, or a payout
// floor no commission can reach, fails as a person asking why they have not been paid.
assertReferralIntegrity();
// Half-configured is worse than absent: the button appears, the member is sent to
// LinkedIn, and the failure lands after they have already granted access.
assertLinkedInIntegrity();
// And for the one feature that writes into a client-facing document: a section with no
// stated boundary is a section whose prompt does not say what it must not write.
assertDraftingIntegrity();
// A brandable key that is not actually a document colour would be configuration a company
// can set and no document reads — and the Hub's own defaults must pass the contrast rule
// a company's colour has to pass.
assertCompanyTemplateIntegrity();
// The invoice lifecycle, and the line arithmetic with it. A status nothing can reach is a
// dead branch; a rounding change is an invoice whose printed total stops equalling the sum
// of its printed lines, which is the one figure a customer actually checks.
assertFinanceIntegrity();
// Warned about, never thrown: a privacy policy that cannot name who is responsible for
// personal data is a legal problem, not a broken application, and refusing to boot would
// take a running site down over a text field. It is loud here and repeated on the page.
// Same rule the CRM pipeline is asserted under: every non-terminal status must reach the
// terminal one in ONE step, because the step somebody skips is the one that closes it.
assertIssueIntegrity();
// The placement fee arithmetic, with the case that exposes the reference's rounding bug:
// €47,350.00 at 15.00% is €7,102.50, and their checkout charges €7,103.00.
assertPlacementIntegrity();
assertTestSuiteIntegrity();
legal.warnIfUnconfigured();

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
        // No CDN is allowed at all: every script, style and font is served from this
        // origin. Adding a host back here means adding a third party to every page.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        // No third-party host. DESIGN.md and CLAUDE.md both say the CSP allows no CDN,
        // and until Inter was self-hosted these two lines made that untrue.
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        // Video embeds on success stories, and NOTHING else. The two hosts are shared from
        // `utils/videoEmbed.js`, which is also the only thing that can produce an embed
        // URL — so the policy and the allowlist can never drift apart, the same way
        // WEBHOOK_PATH is shared between server.js and config/payments.js.
        //
        // Without this the iframe is silently blocked by `default-src 'self'`, which looks
        // like a broken story rather than a policy decision.
        frameSrc: ["'self'", ...EMBED_HOSTS],
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

/*
 * The Stripe webhook needs the RAW bytes, and it needs them BEFORE any JSON parser sees
 * the stream. Stripe's signature covers exactly what it sent; a body that has been
 * parsed and re-serialised will not verify, however identical it looks.
 *
 * Mounting the raw parser first also disarms the JSON parser below for this one path:
 * body-parser marks the request as read and every later parser skips it.
 */
app.use(WEBHOOK_PATH, express.raw({ type: 'application/json', limit: '1mb' }));

// 5 MB rather than the 100 kB default: long rich-text bodies were being rejected with a
// bare 413 that gave the author no way to recover their draft.
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));
app.use(bodyParser.json({ limit: '5mb' }));

/*
 * Bootstrap and Bootstrap Icons are served from node_modules rather than a CDN.
 *
 * A CDN adds a third party to every page load: the app stops working behind a corporate
 * proxy that blocks it, the version can move under you, and the CSP has to allow a host
 * that also serves everybody else's code. Serving the pinned files from the same origin
 * removes all three, and the icon font resolves relative to its own stylesheet so it comes
 * along without extra configuration.
 */
app.use(
  '/vendor/bootstrap',
  express.static(path.join(__dirname, 'node_modules', 'bootstrap', 'dist'), {
    maxAge: '30d',
    immutable: config.isProduction
  })
);
// Inter, for the same reason and in the same way as Bootstrap. See public/css/inter.css:
// this used to come from fonts.googleapis.com, and the request failed behind a proxy.
app.use(
  '/vendor/inter',
  express.static(path.join(__dirname, 'node_modules', '@fontsource', 'inter'), {
    maxAge: '30d',
    immutable: config.isProduction
  })
);
app.use(
  '/vendor/bootstrap-icons',
  express.static(path.join(__dirname, 'node_modules', 'bootstrap-icons', 'font'), {
    maxAge: '30d',
    immutable: config.isProduction
  })
);

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
/*
 * The webhook is the one exempt route, and it is exempt through the predicate rather than
 * by being mounted outside the middleware — which is the difference between a documented
 * hole and an accidental one. It authenticates itself with a Stripe signature over the
 * raw body, which is a stronger check than a token it could not carry anyway: it has no
 * browser, no session and no page to read a token from.
 */
app.use(csrfProtection({ exempt: (req) => req.path === WEBHOOK_PATH }));
app.use(validateActiveAccount);
app.use(visitGeo);
app.use(seoLocals);

/*
 * The site-wide notice.
 *
 * Read from a process cache, not the database, on all but roughly one request a minute —
 * a banner nobody has set must not cost a query per page. `AppSetting.all()` falls back to
 * the declared defaults rather than throwing, so a settings table that is briefly
 * unreadable cannot take down every page on the site.
 */
app.use(
  asyncHandler(async (req, res, next) => {
    res.locals.siteNotice = await AppSetting.get('site_notice');
    next();
  })
);

// Locals every template can rely on.
app.use((req, res, next) => {
  res.locals.appName = config.app.name;
  res.locals.supportEmail = config.app.supportEmail;
  // Decided once per request from the configuration, never from anything the client sends.
  res.locals.assistantEnabled = assistantConfig.isConfigured();
  res.locals.linkedInEnabled = linkedInConfigured();
  res.locals.assistantMaxChars = assistantConfig.MAX_MESSAGE_CHARS;
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
app.use('/community', require('./routes/community'));
app.use('/jobs', require('./routes/jobs'));
app.use('/applications', require('./routes/applications'));
app.use('/quotes', require('./routes/quotes'));
app.use('/rates', require('./routes/rates'));
app.use('/payments', require('./routes/payments'));
app.use('/assistant', require('./routes/assistant'));
app.use('/referrals', require('./routes/referrals'));
app.use('/linkedin', require('./routes/linkedin'));
app.use('/search', require('./routes/search'));
app.use('/tax-advisory', require('./routes/tax'));
app.use('/challenges', require('./routes/challenges'));
app.use('/recruiters', require('./routes/recruiters'));
app.use('/success-stories', require('./routes/stories'));
app.use('/messages', require('./routes/messages'));
app.use('/notifications', require('./routes/notifications'));
app.use('/crm', require('./routes/crm'));
// Before `/admin`, so this router answers its own paths rather than falling through to the
// admin router's 404.
app.use('/admin/finance', require('./routes/finance'));
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
