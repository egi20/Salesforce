'use strict';

const Post = require('../../models/Post');
const Moderation = require('../../models/Moderation');

/**
 * Moderation, at the level that can be tested without a database: the filter builder and
 * the points-key scheme.
 *
 * Both are places where a mistake is silent. A missing `hidden_at IS NULL` shows removed
 * content in a feed; a points key that collides makes a restore fail to give the points
 * back, and neither raises anything.
 */
describe('hidden posts and the one filter builder', () => {
  it('excludes hidden posts by default', () => {
    const { clause } = Post.buildFilter({});
    expect(clause).toMatch(/p\.hidden_at IS NULL/);
  });

  it('excludes them for every filter combination, not just the empty one', () => {
    const combinations = [
      { kind: 'question' },
      { category_slug: 'sales-cloud' },
      { author_user_id: 7 },
      { q: 'apex' },
      { solved: '1' },
      { unanswered: '1' },
      { kind: 'win', q: 'go live', author_user_id: 3 }
    ];
    for (const filters of combinations) {
      expect(Post.buildFilter(filters).clause).toMatch(/p\.hidden_at IS NULL/);
    }
  });

  it('includes them ONLY when a caller explicitly asks', () => {
    // The single opt-in, used by the moderation screens and nothing else.
    expect(Post.buildFilter({ include_hidden: true }).clause).not.toMatch(/hidden_at/);
  });

  it('keeps parameters aligned with the clause when hiding is applied', () => {
    // The hidden condition takes no parameter; a stray placeholder here would shift every
    // subsequent value by one and silently filter on the wrong thing.
    const { clause, params } = Post.buildFilter({ kind: 'question', author_user_id: 7 });
    expect(clause.match(/\?/g) || []).toHaveLength(params.length);
  });

  it('is still a single builder — the count and the list cannot disagree', () => {
    const filters = { kind: 'discussion', q: 'flow' };
    const first = Post.buildFilter(filters);
    const second = Post.buildFilter(filters);
    expect(first.clause).toBe(second.clause);
    expect(first.params).toEqual(second.params);
  });
});

describe('the points key for a moderation action', () => {
  it('is derived from the EVENT, not from the content', () => {
    // This is the whole reason moderation events are inserted first. points_ledger has a
    // unique dedupe_key and every insert is an INSERT IGNORE, so a key derived from the
    // post id would make hide -> restore take the points away once and never give them
    // back: the restore's insert would be silently ignored.
    expect(Moderation.pointsKeyFor(1)).toBe('mod:1');
    expect(Moderation.pointsKeyFor(2)).not.toBe(Moderation.pointsKeyFor(1));
  });

  it('gives every cycle of the same content a distinct key', () => {
    // hide (event 10), restore (11), hide again (12) — three ledger entries, none of them
    // colliding, and the total comes out right however many times a moderator changes
    // their mind.
    const keys = [10, 11, 12].map((id) => Moderation.pointsKeyFor(id));
    expect(new Set(keys).size).toBe(3);
  });

  it('names the subject types it knows about', () => {
    expect(Moderation.SUBJECT_TYPES).toEqual(['post', 'reply', 'rate_submission', 'consultant_profile', 'job']);
  });
});
