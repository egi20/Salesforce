'use strict';

require('dotenv').config();

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';

const DEFAULT_SESSION_SECRET = 'change-me-in-production';

/**
 * Central environment -> config object.
 *
 * Carried over from the reference implementation: this module THROWS at boot in
 * production when SESSION_SECRET is missing or still the placeholder. A silently
 * default-signed session cookie in production is a full account-takeover primitive,
 * so failing to start is the correct behaviour.
 */
function required(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (NODE_ENV=${env})`);
  }
  return value;
}

/**
 * TLS to the database, for a managed MySQL that will not accept a plain connection.
 *
 * Off unless DB_SSL is `true`: the bundled docker-compose talks to MySQL over a private
 * network and has no certificate to present. When it is on, the certificate is ALWAYS
 * verified — there is no setting that turns verification off, because an encrypted
 * connection to a server nobody checked is a connection to whoever answered.
 *
 * DB_SSL_CA carries the provider's CA certificate as PEM. A hosting dashboard usually
 * takes a value on one line, so a literal `\n` is turned back into a newline. Without it
 * the system trust store is used, which a provider signing with its own CA will fail —
 * loudly, at the first connection, which is the right way for that mistake to show up.
 */
function databaseSsl() {
  const flag = String(process.env.DB_SSL || '').trim().toLowerCase();
  if (flag !== 'true') return null;
  const ca = process.env.DB_SSL_CA ? process.env.DB_SSL_CA.replace(/\\n/g, '\n') : undefined;
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true };
}

const sessionSecret = process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET;
if (isProduction && sessionSecret === DEFAULT_SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set to a non-default value in production');
}

const config = {
  env,
  isProduction,
  app: {
    name: process.env.APP_NAME || 'Salesforce Hub',
    port: parseInt(process.env.PORT, 10) || 3000,
    baseUrl: (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    supportEmail: process.env.SUPPORT_EMAIL || 'support@example.com'
  },
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'salesforce_hub',
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT, 10) || 10,
    ssl: databaseSsl()
  },
  session: {
    secret: isProduction ? required('SESSION_SECRET', process.env.SESSION_SECRET) : sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      secure: isProduction,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    }
  },
  security: {
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || (isProduction ? 12 : 10),
    // Turnstile is opt-in: unset keys disable the check entirely.
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '',
    turnstileSecretKey: process.env.TURNSTILE_SECRET_KEY || ''
  },
  email: {
    resendApiKey: process.env.RESEND_API_KEY || '',
    from: process.env.EMAIL_FROM || 'Salesforce Hub <noreply@example.com>'
  },
  finance: {
    /*
     * The legal entity that ISSUES the invoices.
     *
     * Environment variables rather than an editable settings row, and the line is the one
     * `config/settings.js` already draws: a setting is an operational switch you change at
     * 2am, and this is not that. An invoice carries a legal entity and a tax number, and a
     * change to either is a deployment-level event that should have an author and a diff —
     * not a form somebody can retype on a screen that also prints the number onto documents
     * already going to customers.
     */
    sellerName: process.env.FINANCE_SELLER_NAME || '',
    sellerAddress: process.env.FINANCE_SELLER_ADDRESS || '',
    sellerTaxId: process.env.FINANCE_SELLER_TAX_ID || '',
    sellerEmail: process.env.FINANCE_SELLER_EMAIL || '',
    sellerIban: process.env.FINANCE_SELLER_IBAN || ''
  },
  taxAdvisory: {
    // Where a new enquiry is announced. Unset means nobody is emailed and the enquiry
    // waits in /admin/tax-advisory — degraded, not broken, the same way email and
    // payments degrade without credentials. It is a plain address rather than a settings
    // row because a lead nobody reads is the failure mode, and that should be a
    // deployment decision with a diff behind it.
    notifyEmail: process.env.TAX_ADVISORY_NOTIFY || ''
  },
  uploads: {
    // Durable bytes live in MySQL. This directory is a scratch cache only and is
    // assumed to be wiped on every deploy.
    tmpDir: process.env.UPLOAD_TMP_DIR || 'uploads',
    maxPhotoBytes: 5 * 1024 * 1024,
    maxDocumentBytes: 10 * 1024 * 1024
  },
  stripe: {
    // Unset keys disable payments entirely rather than half-enabling them: routes offer
    // a "not available" path, and no checkout can be created. See utils/stripe.js.
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || ''
  },
  linkedin: {
    // Both unset disables the integration entirely: no button, and the routes answer
    // "not available". Setting only one of the two fails the boot rather than half-working.
    clientId: process.env.LINKEDIN_CLIENT_ID || '',
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET || ''
  },
  assistant: {
    // Unset key disables the assistant entirely: the widget is not rendered and the
    // endpoint answers 503, the same way payments and email degrade without credentials.
    apiKey: process.env.ANTHROPIC_API_KEY || ''
  },
  rates: {
    // Privacy floor: never publish an aggregate derived from fewer than this many
    // distinct people. Counting people (not submissions) is part of the rule.
    minSampleSize: parseInt(process.env.RATE_MIN_SAMPLE, 10) || 3
  }
};

module.exports = config;
