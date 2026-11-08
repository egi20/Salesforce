'use strict';

const crypto = require('crypto');

/**
 * The daily challenge: questions, and the rule that the browser never sees an answer.
 *
 * THE FINDING THAT DECIDES THE WHOLE DESIGN. The reference implementation's game system
 * is client-authoritative from end to end:
 *
 *   routes/games.js:41   const { score, gameDate } = req.body;
 *
 * The browser tells the server what it scored, and the server writes that number to a
 * leaderboard. `gameDate` comes from the request too, so any date can be backfilled. And
 * it does not matter anyway, because all 2467 lines of `views/partials/games-section.ejs`
 * ship every question TOGETHER WITH the index of its correct answer:
 *
 *   { q: "What does D365 F&O stand for?", options: [...], correct: 0 }
 *
 * Anyone signed in can post `{score: 999999, gameDate: '2020-01-01'}` with one fetch, and
 * anyone curious can read the answers in view-source. That output then feeds
 * `getUserPointsSummary` — so a browser can mint points. In this codebase the points
 * ledger is append-only and auditable precisely so that a total can always be explained;
 * a client-authored score destroys that property for every total on the site, not just
 * the cheater's.
 *
 * So: the answers live here and never leave the process. The page is sent questions with
 * the `answer` field stripped, the browser posts the OPTIONS IT CHOSE, and
 * `gradeAnswers()` — a pure function — decides the score. The date comes from the server
 * clock. One attempt per person per day is enforced by a unique key in the schema.
 *
 * ONE game, done properly, rather than the reference's nine — now played over six topic
 * banks and a daily mix, all through the same grader. The other eight (match,
 * flashcard, typing, word search, bug hunter, scenario, code quiz, streak check-in) are
 * the same client-authoritative shape wearing different UI; porting them would be porting
 * the bug eight more times. The streak is kept, but DERIVED from attempt dates rather than
 * posted by a `POST /streak/checkin` the browser can call as often as it likes.
 */

/**
 * The question bank lives in `config/challengeBank.js`, by topic, and this module is the
 * only one that reads it. `answer` is NEVER serialised to a client — `publicFormOf` is the
 * only thing a route may render, and a test asserts the route module cannot reach the raw
 * bank. `explain` is shown AFTER grading, which is the part that makes this worth playing
 * rather than a slot machine.
 */
const { TOPIC_QUESTIONS } = require('./challengeBank');

/**
 * The topic challenges, in the order the hub shows them. Each draws its five a day from its
 * own bank; the daily MIX ("Today's mix") draws one question from each of five topics. Every
 * one is the same engine with the same rules: marked on the server, one attempt per person
 * per day, the same set for everybody, one point per correct answer.
 *
 * `tone` is one of the sanctioned `.icon-*` gradient classes in style.css — never a colour here.
 */
const TOPICS = Object.freeze([
  { slug: 'admin-security', title: 'Admin & Security', icon: 'bi-shield-lock', tone: 'icon-navy', blurb: 'Sharing, profiles, permission sets and sandboxes.' },
  { slug: 'apex-lwc', title: 'Apex & LWC', icon: 'bi-code-slash', tone: 'icon-blue', blurb: 'Governor limits, triggers, tests and Lightning Web Components.' },
  { slug: 'flow-automation', title: 'Flow & Automation', icon: 'bi-diagram-3', tone: 'icon-success', blurb: 'Record-triggered flows, the order of execution and approvals.' },
  { slug: 'data-integration', title: 'Data Cloud & Integration', icon: 'bi-hdd-network', tone: 'icon-info', blurb: 'Data streams, identity resolution, APIs and events.' },
  { slug: 'agentforce-ai', title: 'Agentforce & AI', icon: 'bi-robot', tone: 'icon-violet', blurb: 'Agents, grounding, the Trust Layer and prompt design.' },
  { slug: 'sales-service', title: 'Sales, Service & Experience', icon: 'bi-headset', tone: 'icon-amber', blurb: 'Leads, CPQ, Omni-Channel, cases and sites.' }
]);

/** The mixed set keeps the slug the single daily challenge always had. */
const DAILY = 'daily';
const DAILY_CHALLENGE = Object.freeze({ slug: DAILY, title: "Today's mix", icon: 'bi-lightning-charge', tone: 'icon-navyblue', blurb: 'One question from five different topics.' });

const CHALLENGES = Object.freeze([DAILY_CHALLENGE, ...TOPICS]);
const CHALLENGE_BY_SLUG = Object.freeze(Object.fromEntries(CHALLENGES.map((c) => [c.slug, c])));

/** A topic bank needs at least this many, so a topic is not the same five every few days. */
const MIN_PER_TOPIC = 20;

/** Every question, flat, with its topic — for the integrity check and the bank size. */
const QUESTIONS = Object.freeze(
  TOPICS.flatMap((t) => (TOPIC_QUESTIONS[t.slug] || []).map((q) => Object.freeze({ ...q, topic: t.slug })))
);

