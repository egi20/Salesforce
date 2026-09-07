'use strict';

const fs = require('fs');
const path = require('path');
const { splitStatements, migrationFiles } = require('../../scripts/migrate');

describe('SQL statement splitter', () => {
  it('splits on real statement boundaries', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('ignores a semicolon inside a string literal', () => {
    const out = splitStatements("CREATE TABLE a (x VARCHAR(10) DEFAULT ';'); SELECT 1;");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("DEFAULT ';'");
  });

  it('ignores line and block comments', () => {
    const out = splitStatements('-- a; comment\n# another; one\n/* block; */ SELECT 1;');
    expect(out).toEqual(['SELECT 1']);
  });

  it('handles a doubled quote as an escaped quote, not a terminator', () => {
    const out = splitStatements("SELECT 'it''s fine; really';");
    expect(out).toHaveLength(1);
  });

  it('keeps a trailing statement without a semicolon', () => {
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('returns nothing for a comment-only file', () => {
    expect(splitStatements('-- nothing here\n')).toEqual([]);
  });
});

describe('migration files', () => {
  const files = migrationFiles();

  it('exist and are numbered', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/^\d{3}_[a-z_]+\.sql$/);
  });

  it('sort into their intended apply order', () => {
    expect([...files].sort()).toEqual(files);
  });

  it('each parse into at least one statement', () => {
    for (const f of files) {
      const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'migrations', f), 'utf8');
      expect(splitStatements(sql).length).toBeGreaterThan(0);
    }
  });

  it('declare users.created_at without ON UPDATE, so a registration date is immutable', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'migrations', '001_identity.sql'), 'utf8');
    const createdAt = sql.split('\n').find((line) => line.trim().startsWith('created_at') && sql.indexOf(line) < sql.indexOf('CREATE TABLE sessions'));
    expect(createdAt).toBeDefined();
    expect(createdAt).not.toContain('ON UPDATE');
  });
});
