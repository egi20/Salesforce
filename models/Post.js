'use strict';

const { promisePool, withTransaction } = require('../config/database');
const { uniqueSlug } = require('../utils/slug');
const { isPostKind, POST_KIND_VALUES } = require('../config/community');
const Points = require('./Points');

/**
 * Community posts: articles, questions, discussions and wins.
 *
 * The counters on `posts` (`reply_count`, `vote_score`, `last_activity_at`) are maintained
 * in the SAME transaction as the row they count. That is what lets the feed render without
 * aggregating, and it is why every write here goes through `withTransaction` rather than
 * firing two independent statements that can drift apart.
 */

/**
 * THE single filter builder for post browsing.
 *
 * Same rule as jobs and consultants: the list, its count, the feed and any bulk action all
 * come through here, so they provably see the same rows.
 */
function buildFilter(filters = {}) {
  const where = [];
  const params = [];

  if (filters.kind && isPostKind(filters.kind)) {
    where.push('p.kind = ?');
    params.push(filters.kind);
  }
  if (filters.category_slug) {
    where.push('c.slug = ?');
    params.push(filters.category_slug);
  }
  if (filters.author_user_id) {
    where.push('p.author_user_id = ?');
    params.push(filters.author_user_id);
  }
  if (filters.unanswered === '1') {
    where.push("p.kind = 'question' AND p.is_solved = 0 AND p.reply_count = 0");
  }
  if (filters.solved === '1') {
    where.push('p.is_solved = 1');
  }
  if (filters.q) {
    // LIKE rather than MATCH: the FULLTEXT index exists, but boolean mode on a corpus of
    // short, jargon-heavy titles returns worse results than a plain substring match.
    where.push('(p.title LIKE ? OR p.body LIKE ?)');
    const like = `%${String(filters.q).trim()}%`;
    params.push(like, like);
  }

  return { clause: where.length ? where.join(' AND ') : '1 = 1', params };
}

const SORTS = {
  recent: 'p.is_pinned DESC, p.last_activity_at DESC',
  newest: 'p.is_pinned DESC, p.created_at DESC',
  top: 'p.is_pinned DESC, p.vote_score DESC, p.last_activity_at DESC',
  busiest: 'p.is_pinned DESC, p.reply_count DESC, p.last_activity_at DESC'
};

const AUTHOR_SELECT = `
  u.name AS author_name,
  COALESCE(cp.profile_picture, comp.logo) AS author_avatar,
  cp.primary_role AS author_role,
  (SELECT COALESCE(SUM(pl.points), 0) FROM points_ledger pl WHERE pl.user_id = p.author_user_id) AS author_points`;

const AUTHOR_JOINS = `
  JOIN users u ON u.id = p.author_user_id
  LEFT JOIN consultant_profiles cp ON cp.user_id = p.author_user_id
  LEFT JOIN company_profiles comp ON comp.user_id = p.author_user_id`;

class Post {
  static buildFilter = buildFilter;

  static get KINDS() {
    return POST_KIND_VALUES;
  }

  static async slugTaken(slug) {
    const [rows] = await promisePool.query('SELECT 1 FROM posts WHERE slug = ? LIMIT 1', [slug]);
    return rows.length > 0;
  }

  static async create(authorUserId, { categoryId, kind, title, body }) {
    const slug = await uniqueSlug(title, Post.slugTaken);

    return withTransaction(async (conn) => {
      const [result] = await conn.query(
        'INSERT INTO posts (category_id, author_user_id, kind, title, slug, body) VALUES (?, ?, ?, ?, ?, ?)',
        [categoryId, authorUserId, kind, title, slug, body]
      );

      await Points.award(authorUserId, 'post_created', `post:${result.insertId}`, { connection: conn });
      return { id: result.insertId, slug };
    });
  }

  static async findBySlug(slug, viewerUserId = null) {
    const [rows] = await promisePool.query(
      `SELECT p.*, c.slug AS category_slug, c.name AS category_name, c.icon AS category_icon,
              ${AUTHOR_SELECT},
              ${viewerUserId ? '(SELECT v.value FROM post_votes v WHERE v.user_id = ? AND v.target_type = \'post\' AND v.target_id = p.id)' : 'NULL'} AS my_vote
         FROM posts p
         JOIN post_categories c ON c.id = p.category_id
         ${AUTHOR_JOINS}
        WHERE p.slug = ? LIMIT 1`,
      viewerUserId ? [viewerUserId, slug] : [slug]
    );
    return rows[0] || null;
  }