/**
 * `hasOwnProperty`, never a truthiness check: `CHALLENGE_BY_SLUG['__proto__']` is
 * `Object.prototype`, which is truthy — the same trap `config/settings.js` documents.
 */
function isChallenge(slug) {
  return typeof slug === 'string' && Object.prototype.hasOwnProperty.call(CHALLENGE_BY_SLUG, slug);
}

function challengeFor(slug) {
  return isChallenge(slug) ? CHALLENGE_BY_SLUG[slug] : null;
}

/** How many questions a daily challenge holds. */
const QUESTIONS_PER_DAY = 5;

/**
 * What a correct answer is worth, and the ceiling on a day.
 *
 * Deliberately modest next to `reply_accepted` (25 points in `config/community.js`). The
 * scheme there already states the principle: a scheme that pays for volume gets volume,
 * and a quiz is the easiest volume on the site. Answering questions should nudge a
 * standing, never build one.
 */
const POINTS_PER_CORRECT = 1;

/** A streak survives a missed day this many times before it resets. It does not. */
const STREAK_GRACE_DAYS = 0;

/**
 * Deterministic daily selection.
 *
 * Seeded by the DATE, so everybody playing on the same day gets the same five questions
 * in the same order — which is what makes a daily leaderboard mean anything — and so a
 * past day can be reconstructed exactly when somebody disputes a score. A random shuffle
 * would make both impossible.
 *
 * The option order is shuffled too, from the same seed, so the correct answer is not
 * always in the position the bank happens to list it in.
 */
function seedFor(dateIso, salt) {
  return crypto.createHash('sha256').update(`${dateIso}|${salt}`).digest();
}

/** A tiny deterministic PRNG over a hash digest. Not cryptographic — it does not need to be. */
function rngFrom(digest) {
  let i = 0;
  return () => {
    const value = digest.readUInt32BE((i * 4) % (digest.length - 4));
    i += 1;
    return value / 0xffffffff;
  };
}

