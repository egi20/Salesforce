'use strict';

const fs = require('fs');
const path = require('path');
// js-yaml arrives with ESLint, a dev dependency, so it is present wherever the suite runs.
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const blueprint = yaml.load(fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8'));
const byName = (name) => blueprint.services.find((s) => s.name === name);
const envOf = (service) => Object.fromEntries(service.envVars.map((v) => [v.key, v]));

/*
 * WHY THIS FILE EXISTS.
 *
 * The Blueprint is the production configuration, and nothing else exercises it until the
 * day somebody clicks Apply. These hold the parts that fail silently or late: the app and
 * the database agreeing on a name, no secret written into a committed file, and the health
 * check pointing at a route that exists.
 */
describe('render.yaml', () => {
  const db = byName('sforcehub-mysql');
  const web = byName('sforcehub');

  test('the database is a private service with a disk, so it has no public address', () => {
    expect(db.type).toBe('pserv');
    expect(db.disk.mountPath).toBe('/var/lib/mysql');
  });

  test('the app and the database agree on the database, the user and the password', () => {
    const dbEnv = envOf(db);
    const webEnv = envOf(web);
    expect(webEnv.DB_NAME.value).toBe(dbEnv.MYSQL_DATABASE.value);
    expect(webEnv.DB_USER.value).toBe(dbEnv.MYSQL_USER.value);
    expect(webEnv.DB_PASSWORD.fromService).toMatchObject({ name: db.name, envVarKey: 'MYSQL_PASSWORD' });
    expect(webEnv.DB_HOST.fromService).toMatchObject({ name: db.name, property: 'host' });
  });

  test('no secret is written into the file', () => {
    for (const service of blueprint.services) {
      for (const v of service.envVars) {
        if (/PASSWORD|SECRET|_KEY$/.test(v.key)) expect(v.value).toBeUndefined();
      }
    }
    expect(envOf(web).SESSION_SECRET.generateValue).toBe(true);
  });

  test('the health check is a route the app serves', () => {
    const routes = fs.readFileSync(path.join(ROOT, 'routes', 'index.js'), 'utf8');
    expect(routes).toContain(`router.get('${web.healthCheckPath}'`);
  });

  test('the app waits for the database before it migrates', () => {
    expect(web.dockerCommand).toMatch(/wait-for-db.*&&.*npm start/);
  });
});
