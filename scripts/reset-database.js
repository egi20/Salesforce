#!/usr/bin/env node
'use strict';

/**
 * Drop and recreate the development database. REFUSES TO RUN IN PRODUCTION.
 *
 * `npm run db:reset` is this followed by migrate, sync:categories and seed.
 *
 * It exists because the manual route — `mysql -u root -p -e "DROP DATABASE …"` — needs the
 * mysql client on PATH, and on a Windows machine it usually is not. The DROP then fails,
 * the migrations stop on a table that already exists, and `npm run dev` starts a server on
 * the old schema: every page dies on "Unknown column", which reads like a bug in the code
 * rather than a database three migrations behind. This connects with the same .env the app
 * uses, so it reaches exactly the database the app would.
 *
 * Applied migrations are immutable, so when a branch renames or renumbers one, a database
 * that applied the old file cannot be migrated forward — rebuilding it is the only way, and
 * on a development machine the seed puts everything back.
 */

const mysql = require('mysql2/promise');
const config = require('../config/config');

/*
 * No override flag. `npm run seed` has SEED_ALLOW_PRODUCTION for a staging box that must run
 * with NODE_ENV=production; nothing legitimate needs to drop a production database from an
 * npm script, and a typo in an environment variable must not be one step from doing it.
 */
if (config.isProduction) {
  console.error('Refusing to reset: NODE_ENV is production. This command deletes the whole database.');
  process.exit(1);
}

async function main() {
  const { host, port, user, password, database } = config.database;

  // Identifiers cannot be parameterised, so the name is validated rather than escaped —
  // the same rule scripts/create-database.js applies.
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) {
    throw new Error(`DB_NAME "${database}" is not a valid database name (letters, digits and underscore only).`);
  }

  const connection = await mysql.createConnection({ host, port, user, password });
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`Recreated database "${database}" — empty, ready for migrations.`);
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error(`Could not reset the database: ${err.message}`);
  if (err.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error('Check DB_USER and DB_PASSWORD in .env.');
  }
  if (err.code === 'ECONNREFUSED') {
    console.error(`Nothing is listening on ${config.database.host}:${config.database.port} — is MySQL running?`);
  }
  process.exit(1);
});
