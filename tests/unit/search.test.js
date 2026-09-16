'use strict';

const { escapeLike, containsPattern } = require('../../utils/likePattern');
const search = require('../../services/search');
const Job = require('../../models/Job');
const Post = require('../../models/Post');
const ConsultantProfile = require('../../models/ConsultantProfile');

/**
 * Search across everything.
 *
 * Two properties carry the whole feature, and both are about what search does NOT do: it
 * adds no filter builder of its own, and it invents no cross-type relevance score.
 */
describe('LIKE patterns', () => {
  it('escapes the wildcards, so a search for a literal percent finds one', () => {
    // "50%" was being turned into "50 followed by anything" — a different question with a
    // different answer, in every list view in the application.
    expect(containsPattern('50%')).toBe('%50\\%%');
    expect(containsPattern('a_b')).toBe('%a\\_b%');
  });

  it('escapes the escape character FIRST', () => {
    // Escaping the backslash after the wildcards would escape the escapes and produce a
    // pattern that means something else again.
    expect(escapeLike('\\%')).toBe('\\\\\\%');
  });

  it('stops a bare wildcard becoming a full table scan', () => {
    // "%" became "%%%", which matches every row. On one list view that is a slow page; on
    // a box that asks four builders at once it is a free scan of the database.
    expect(containsPattern('%')).toBe('%\\%%');
    expect(containsPattern('%%%')).toBe('%\\%\\%\\%%');
  });

  it('trims, so a padded query is the same query', () => {
    expect(containsPattern('  apex  ')).toBe('%apex%');
  });

  it('survives values that are not strings', () => {
    for (const value of [null, undefined, 42, {}]) {
      expect(typeof containsPattern(value)).toBe('string');
    }
  });
});

describe('every builder escapes its query', () => {
  it.each([
    ['jobs', Job],
    ['posts', Post],
    ['consultants', ConsultantProfile]
  ])('%s', (_label, model) => {
    const { clause, params } = model.buildFilter({ q: '50%_x' });

    for (const param of params) {
      if (typeof param === 'string' && param.includes('%')) {
        // Only the pattern's own leading and trailing wildcards survive unescaped.
        expect(param).toBe('%50\\%\\_x%');
      }
    }
    // And the placeholders still line up, which an escaping change is exactly the kind of
    // edit to break.
    expect((clause.match(/\?/g) || []).length).toBe(params.length);
  });
});

describe('query handling', () => {
  it('collapses whitespace so one query is one query', () => {
    expect(search.normaliseQuery('  apex   developer  ')).toBe('apex developer');
    expect(search.normaliseQuery('apex\n\tdeveloper')).toBe('apex developer');
  });

  it('bounds the length rather than building a pattern from a kilobyte of text', () => {
    expect(search.normaliseQuery('x'.repeat(5000)).length).toBe(120);
  });

  it('refuses a query too short to mean anything', () => {
    // A one-character LIKE matches most of the corpus and tells the reader nothing.
    expect(search.isUsableQuery('a')).toBe(false);
    expect(search.isUsableQuery('')).toBe(false);
    expect(search.isUsableQuery('ap')).toBe(true);
  });

  it('answers without querying anything when the query is unusable', async () => {
    const result = await search.searchEverything('a');
    expect(result.usable).toBe(false);
    expect(result.groups).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('handles a missing query at all', async () => {
    for (const raw of [undefined, null, '', '   ']) {
      // eslint-disable-next-line no-await-in-loop
      const result = await search.searchEverything(raw);
      expect(result.usable).toBe(false);
      expect(result.query).toBe('');
    }
  });
});

/**
 * The code, with its comments removed.
 *
 * These assertions are about what the module DOES, and the prose explaining why it does
 * not build SQL necessarily contains the words "SELECT" and "WHERE". Scanning the raw file
 * made the documentation fail the test it documents.
 */
function codeOf(modulePath) {
  return require('fs')
    .readFileSync(require.resolve(modulePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the sources', () => {
  it('adds no filter builder of its own', () => {
    /*
     * The security argument. Every source calls the same `browse` its list view calls, so
     * a row invisible on /jobs is invisible here without this service knowing why. A
     * search page assembling its own WHERE clause would be a second place that has to
     * remember is_public, status = 'open' and hidden_at IS NULL — and the first one to
     * forget is the one that leaks.
     */
    expect(codeOf('../../services/search.js')).not.toMatch(/\bSELECT\b|\bWHERE\b|buildFilter|promisePool/);
  });

  it('passes no status, visibility or moderation override to any source', () => {
    // The defaults are what make the result safe; overriding one here would be the leak.
    expect(codeOf('../../services/search.js')).not.toMatch(/include_hidden|is_public|status:/);
  });

  it('covers each public area exactly once', () => {
    // `recruiters` joined when the agency directory was built. Every entry here is a
    // browsable area with its own list view, and each calls that view's own builder.
    expect(search.SOURCES.map((s) => s.key)).toEqual([
      'jobs', 'consultants', 'companies', 'recruiters', 'community'
    ]);
  });

  it('points "see all" at the same filter, expressed in that page\'s own query string', () => {
    // So the count promised here is the count that page delivers — which is only true
    // because both came from the same builder.
    for (const source of search.SOURCES) {
      expect(source.href('apex dev')).toMatch(/\?q=apex%20dev$/);
    }
  });

  it('keeps each preview short, because the page is previews plus a link', () => {
    expect(search.PREVIEW_LIMIT).toBeGreaterThan(0);
    expect(search.PREVIEW_LIMIT).toBeLessThanOrEqual(10);
  });
});

describe('when a source fails', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the other three rather than failing the page', async () => {
    /*
     * An incomplete answer, honestly labelled, beats a search box that goes down entirely
     * because one table is locked.
     */
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(Job, 'browse').mockRejectedValue(new Error('connect ECONNREFUSED'));
    jest.spyOn(ConsultantProfile, 'browse').mockResolvedValue({ rows: [{ user_id: 1 }], total: 1 });
    jest.spyOn(require('../../models/CompanyProfile'), 'browse').mockResolvedValue({ rows: [], total: 0 });
    jest.spyOn(Post, 'browse').mockResolvedValue({ rows: [], total: 0 });

    const result = await search.searchEverything('apex');
    const jobs = result.groups.find((g) => g.key === 'jobs');
    const consultants = result.groups.find((g) => g.key === 'consultants');

    expect(jobs.failed).toBe(true);
    expect(jobs.rows).toEqual([]);
    expect(consultants.failed).toBe(false);
    expect(consultants.total).toBe(1);
    // The failed source contributes nothing to the total rather than a guess.
    expect(result.total).toBe(1);
  });

  it('reports a failure rather than showing it as "no results"', async () => {
    // Those are different claims, and quietly showing the second is a lie.
    jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const model of [Job, ConsultantProfile, require('../../models/CompanyProfile'), Post]) {
      jest.spyOn(model, 'browse').mockRejectedValue(new Error('down'));
    }

    const result = await search.searchEverything('apex');
    expect(result.groups.every((g) => g.failed)).toBe(true);
    expect(result.total).toBe(0);
  });
});

describe('what search does not do', () => {
  it('produces no cross-type relevance score', () => {
    /*
     * A LIKE match on a company name and a LIKE match inside a five-thousand-word post
     * are not comparable. A blended ranking would be a number invented to look
     * authoritative, which is the same instinct the rate index refuses when it suppresses
     * a bucket rather than interpolating one.
     */
    expect(codeOf('../../services/search.js')).not.toMatch(/score|\brank\b|weight|relevanceOf/i);
  });
});
