#!/usr/bin/env node
'use strict';

/**
 * Bring `post_categories` into line with `config/community.js`.
 *
 * The category tree is DERIVED from the cloud families, so it changes when the code
 * changes, not when someone edits a row. That makes syncing it a deploy step rather than
 * data entry — which is why it runs from `npm start` next to the migrations, and why it is
 * idempotent: names and descriptions are updated in place, and a category that disappears
 * from the config is DEACTIVATED rather than deleted, because posts point at it.
 */
const { promisePool, pool } = require('../config/database');
const { seedCategories } = require('../config/community');

async function sync() {
  const wanted = seedCategories();

  const values = wanted.map((c) => [c.slug, c.name, c.description || null, c.familySlug || null, c.icon, c.sortOrder]);
  await promisePool.query(
    `INSERT INTO post_categories (slug, name, description, family_slug, icon, sort_order)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       description = VALUES(description),
       family_slug = VALUES(family_slug),
       icon = VALUES(icon),
       sort_order = VALUES(sort_order),
       is_active = 1`,
    [values]
  );

  const slugs = wanted.map((c) => c.slug);
  const [result] = await promisePool.query('UPDATE post_categories SET is_active = 0 WHERE slug NOT IN (?)', [slugs]);

  console.log(`Categories synced: ${wanted.length} active${result.changedRows ? `, ${result.changedRows} deactivated` : ''}.`);
}

if (require.main === module) {
  sync()
    .then(() => pool.end(() => process.exit(0)))
    .catch((err) => {
      console.error(`Category sync failed: ${err.message}`);
      pool.end(() => process.exit(1));
    });
}

module.exports = { sync };