  static async browse(filters = {}, { limit = 20, offset = 0, sort = 'recent' } = {}) {
    const { clause, params } = buildFilter(filters);
    const orderBy = SORTS[sort] || SORTS.recent;

    const [rows] = await promisePool.query(
      `SELECT p.id, p.kind, p.title, p.slug, p.body, p.vote_score, p.reply_count, p.view_count,
              p.is_solved, p.is_pinned, p.created_at, p.last_activity_at,
              c.slug AS category_slug, c.name AS category_name, c.icon AS category_icon,
              ${AUTHOR_SELECT}
         FROM posts p
         JOIN post_categories c ON c.id = p.category_id
         ${AUTHOR_JOINS}
        WHERE ${clause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM posts p JOIN post_categories c ON c.id = p.category_id WHERE ${clause}`,
      params
    );

    return { rows, total };
  }

  /** Counts per kind for the feed's filter pills, using the same filter minus `kind`. */
  static async countsByKind(filters = {}) {
    const { clause, params } = buildFilter({ ...filters, kind: undefined });
    const [rows] = await promisePool.query(
      `SELECT p.kind, COUNT(*) AS count
         FROM posts p JOIN post_categories c ON c.id = p.category_id
        WHERE ${clause} GROUP BY p.kind`,
      params
    );
    return Object.fromEntries(rows.map((r) => [r.kind, r.count]));
  }

  static async incrementViews(postId) {
    try {
      await promisePool.query('UPDATE posts SET view_count = view_count + 1 WHERE id = ?', [postId]);
    } catch (err) {
      console.error(`View increment failed for post ${postId}: ${err.message}`);
    }
  }

  static async replies(postId, viewerUserId = null) {
    const [rows] = await promisePool.query(
      `SELECT r.*, u.name AS author_name,
              COALESCE(cp.profile_picture, comp.logo) AS author_avatar,
              (SELECT COALESCE(SUM(pl.points), 0) FROM points_ledger pl WHERE pl.user_id = r.author_user_id) AS author_points,
              ${viewerUserId ? '(SELECT v.value FROM post_votes v WHERE v.user_id = ? AND v.target_type = \'reply\' AND v.target_id = r.id)' : 'NULL'} AS my_vote
         FROM post_replies r
         JOIN users u ON u.id = r.author_user_id
         LEFT JOIN consultant_profiles cp ON cp.user_id = r.author_user_id
         LEFT JOIN company_profiles comp ON comp.user_id = r.author_user_id
        WHERE r.post_id = ?
        ORDER BY r.is_solution DESC, r.vote_score DESC, r.created_at ASC`,
      viewerUserId ? [viewerUserId, postId] : [postId]
    );
    return rows;
  }

