'use strict';

const { levelFor, LEVELS, POINT_AWARDS, seedCategories, communityProblems, isPostKind, postKind, POST_KIND_VALUES } =
  require('../../config/community');
const Post = require('../../models/Post');

describe('community configuration', () => {
  it('is internally consistent, so boot will not throw', () => {
    expect(communityProblems()).toEqual([]);
  });

  it('derives a category per cloud family plus the cross-cutting ones', () => {
    const categories = seedCategories();
    const slugs = categories.map((c) => c.slug);

    expect(slugs).toContain('careers');
    expect(slugs).toContain('sales-cloud');
    expect(new Set(slugs).size).toBe(slugs.length);
    // Cloud categories carry the family so the community and the job board agree.
    expect(categories.find((c) => c.slug === 'sales-cloud').familySlug).toBe('sales-cloud');
    expect(categories.find((c) => c.slug === 'careers').familySlug).toBeNull();
  });

  it('pays more for an accepted answer than for several posts', () => {
    expect(POINT_AWARDS.reply_accepted.points).toBeGreaterThan(POINT_AWARDS.post_created.points * 4);
  });
});

describe('post kinds', () => {
  it('recognises exactly the four kinds', () => {
    expect(POST_KIND_VALUES.sort()).toEqual(['article', 'discussion', 'question', 'win']);
  });

  it('rejects an unknown kind', () => {
    expect(isPostKind('rant')).toBe(false);
    expect(isPostKind('')).toBe(false);
    expect(isPostKind(undefined)).toBe(false);
  });

  it('marks only questions as solvable', () => {
    expect(postKind('question').solvable).toBe(true);
    for (const kind of ['article', 'discussion', 'win']) {
      expect(postKind(kind).solvable).toBe(false);
    }
  });

  it('falls back to a real kind rather than returning undefined', () => {
    expect(postKind('nonsense')).toHaveProperty('value');
    expect(POST_KIND_VALUES).toContain(postKind('nonsense').value);
  });
});

describe('levels', () => {
  it('starts everyone at level 1', () => {
    expect(levelFor(0).level).toBe(1);
    expect(levelFor(0).progressPercent).toBe(0);
  });

  it('resolves any total, including a negative one from a reversal', () => {
    for (const points of [-100, -1, 0, 1, 49, 50, 349, 350, 1999, 2000, 999999]) {
      const standing = levelFor(points);
      expect(standing.level).toBeGreaterThanOrEqual(1);
      expect(standing.progressPercent).toBeGreaterThanOrEqual(0);
      expect(standing.progressPercent).toBeLessThanOrEqual(100);
    }
  });

  it('promotes exactly at the threshold, not after it', () => {
    const second = LEVELS[1];
    expect(levelFor(second.from - 1).level).toBe(1);
    expect(levelFor(second.from).level).toBe(2);
  });

  it('measures progress through the current band, not towards the last level', () => {
    // Halfway between level 2 and level 3 should read as roughly half, not as a
    // fraction of the whole scale.
    const midpoint = Math.round((LEVELS[1].from + LEVELS[2].from) / 2);
    expect(levelFor(midpoint).progressPercent).toBeGreaterThan(40);
    expect(levelFor(midpoint).progressPercent).toBeLessThan(60);
  });

  it('reports the top level as complete with nothing left to earn', () => {
    const top = LEVELS[LEVELS.length - 1];
    const standing = levelFor(top.from + 5000);
    expect(standing.level).toBe(top.level);
    expect(standing.nextLevel).toBeNull();
    expect(standing.pointsToNext).toBe(0);
    expect(standing.progressPercent).toBe(100);
  });

  it('has strictly increasing thresholds', () => {
    for (let i = 1; i < LEVELS.length; i += 1) {
      expect(LEVELS[i].from).toBeGreaterThan(LEVELS[i - 1].from);
    }
  });
});

describe('the single post filter builder', () => {
  it('matches everything by default rather than producing invalid SQL', () => {
    const { clause, params } = Post.buildFilter({});
    expect(clause).toBe('1 = 1');
    expect(params).toEqual([]);
  });

  it('drops a kind that is not in the taxonomy', () => {
    expect(Post.buildFilter({ kind: 'rant' }).clause).toBe('1 = 1');
    expect(Post.buildFilter({ kind: 'question' }).clause).toContain('p.kind = ?');
  });

  it('parameterises user input', () => {
    const { clause, params } = Post.buildFilter({ q: "'; DROP TABLE posts; --" });
    expect(clause).not.toContain('DROP TABLE');
    expect(params[0]).toContain('DROP TABLE');
  });

  it('scopes "unanswered" to questions only', () => {
    const { clause } = Post.buildFilter({ unanswered: '1' });
    expect(clause).toContain("p.kind = 'question'");
    expect(clause).toContain('p.reply_count = 0');
  });

  it('produces an identical clause for identical filters, which is what lets the count agree with the list', () => {
    const filters = { kind: 'question', category_slug: 'devops', q: 'deploy' };
    expect(Post.buildFilter(filters)).toEqual(Post.buildFilter({ ...filters }));
  });
});

describe('levels below zero', () => {
  it('does not claim you need points to reach the level you are already on', () => {
    // A total can go negative when awards are reversed. The next level must be the one
    // ABOVE the current band, not the first threshold above the total.
    const standing = levelFor(-100);
    expect(standing.level).toBe(1);
    expect(standing.nextLevel).toBe(2);
    expect(standing.progressPercent).toBe(0);
  });
});
