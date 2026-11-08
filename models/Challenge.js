'use strict';

const { promisePool, withTransaction } = require('../config/database');
const Points = require('./Points');
const { setFor, gradeAnswers, serverDate, isChallenge, DAILY } = require('../config/challenges');

/**
 * Display name on a leaderboard.
 *
 * The same COALESCE `models/Conversation.js` uses, and for the same reason: an account
 * with no name would otherwise be shown by its email local part, which leaks
 * `firstname.lastname` to every visitor of a public-facing board. The email is not
 * selected at all here — a leaderboard has no use for one.
 */
const DISPLAY_NAME_SQL = "COALESCE(NULLIF(TRIM(u.name), ''), 'Salesforce Hub user')";

/**
 * The challenges: the daily mix and the topic sets, one engine.
 *
 * This model GRADES; it never stores a number a client sent. `challenge` is a slug the
 * ROUTE validated against `config/challenges.js`, and it is checked again here, because
 * it becomes part of the unique key and of the points' dedupe key. See `config/challenges.js`
 * for the reference implementation's `{ score, gameDate } = req.body` and why none of it
 * is ported.
 */

const STREAK_LOOKBACK_DAYS = 400;

class Challenge {
  /**
   * Record an attempt, or report that today is already played.
   *
   * The unique key on `(user_id, challenge_date)` is what enforces one attempt a day, and
   * it is checked by ATTEMPTING THE INSERT rather than by selecting first: a select-then-
   * insert has a window in which two concurrent submissions both see nothing and both
   * write. `INSERT IGNORE` closes it in the schema, the same way every fulfilment table
   * in this codebase does.
   *
   * Points are awarded inside the same transaction, keyed on the date and the challenge, so
   * a retried request cannot pay twice even if the insert somehow did.
   */
  static async submit(userId, submittedAnswers, { now = new Date(), durationMs = null, challenge = DAILY } = {}) {
    if (!isChallenge(challenge)) throw new Error(`unknown challenge: ${challenge}`);
    const date = serverDate(now);
    const questions = setFor(date, challenge);
    const graded = gradeAnswers(questions, submittedAnswers);

    return withTransaction(async (conn) => {
      // The chosen option's LABEL is kept beside its index: the options are shuffled per day
      // from the bank as it stood, so a label is what still answers a dispute after the bank
      // has grown.
      const record = graded.results.map((r) => ({
        id: r.id,
        chosen: r.chosen,
        chosenLabel: r.chosen === null ? null : r.options[r.chosen],
        correct: r.correct
      }));

      // A plain JSON string, not CAST(? AS JSON): MySQL 8 stores it in the JSON column as is,
      // and MariaDB (where JSON is LONGTEXT with a json_valid check) rejects the CAST
      // outright — every attempt there failed with a 500.
      const [result] = await conn.query(
        `INSERT IGNORE INTO challenge_attempts
           (user_id, challenge_date, challenge, score, total, answers, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          date,
          challenge,
          graded.score,
          graded.total,
          JSON.stringify(record),
          Number.isInteger(durationMs) && durationMs > 0 && durationMs < 86_400_000 ? durationMs : null
        ]
      );

      if (result.affectedRows !== 1) {
        // Already played. The earlier attempt stands: a second grading would let somebody
        // resubmit until they got five out of five, which is the reference's bug with an
        // extra step.
        const [[existing]] = await conn.query(
          'SELECT score, total, created_at FROM challenge_attempts WHERE user_id = ? AND challenge_date = ? AND challenge = ?',
          [userId, date, challenge]
        );
        return { recorded: false, date, challenge, alreadyPlayed: existing || null, graded };
      }

      // `Points.award` swallows its own failures by design — a bookkeeping problem must
      // not fail the action the person actually took.
      // The mix keeps the key it always had, so no award made before the topics existed can
      // be paid a second time under a new key.
      const keyBase = challenge === DAILY ? `challenge:${date}:${userId}` : `challenge:${date}:${challenge}:${userId}`;
      for (let i = 0; i < graded.score; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Points.award(userId, 'challenge_correct', `${keyBase}:${i}`, { connection: conn });
      }

      return { recorded: true, date, challenge, graded };
    });
  }

  /** Today's attempt at one challenge for one person, or null. Decides what the page renders. */
  static async attemptFor(userId, date, challenge = DAILY) {
    const [[row]] = await promisePool.query(
      'SELECT * FROM challenge_attempts WHERE user_id = ? AND challenge_date = ? AND challenge = ?',
      [userId, date, challenge]
    );
    return row || null;
  }

  /** Every challenge this person played on a date, as a Map of slug → { score, total }: the hub's "Done today". */
  static async attemptsOn(userId, date) {
    const [rows] = await promisePool.query(
      'SELECT challenge, score, total FROM challenge_attempts WHERE user_id = ? AND challenge_date = ?',
      [userId, date]
    );
    return new Map(rows.map((r) => [r.challenge, { score: Number(r.score), total: Number(r.total) }]));
  }

  /**
   * The current streak, DERIVED from the attempt dates.
   *
   * Not a counter, and not a `POST /streak/checkin` the browser calls — the reference has
   * both, and a stored counter fed by a client endpoint is a number with no evidence
   * behind it. Here the attempts ARE the evidence: the streak is however many consecutive
   * days end at today or yesterday, recomputed from rows that only the grader writes.
   *
   * Yesterday counts so that a streak is not lost at midnight by somebody who has not yet
   * played today; playing today extends it, missing today AND yesterday ends it. ANY
   * challenge counts for its day — the streak is about turning up, and several topics on
   * one day are still one day.
   */
  static async streakFor(userId, { today = serverDate() } = {}) {
    const [rows] = await promisePool.query(
      `SELECT DISTINCT challenge_date
         FROM challenge_attempts
        WHERE user_id = ? AND challenge_date > (? - INTERVAL ? DAY)
        ORDER BY challenge_date DESC`,
      [userId, today, STREAK_LOOKBACK_DAYS]
    );
    return Challenge.streakFromDates(rows.map((r) => r.challenge_date), today);
  }

  /**
   * The streak rule as a pure function over dates, so it is testable without a database.
   * Exported deliberately: this is the bit that is easy to get wrong at month boundaries.
   */
  static streakFromDates(dates, today) {
    const played = new Set(
      (dates || []).map((d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)))
    );
    if (played.size === 0) return { days: 0, playedToday: false };

    const playedToday = played.has(today);
    const dayBefore = (iso) => new Date(`${iso}T00:00:00Z`).getTime() - 86_400_000;
    const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);

    let cursor = playedToday ? today : isoOf(dayBefore(today));
    if (!played.has(cursor)) return { days: 0, playedToday };

    let days = 0;
    while (played.has(cursor)) {
      days += 1;
      cursor = isoOf(dayBefore(cursor));
    }
    return { days, playedToday };
  }

  /**
   * The leaderboard for one day, and the all-time table.
   *
   * Both are derived at read time. There is no cached rank column anywhere, for the same
   * reason `job_features` has no `is_featured` boolean: a cached figure needs something to
   * come round and update it, and the day that job fails to run is the day the board is
   * quietly wrong.
   *
   * The day's board sums every challenge a person played that day — correct answers out of
   * questions asked, and how many challenges. Ties break on who got there EARLIER (their
   * last attempt of the day), not on `duration_ms`: the duration is reported by the client,
   * and ranking on a client-reported number is exactly the reference's bug.
   */
  static async dailyLeaderboard(date, { limit = 10 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT SUM(a.score) AS score, SUM(a.total) AS total, COUNT(*) AS played,
              MAX(a.created_at) AS created_at, u.id AS user_id, ${DISPLAY_NAME_SQL} AS name
         FROM challenge_attempts a
         JOIN users u ON u.id = a.user_id
        WHERE a.challenge_date = ? AND u.is_active = 1
        GROUP BY u.id, u.name
        ORDER BY score DESC, created_at ASC, u.id ASC
        LIMIT ?`,
      [date, limit]
    );
    // MariaDB hands SUM() back as a string.
    return rows.map((r) => ({ ...r, score: Number(r.score), total: Number(r.total), played: Number(r.played) }));
  }

  static async allTimeLeaderboard({ days = 30, limit = 10 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT u.id AS user_id, ${DISPLAY_NAME_SQL} AS name,
              SUM(a.score) AS total_score,
              COUNT(DISTINCT a.challenge_date) AS days_played
         FROM challenge_attempts a
         JOIN users u ON u.id = a.user_id
        WHERE a.challenge_date > (CURDATE() - INTERVAL ? DAY) AND u.is_active = 1
        GROUP BY u.id, u.name
        ORDER BY total_score DESC, days_played DESC, u.id ASC
        LIMIT ?`,
      [days, limit]
    );
    return rows;
  }

  /** How somebody has done overall, for their dashboard: days, challenges, correct of asked, best set. */
  static async statsFor(userId) {
    const [[row]] = await promisePool.query(
      `SELECT COUNT(DISTINCT challenge_date) AS days_played, COUNT(*) AS played,
              COALESCE(SUM(score), 0) AS correct, COALESCE(SUM(total), 0) AS asked,
              COALESCE(MAX(score), 0) AS best
         FROM challenge_attempts WHERE user_id = ?`,
      [userId]
    );
    return {
      days_played: Number(row.days_played),
      played: Number(row.played),
      correct: Number(row.correct),
      asked: Number(row.asked),
      best: Number(row.best)
    };
  }
}

module.exports = Challenge;