  /**
   * Post a reply.
   *
   * The counter and `last_activity_at` move in the same transaction as the insert, so a
   * list view can never show a reply count that disagrees with the thread.
   */
  static async reply(postId, authorUserId, body, { parentReplyId = null } = {}) {
    return withTransaction(async (conn) => {
      const [[post]] = await conn.query('SELECT id, is_locked, author_user_id, title, slug FROM posts WHERE id = ? FOR UPDATE', [postId]);
      if (!post) {
        const err = new Error('That post no longer exists.');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (post.is_locked) {
        const err = new Error('That thread is locked.');
        err.code = 'LOCKED';
        throw err;
      }

      // One level of nesting: a reply to a reply attaches to the top-level parent.
      let parent = null;
      if (parentReplyId) {
        const [[found]] = await conn.query('SELECT id, parent_reply_id FROM post_replies WHERE id = ? AND post_id = ?', [parentReplyId, postId]);
        if (found) parent = found.parent_reply_id || found.id;
      }

      const [result] = await conn.query(
        'INSERT INTO post_replies (post_id, author_user_id, parent_reply_id, body) VALUES (?, ?, ?, ?)',
        [postId, authorUserId, parent, body]
      );
      await conn.query('UPDATE posts SET reply_count = reply_count + 1, last_activity_at = NOW() WHERE id = ?', [postId]);

      await Points.award(authorUserId, 'reply_created', `reply:${result.insertId}`, { connection: conn });

      return { replyId: result.insertId, post };
    });
  }

  /**
   * Cast, change or clear a vote.
   *
   * The score is recomputed from the votes table inside the transaction rather than
   * incremented, because an increment is wrong the moment a vote is CHANGED rather than
   * added — the delta is 2, not 1, and getting that wrong drifts silently forever.
   *
   * @param {number} value 1, -1, or 0 to clear
   */
  static async vote(targetType, targetId, userId, value) {
    if (!['post', 'reply'].includes(targetType)) throw new Error(`Unknown vote target: ${targetType}`);
    const normalised = value > 0 ? 1 : value < 0 ? -1 : 0;
    const table = targetType === 'post' ? 'posts' : 'post_replies';

    return withTransaction(async (conn) => {
      const [[target]] = await conn.query(`SELECT id, author_user_id FROM ${table} WHERE id = ? FOR UPDATE`, [targetId]);
      if (!target) {
        const err = new Error('That no longer exists.');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (target.author_user_id === userId) {
        const err = new Error('You cannot vote on your own post.');
        err.code = 'SELF_VOTE';
        throw err;
      }

      if (normalised === 0) {
        await conn.query('DELETE FROM post_votes WHERE user_id = ? AND target_type = ? AND target_id = ?', [userId, targetType, targetId]);
      } else {
        await conn.query(
          `INSERT INTO post_votes (user_id, target_type, target_id, value) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE value = VALUES(value)`,
          [userId, targetType, targetId, normalised]
        );
      }

      const [[{ score }]] = await conn.query(
        'SELECT COALESCE(SUM(value), 0) AS score FROM post_votes WHERE target_type = ? AND target_id = ?',
        [targetType, targetId]
      );
      await conn.query(`UPDATE ${table} SET vote_score = ? WHERE id = ?`, [score, targetId]);

      // The author is paid once per upvoter, and the award is reversed if it is withdrawn.
      const reason = targetType === 'post' ? 'post_upvoted' : 'reply_upvoted';
      const key = `${reason}:${targetId}:${userId}`;
      if (normalised === 1) {
        await Points.award(target.author_user_id, reason, key, { connection: conn });
      } else {
        await Points.reverse(target.author_user_id, reason, key, { connection: conn });
      }

      return { score: Number(score), myVote: normalised };
    });
  }

  /**
   * Accept a reply as the solution to a question.
   *
   * Only the asker may accept, only a question can be solved, and accepting a second reply
   * moves the mark rather than adding one — the previous solution is cleared in the same
   * transaction.
   */
  static async acceptSolution(postId, replyId, actorUserId) {
    return withTransaction(async (conn) => {
      const [[post]] = await conn.query('SELECT id, kind, author_user_id, solution_reply_id FROM posts WHERE id = ? FOR UPDATE', [postId]);
      if (!post) {
        const err = new Error('That post no longer exists.');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (post.kind !== 'question') {
        const err = new Error('Only a question can have an accepted answer.');
        err.code = 'NOT_A_QUESTION';
        throw err;
      }
      if (post.author_user_id !== actorUserId) {
        const err = new Error('Only the person who asked can accept an answer.');
        err.code = 'FORBIDDEN';
        throw err;
      }

      const [[reply]] = await conn.query('SELECT id, author_user_id FROM post_replies WHERE id = ? AND post_id = ?', [replyId, postId]);
      if (!reply) {
        const err = new Error('That reply is not on this question.');
        err.code = 'NOT_FOUND';
        throw err;
      }

      if (post.solution_reply_id) {
        await conn.query('UPDATE post_replies SET is_solution = 0 WHERE id = ?', [post.solution_reply_id]);
      }

      await conn.query('UPDATE post_replies SET is_solution = 1 WHERE id = ?', [replyId]);
      await conn.query('UPDATE posts SET is_solved = 1, solution_reply_id = ?, last_activity_at = NOW() WHERE id = ?', [replyId, postId]);

      await Points.award(reply.author_user_id, 'reply_accepted', `accepted:${replyId}`, { connection: conn });

      return { replyId, answererUserId: reply.author_user_id };
    });
  }

  static async listCategories() {
    const [rows] = await promisePool.query(
      `SELECT c.*, COUNT(p.id) AS post_count
         FROM post_categories c
         LEFT JOIN posts p ON p.category_id = c.id
        WHERE c.is_active = 1
        GROUP BY c.id
        ORDER BY c.sort_order, c.name`
    );
    return rows;
  }

  static async findCategoryBySlug(slug) {
    const [rows] = await promisePool.query('SELECT * FROM post_categories WHERE slug = ? AND is_active = 1 LIMIT 1', [slug]);
    return rows[0] || null;
  }

  static async remove(postId, actorUserId, { isAdmin = false } = {}) {
    const [result] = await promisePool.query(
      isAdmin ? 'DELETE FROM posts WHERE id = ?' : 'DELETE FROM posts WHERE id = ? AND author_user_id = ?',
      isAdmin ? [postId] : [postId, actorUserId]
    );
    return result.affectedRows === 1;
  }
}

module.exports = Post;
