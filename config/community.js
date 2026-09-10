'use strict';

const { CLOUD_FAMILIES } = require('./cloudFamilies');

/**
 * Post kinds.
 *
 * These differ in how they are presented and in what they afford — only a question can be
 * solved, only a win is celebrated — not in what they store. One table with a
 * discriminator; see the comment on `posts` in migration 009.
 */
const POST_KINDS = [
  {
    value: 'question',
    label: 'Question',
    verb: 'Ask a question',
    icon: 'bi-patch-question',
    tone: 'icon-info',
    hint: 'Something you need an answer to. Mark a reply as the solution when you get one.',
    solvable: true
  },
  {
    value: 'discussion',
    label: 'Discussion',
    verb: 'Start a discussion',
    icon: 'bi-chat-square-text',
    tone: 'icon-blue',
    hint: 'An opinion, a trade-off, a question with no single right answer.',
    solvable: false
  },
  {
    value: 'article',
    label: 'Article',
    verb: 'Write an article',
    icon: 'bi-file-earmark-text',
    tone: 'icon-navyblue',
    hint: 'Something you worked out and want to write up properly.',
    solvable: false
  },
  {
    value: 'win',
    label: 'Win',
    verb: 'Share a win',
    icon: 'bi-trophy',
    tone: 'icon-amber',
    hint: 'A go-live, a certification, a contract. Small ones count.',
    solvable: false
  }
];

const POST_KIND_VALUES = POST_KINDS.map((k) => k.value);
const POST_KIND_MAP = new Map(POST_KINDS.map((k) => [k.value, k]));

function isPostKind(value) {
  return POST_KIND_MAP.has(value);
}

function postKind(value) {
  return POST_KIND_MAP.get(value) || POST_KINDS[1];
}

/**
 * The seeded category tree.
 *
 * One category per cloud family, so the community speaks the same vocabulary as the job
 * board and the estimator, plus the cross-cutting ones that belong to no cloud. Derived
 * from `CLOUD_FAMILIES` rather than typed out again — a family added there appears here
 * automatically, which is the rule the whole taxonomy follows.
 */
const CROSS_CUTTING_CATEGORIES = [
  { slug: 'careers', name: 'Careers & rates', description: 'Contracting, day rates, interviews, moving between roles.', icon: 'bi-graph-up-arrow', sortOrder: 10 },
  { slug: 'certification', name: 'Certification', description: 'Exams, study routes, what a credential is actually worth.', icon: 'bi-patch-check', sortOrder: 20 },
  { slug: 'architecture', name: 'Architecture & governance', description: 'Org strategy, sharing models, technical debt, multi-org.', icon: 'bi-diagram-3', sortOrder: 30 },
  { slug: 'devops', name: 'DevOps & release', description: 'Sandboxes, packaging, CI, deployment pain.', icon: 'bi-arrow-repeat', sortOrder: 40 },
  { slug: 'general', name: 'Everything else', description: 'Anything that does not fit above.', icon: 'bi-three-dots', sortOrder: 900 }
];

function seedCategories() {
  const fromFamilies = CLOUD_FAMILIES.map((family, index) => ({
    slug: family.value,
    name: family.label,
    description: `${family.modules.length} modules — implementation, design and gotchas.`,
    familySlug: family.value,
    icon: 'bi-cloud',
    sortOrder: 100 + index
  }));

  return [
    ...CROSS_CUTTING_CATEGORIES.map((c) => ({ ...c, familySlug: null })),
    ...fromFamilies
  ];
}

/**
 * Points.
 *
 * Deliberately small numbers, and deliberately weighted towards being USEFUL rather than
 * being loud: an accepted solution is worth more than five posts. A scheme that pays for
 * volume gets volume.
 *
 * `dedupeKey` is derived per award so the same event can never pay twice.
 */
const POINT_AWARDS = {
  post_created: { points: 5, label: 'Posted' },
  reply_created: { points: 2, label: 'Replied' },
  reply_accepted: { points: 25, label: 'Answer accepted' },
  post_upvoted: { points: 2, label: 'Post upvoted' },
  reply_upvoted: { points: 1, label: 'Reply upvoted' },
  profile_completed: { points: 20, label: 'Profile completed' },
  rate_contributed: { points: 10, label: 'Contributed a rate' }
};

/**
 * Levels.
 *
 * Thresholds grow roughly quadratically, so early progress is quick and later levels mean
 * something. `levelFor` is pure and exhaustive: any total, including a negative one from a
 * reversal, resolves to a level.
 */
const LEVELS = [
  { level: 1, from: 0, title: 'Newcomer' },
  { level: 2, from: 50, title: 'Contributor' },
  { level: 3, from: 150, title: 'Regular' },
  { level: 4, from: 350, title: 'Trusted' },
  { level: 5, from: 700, title: 'Expert' },
  { level: 6, from: 1200, title: 'Authority' },
  { level: 7, from: 2000, title: 'Luminary' }
];

function levelFor(totalPoints) {
  const points = Number.isFinite(totalPoints) ? totalPoints : 0;
  let current = LEVELS[0];
  for (const level of LEVELS) {
    if (points >= level.from) current = level;
  }
  /*
   * The next level is the one above the CURRENT band, not the first threshold above the
   * point total. Those differ when the total is negative: with -100 points you are still
   * level 1, but "the first threshold above -100" is level 1's own floor, so the sidebar
   * would read "100 points to level 1" at someone who is already there.
   */
  const next = LEVELS.find((l) => l.from > current.from) || null;

  return {
    ...current,
    points,
    nextLevel: next ? next.level : null,
    nextTitle: next ? next.title : null,
    pointsToNext: next ? next.from - points : 0,
    /*
     * Progress through the CURRENT band, so the bar restarts at each level rather than
     * creeping asymptotically towards the last one.
     *
     * Clamped, because a total can go NEGATIVE: reversing an award (an upvote withdrawn,
     * an accepted answer un-accepted) writes a compensating entry, and a new account whose
     * only ledger rows are reversals sums below zero. Unclamped that rendered as a bar of
     * -200%, which CSS draws as an empty bar and a nonsense label.
     */
    progressPercent: next
      ? Math.max(0, Math.min(100, Math.round(((points - current.from) / (next.from - current.from)) * 100)))
      : 100
  };
}

function communityProblems() {
  const problems = [];
  const seen = new Set();

  for (const category of seedCategories()) {
    if (seen.has(category.slug)) problems.push(`duplicate category slug: ${category.slug}`);
    seen.add(category.slug);
  }
  for (const [reason, award] of Object.entries(POINT_AWARDS)) {
    if (!Number.isInteger(award.points)) problems.push(`award "${reason}" has a non-integer value`);
  }
  for (let i = 1; i < LEVELS.length; i += 1) {
    if (LEVELS[i].from <= LEVELS[i - 1].from) problems.push(`level ${LEVELS[i].level} does not start above level ${LEVELS[i - 1].level}`);
  }
  return problems;
}

function assertCommunityIntegrity() {
  const problems = communityProblems();
  if (problems.length) throw new Error(`Community configuration is inconsistent:\n  - ${problems.join('\n  - ')}`);
}

module.exports = {
  POST_KINDS,
  POST_KIND_VALUES,
  isPostKind,
  postKind,
  seedCategories,
  POINT_AWARDS,
  LEVELS,
  levelFor,
  communityProblems,
  assertCommunityIntegrity
};
