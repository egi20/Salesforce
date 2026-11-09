'use strict';

const express = require('express');

const Challenge = require('../models/Challenge');
const { isAuthenticated, isEmailVerified } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { communityWritable } = require('../middleware/settingsGates');
const {
  CHALLENGES,
  TOPICS,
  DAILY,
  QUESTIONS_PER_DAY,
  POINTS_PER_CORRECT,
  bankSize,
  setFor,
  challengeFor,
  publicFormOf,
  serverDate
} = require('../config/challenges');

const router = express.Router();

/**
 * The challenges hub, the daily mix and the topic challenges.
 *
 * THE ONE RULE: an answer key never leaves this process. `setFor()` returns the full
 * question including `answer`, and every path out of this file maps it through
 * `publicFormOf` first. A test asserts this module never renders a raw question and never
 * names the `answer` or `explain` fields outside a graded result.
 *
 * Signed in and email-verified, because an attempt awards points against the shared
 * ledger. An anonymous or unverified account playing would let one person farm a
 * leaderboard from a mailbox they do not control.
 *
 * Gated by `communityWritable` for the same reason posts are: the challenge writes to the
 * points ledger, so the switch that stops the community growing has to stop this too. A
 * gate written into three of four write paths is a gate that is off.
 */

/** The sidebar every challenge page shares: streak, record and today's board. */
async function sidebarModel(userId, date) {
  const [streak, stats, daily] = await Promise.all([
    Challenge.streakFor(userId, { today: date }),
    Challenge.statsFor(userId),
    Challenge.dailyLeaderboard(date)
  ]);
  return { streak, stats, daily };
}

/** The resolved challenge for `:challenge`, or a 404 through the normal handler. */
function challengeParam(req, res, next) {
  const challenge = challengeFor(req.params.challenge);
  if (!challenge) return next('route');
  res.locals.challenge = challenge;
  return next();
}

/**
 * GET /challenges — the hub: today's mix first, then the six topics, each saying whether it
 * has been played today and how it went.
 */
router.get(
  '/',
  isAuthenticated,
  isEmailVerified,
  asyncHandler(async (req, res) => {
    const userId = req.session.user.id;
    const date = serverDate();
    const [played, sidebar] = await Promise.all([Challenge.attemptsOn(userId, date), sidebarModel(userId, date)]);
    res.render('challenges/index', {
      title: 'Daily challenges',
      date,
      featured: CHALLENGES[0],
      topics: TOPICS,
      played,
      questionsPerDay: QUESTIONS_PER_DAY,
      pointsPerCorrect: POINTS_PER_CORRECT,
      bankSize: bankSize(),
      ...sidebar
    });
  })
);

/** The single daily challenge used to post here; a cached form still might. 308 keeps it a POST. */
router.post('/', (req, res) => res.redirect(308, `/challenges/${DAILY}`));

/** GET /challenges/leaderboard — the same two tables, on their own page. */
router.get(
  '/leaderboard',
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const date = serverDate();
    const [daily, allTime] = await Promise.all([
      Challenge.dailyLeaderboard(date, { limit: 25 }),
      Challenge.allTimeLeaderboard({ limit: 25 })
    ]);

    res.render('challenges/leaderboard', {
      title: 'Challenge leaderboard',
      date,
      daily,
      allTime
    });
  })
);

function renderPlay(res, { challenge, date, attempt, sidebar, questions, results }) {
  return res.render('challenges/play', {
    title: challenge.slug === DAILY ? "Today's mix" : `${challenge.title} challenge`,
    challenge,
    date,
    attempt,
    ...sidebar,
    questions,
    questionsPerDay: QUESTIONS_PER_DAY,
    pointsPerCorrect: POINTS_PER_CORRECT,
    bankSize: bankSize(challenge.slug),
    results
  });
}

/**
 * GET /challenges/:challenge — that challenge's five questions, or today's result.
 *
 * Note what is passed to the template: `setFor(date, slug).map(publicFormOf)`. The set is
 * derived from the DATE, so it is the same five questions for everybody and the same five
 * on a reload — which is what lets a daily leaderboard mean anything, and what lets a
 * disputed score be reconstructed later.
 */
router.get(
  '/:challenge',
  isAuthenticated,
  isEmailVerified,
  challengeParam,
  asyncHandler(async (req, res) => {
    const { challenge } = res.locals;
    const userId = req.session.user.id;
    const date = serverDate();
    const [attempt, sidebar] = await Promise.all([Challenge.attemptFor(userId, date, challenge.slug), sidebarModel(userId, date)]);
    return renderPlay(res, {
      challenge,
      date,
      attempt,
      sidebar,
      questions: attempt ? [] : setFor(date, challenge.slug).map(publicFormOf),
      results: null
    });
  })
);

/**
 * POST /challenges/:challenge — submit the chosen options and get them graded.
 *
 * The body carries `answers[<question id>]` — the OPTION INDEX chosen for each question —
 * and nothing else that matters. There is no `score` field and no `gameDate` field to
 * read, which is the whole point: the reference reads both out of `req.body` and writes
 * them to its leaderboard. Which challenge is the URL's, validated above.
 *
 * `duration_ms` IS read from the body and stored, but only ever displayed. It is not
 * ranked on and the model says so, because a client-reported duration is precisely the
 * kind of number that should not decide a position.
 */
router.post(
  '/:challenge',
  isAuthenticated,
  isEmailVerified,
  communityWritable,
  writeLimiter,
  challengeParam,
  asyncHandler(async (req, res) => {
    const { challenge } = res.locals;
    // Passed through as it arrived. The grader keys on the question id and treats
    // anything it cannot read as unanswered, so a hostile or malformed body produces a
    // low score rather than an error — and cannot reach a question it was not asked.
    const answers = req.body.answers;

    const durationRaw = Number.parseInt(req.body.duration_ms, 10);

    const outcome = await Challenge.submit(req.session.user.id, answers, {
      challenge: challenge.slug,
      durationMs: Number.isFinite(durationRaw) ? durationRaw : null
    });

    if (!outcome.recorded) {
      req.flash('info', 'You have already played this one today. A new set arrives at midnight UTC.');
      return res.redirect(`/challenges/${challenge.slug}`);
    }

    const sidebar = await sidebarModel(req.session.user.id, outcome.date);

    // Rendered rather than redirected, because the explanations are the reason to play and
    // a redirect would throw them away. This is the only place `explain` and `answer` are
    // ever sent to a browser — after the attempt is closed by the unique key.
    res.status(200);
    return renderPlay(res, {
      challenge,
      date: outcome.date,
      attempt: null,
      sidebar,
      questions: [],
      results: outcome.graded
    });
  })
);

module.exports = router;
