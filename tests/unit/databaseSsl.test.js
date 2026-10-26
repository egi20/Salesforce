'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/*
 * WHY THIS FILE EXISTS.
 *
 * A managed MySQL refuses a plain connection, so production on one needs TLS — and TLS
 * that skips verification is encryption to whoever answered. These hold the two halves:
 * the certificate is always checked, and EVERY connection site carries the setting, since
 * a migration runner that connects in plain text fails on the first deploy while the
 * application itself would have worked.
 */
function configWith(env) {
  const saved = { ...process.env };
  Object.assign(process.env, { DB_SSL: '', DB_SSL_CA: '' }, env);
  let config;
  jest.isolateModules(() => { config = require('../../config/config'); });
  process.env = saved;
  return config;
}

describe('database TLS', () => {
  test('is off unless DB_SSL is exactly true', () => {
    expect(configWith({}).database.ssl).toBeNull();
    expect(configWith({ DB_SSL: '1' }).database.ssl).toBeNull();
    expect(configWith({ DB_SSL: 'yes' }).database.ssl).toBeNull();
  });

  test('always verifies the server certificate', () => {
    expect(configWith({ DB_SSL: 'true' }).database.ssl).toEqual({ rejectUnauthorized: true });
    expect(configWith({ DB_SSL: 'TRUE', DB_SSL_CA: 'x' }).database.ssl.rejectUnauthorized).toBe(true);
  });

  test('turns a one-line CA back into PEM', () => {
    const ssl = configWith({ DB_SSL: 'true', DB_SSL_CA: '-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----' }).database.ssl;
    expect(ssl.ca).toBe('-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----');
  });

  test('there is no way to switch verification off', () => {
    const source = fs.readFileSync(path.join(ROOT, 'config', 'config.js'), 'utf8');
    expect(source).not.toMatch(/rejectUnauthorized:\s*false/);
  });

  test('every place that opens a connection passes it', () => {
    for (const file of ['config/database.js', 'scripts/migrate.js', 'scripts/wait-for-db.js', 'scripts/create-database.js']) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).toMatch(/ssl/);
    }
  });
});
