'use strict';

const { promisePool } = require('../config/database');
const { POINT_AWARDS, levelFor } = require('../config/community');

/**
 * The points ledger.
 *
 * Append-only. A single `points` column on the user row would be unauditable — nobody
 * could answer "where did these come from", and a double award could never be found, let
 * alone reversed. The ledger is the record; a total is a SUM over it.
 *
 * `award()` is fire-and-forget for the same reason notifications are: points are a side
 * effect of an action that has already succeeded, and failing to record them must never
 * fail the action. The unique `dedupe_key` makes the insert idempotent, so a retried
 * request or a re-run emitter cannot pay twice.
 */
class Points {
  static async award(userId, reason, dedupeKey, { connection = null } = {}) {
    const definition = POINT_AWARDS[reason];
    if (!definition || !userId || !dedupeKey) return false;

    const runner = connection || promisePool;
    try {
      const [result] = await runner.query(
        'INSERT IGNORE INTO points_ledger (user_id, reason, points, dedupe_key) VALUES (?, ?, ?, ?)',
        [userId, reason, definition.points, String(dedupeKey).slice(0, 190)]
      );
      return result.affectedRows === 1;
    } catch (err) {
      console.error(`Points award failed (${reason}): ${err.message}`);
      return false;
    }
  }

  /**
   * Reverse an award by writing a compensating entry rather than deleting the original.
   *
   * A ledger that can be edited is not a ledger. Un-accepting an answer or removing an
   * upvote must leave both the award and its reversal visible.
   */
  static async reverse(userId, reason, dedupeKey, { connection = null } = {}) {
    const definition = POINT_AWARDS[reason];
    if (!definition || !userId || !dedupeKey) return false;

    const runner = connection || promisePool;
    try {
      const [result] = await runner.query(
        'INSERT IGNORE INTO points_ledger (user_id, reason, points, dedupe_key) VALUES (?, ?, ?, ?)',
        [userId, `${reason}_reversed`, -definition.points, `reverse:${String(dedupeKey).slice(0, 180)}`]
      );
      return result.affectedRows === 1;
    } catch (err) {
      console.error(`Points reversal failed (${reason}): ${err.message}`);
      return false;
    }
  }

  static async totalFor(userId) {
    const [[row]] = await promisePool.query(
      'SELECT COALESCE(SUM(points), 0) AS total FROM points_ledger WHERE user_id = ?',
      [userId]
    );
    return Number(row.total);
  }

  /** Total plus the derived level, which is what every sidebar actually wants. */
  static async standingFor(userId) {
    return levelFor(await Points.totalFor(userId));
  }

  static async recentFor(userId, { limit = 10 } = {}) {
    const [rows] = await promisePool.query(
      'SELECT reason, points, created_at FROM points_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      [userId, limit]
    );
    return rows;
  }

  /**
   * Leaderboard over a window.
   *
   * All-time boards reward seniority rather than contribution, and become impossible for a
   * newcomer to enter. A rolling window keeps them winnable.
   */
  static async leaderboard({ days = 30, limit = 10 } = {}) {
    const [rows] = await promisePool.query(
      `SELECT pl.user_id, SUM(pl.points) AS points, u.name,
              cp.profile_picture, comp.logo
         FROM points_ledger pl
         JOIN users u ON u.id = pl.user_id AND u.is_active = 1
         LEFT JOIN consultant_profiles cp ON cp.user_id = u.id
         LEFT JOIN company_profiles comp ON comp.user_id = u.id
        WHERE pl.created_at > DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY pl.user_id, u.name, cp.profile_picture, comp.logo
       HAVING points > 0
        ORDER BY points DESC
        LIMIT ?`,
      [days, limit]
    );
    return rows.map((r) => ({ ...r, points: Number(r.points) }));
  }
}

module.exports = Points;