function shuffled(list, random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** One topic's bank in the day's order. The first five are that topic's set. */
function topicOrderFor(dateIso, topic) {
  return shuffled(TOPIC_QUESTIONS[topic].slice(), rngFrom(seedFor(dateIso, `pick:${topic}`)));
}

/**
 * The questions of one challenge on a date, with their options shuffled.
 *
 * A topic set is the first five of that topic's order for the day. The MIX takes five
 * topics (chosen by the date) and the SIXTH question of each one's order — so it never
 * repeats a question from the same day's topic sets, and playing a topic first gives no
 * head start on the mix.
 *
 * Returns the FULL question, answer included. Only `publicFormOf` may reach a template.
 */
function setFor(dateIso, slug = DAILY, { size = QUESTIONS_PER_DAY } = {}) {
  if (!isChallenge(slug)) throw new Error(`unknown challenge: ${slug}`);
  let picked;
  if (slug === DAILY) {
    const topics = shuffled(TOPICS.map((t) => t.slug), rngFrom(seedFor(dateIso, 'mix-topics'))).slice(0, size);
    picked = topics.map((topic) => ({ ...topicOrderFor(dateIso, topic)[QUESTIONS_PER_DAY], topic }));
  } else {
    picked = topicOrderFor(dateIso, slug).slice(0, size).map((q) => ({ ...q, topic: slug }));
  }

  return picked.map((question) => {
    const order = shuffled(
      question.options.map((label, index) => ({ label, index })),
      rngFrom(seedFor(dateIso, `opts:${question.id}`))
    );
    return {
      id: question.id,
      module: question.module,
      topic: question.topic,
      prompt: question.prompt,
      explain: question.explain,
      options: order.map((o) => o.label),
      // Where the correct option ended up after shuffling.
      answer: order.findIndex((o) => o.index === question.answer)
    };
  });
}

/** The mixed daily set — the name the single daily challenge always had. */
function dailySetFor(dateIso, options) {
  return setFor(dateIso, DAILY, options);
}

/**
 * The shape a browser is allowed to receive. The `answer` and nothing else is removed,
 * and `explain` goes with it — handing over the explanation before grading would name the
 * right option in prose.
 */
function publicFormOf(question) {
  return {
    id: question.id,
    module: question.module,
    prompt: question.prompt,
    options: question.options.slice()
  };
}

/**
 * Grade a submission. Pure, so the rule is testable without a database or a request.
 *
 * `submitted` is whatever arrived in the body — an array of chosen option indices,
 * possibly the wrong length, possibly holding strings, objects or nothing. Every entry is
 * coerced and range-checked; anything that is not a valid index for its question counts as
 * unanswered rather than throwing, because a malformed body is a client bug or a probe,
 * not a reason to 500.
 */
function gradeAnswers(questions, submitted) {
  // Keyed by QUESTION ID first, position second.
  //
  // The form posts `answers[<question id>]`, not `answers[0]`, and that is deliberate:
  // `qs` (the parser behind `extended: true`) COMPACTS a sparse numeric object, so a body
  // carrying answers for questions 1, 3 and 5 arrives as a three-element array and every
  // answer after the first gap is graded against the wrong question. Keying on the id
  // removes the ordering dependency entirely. The positional fallback is kept so the
  // function stays usable from a test with a plain array.
  const given = submitted && typeof submitted === 'object' ? submitted : {};

  const results = questions.map((question, position) => {
    const raw = Object.prototype.hasOwnProperty.call(given, question.id) ? given[question.id] : given[position];
    // An integer, or a string that is ENTIRELY digits. Deliberately not `parseInt`:
    // `parseInt(2.5)` is 2 and `parseInt('3abc')` is 3, so a malformed value would be
    // quietly rounded into a valid choice instead of counting as unanswered.
    const chosen = Number.isInteger(raw) ? raw : /^\d+$/.test(String(raw ?? '')) ? Number(raw) : NaN;
    const valid = Number.isInteger(chosen) && chosen >= 0 && chosen < question.options.length;

    return {
      id: question.id,
      module: question.module,
      prompt: question.prompt,
      options: question.options.slice(),
      chosen: valid ? chosen : null,
      answer: question.answer,
      correct: valid && chosen === question.answer,
      explain: question.explain
    };
  });

  const score = results.filter((r) => r.correct).length;
  return { results, score, total: questions.length, points: score * POINTS_PER_CORRECT };
}

/**
 * Today, as the SERVER sees it, in UTC.
 *
 * The reference takes `gameDate` from the request body. That is not a convenience — it is
 * the leaderboard's primary key handed to the client. UTC rather than a local zone so that
 * "today" is one thing for everyone on one leaderboard; a per-visitor local day would let
 * somebody in Auckland play tomorrow's challenge before somebody in Lisbon has finished
 * today's.
 */
function serverDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Asserted at boot beside the role taxonomy: a malformed bank is a quiz nobody can win. */
function assertChallengeIntegrity() {
  const seen = new Set();
  for (const question of QUESTIONS) {
    if (!question.id || seen.has(question.id)) throw new Error(`duplicate or missing question id: ${question.id}`);
    seen.add(question.id);
    if (!question.prompt || !question.explain) throw new Error(`question ${question.id} is missing prompt or explanation`);
    if (!Array.isArray(question.options) || question.options.length < 2) {
      throw new Error(`question ${question.id} needs at least two options`);
    }
    if (new Set(question.options).size !== question.options.length) {
      throw new Error(`question ${question.id} has duplicate options`);
    }
    if (!Number.isInteger(question.answer) || question.answer < 0 || question.answer >= question.options.length) {
      throw new Error(`question ${question.id} has an answer outside its options`);
    }
  }
  for (const topic of TOPICS) {
    const bank = TOPIC_QUESTIONS[topic.slug];
    if (!Array.isArray(bank)) throw new Error(`topic ${topic.slug} has no question bank`);
    if (bank.length < MIN_PER_TOPIC) {
      throw new Error(`topic ${topic.slug} holds ${bank.length} questions; a topic needs ${MIN_PER_TOPIC}`);
    }
  }
  for (const slug of Object.keys(TOPIC_QUESTIONS)) {
    if (!TOPICS.some((t) => t.slug === slug)) throw new Error(`question bank names an unknown topic: ${slug}`);
  }
  // The mix takes one question from each of five topics.
  if (TOPICS.length < QUESTIONS_PER_DAY) throw new Error(`the mix needs ${QUESTIONS_PER_DAY} topics`);
  // Slugs are URL segments under /challenges, beside the fixed routes.
  for (const c of CHALLENGES) {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(c.slug) || ['leaderboard', 'new'].includes(c.slug)) {
      throw new Error(`challenge slug ${c.slug} cannot be a route segment`);
    }
  }
  if (!Number.isInteger(POINTS_PER_CORRECT) || POINTS_PER_CORRECT < 0) {
    throw new Error('points per correct answer must be a non-negative integer');
  }
  return true;
}

module.exports = {
  TOPICS,
  CHALLENGES,
  DAILY,
  MIN_PER_TOPIC,
  isChallenge,
  challengeFor,
  setFor,
  QUESTIONS_PER_DAY,
  POINTS_PER_CORRECT,
  STREAK_GRACE_DAYS,
  bankSize: (slug) => (slug && slug !== DAILY && isChallenge(slug) ? TOPIC_QUESTIONS[slug].length : QUESTIONS.length),
  dailySetFor,
  publicFormOf,
  gradeAnswers,
  serverDate,
  assertChallengeIntegrity
};
