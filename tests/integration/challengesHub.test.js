'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

const { attachViewHelpers } = require('../../utils/viewHelpers');
const { notFound, errorHandler } = require('../../middleware/errorHandler');
const Challenge = require('../../models/Challenge');
const challenges = require('../../config/challenges');

/**
 * /challenges over real HTTP with the model stubbed. A plain HTTP client sends no
 * Sec-Fetch-Dest, so a refused guard answers as a navigation (302).
 */
const PLAYER = { id: 8, name: 'Ana B', email: 'a@example.com', isConsultant: true, emailVerified: true };

function buildApp(user) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.session = user ? { user } : {};
    req.flash = () => [];
    Object.assign(res.locals, {
      appName: 'Salesforce Hub', supportEmail: 's@example.com', currentUser: user, currentPath: req.path,
      csrfToken: 'token', query: req.query, assistantEnabled: false, assistantMaxChars: 2000,
      linkedInEnabled: false, siteNotice: '', flash: { success: [], error: [], info: [] }, settings: {},
      seo: { title: 'Challenges', description: 'd', canonical: 'http://x/challenges', ogImage: 'http://x/o.png', indexable: false }
    });
    attachViewHelpers(res);
    next();
  });
  app.use('/challenges', require('../../routes/challenges'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function stubSidebar() {
  jest.spyOn(Challenge, 'streakFor').mockResolvedValue({ days: 3, playedToday: true });
  jest.spyOn(Challenge, 'statsFor').mockResolvedValue({ days_played: 4, played: 6, correct: 21, asked: 30, best: 5 });
  jest.spyOn(Challenge, 'dailyLeaderboard').mockResolvedValue([{ name: 'Ana B', score: 9, total: 10, played: 2 }]);
}

afterEach(() => jest.restoreAllMocks());

describe('GET /challenges (the hub)', () => {
  it('shows the mix first, every topic, what is done today, and the sidebar', async () => {
    stubSidebar();
    jest.spyOn(Challenge, 'attemptsOn').mockResolvedValue(new Map([['apex-lwc', { score: 4, total: 5 }]]));
    const res = await request(buildApp(PLAYER)).get('/challenges');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/New challenges every day/);
    expect(res.text).toMatch(/Back to dashboard/);
    expect(res.text).toMatch(/Today&#39;s mix — 5 questions/);
    for (const t of challenges.TOPICS) expect(res.text).toContain(`href="/challenges/${t.slug}"`);
    expect(res.text).toMatch(/Done today · 4\/5/);
    // Mix first, then the topics.
    expect(res.text.indexOf('href="/challenges/daily"')).toBeLessThan(res.text.indexOf('href="/challenges/admin-security"'));
    expect(res.text).toMatch(/Your streak[\s\S]*Your record[\s\S]*Today.s rankings[\s\S]*Resources/);
    // The hub names no question at all, let alone an answer.
    expect(res.text).not.toMatch(/name="answers\[/);
  });

  it('sends a visitor to sign in', async () => {
    const res = await request(buildApp(null)).get('/challenges');
    expect(res.status).toBe(302);
  });
});

describe('GET /challenges/:challenge', () => {
  it('renders the topic set without an answer key', async () => {
    stubSidebar();
    jest.spyOn(Challenge, 'attemptFor').mockResolvedValue(null);
    const res = await request(buildApp(PLAYER)).get('/challenges/apex-lwc');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/TOPIC CHALLENGE/);
    expect(res.text).toContain('action="/challenges/apex-lwc"');
    const set = challenges.setFor(challenges.serverDate(), 'apex-lwc');
    for (const q of set) expect(res.text).toContain(`name="answers[${q.id}]"`);
    for (const q of set) expect(res.text).not.toContain(q.explain);
    expect(Challenge.attemptFor).toHaveBeenCalledWith(8, expect.any(String), 'apex-lwc');
  });

  it('answers 404 for anything that is not a declared challenge', async () => {
    stubSidebar();
    for (const slug of ['nope', '__proto__', 'constructor']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(buildApp(PLAYER)).get(`/challenges/${slug}`);
      expect(res.status).toBe(404);
    }
  });
});

describe('POST /challenges/:challenge', () => {
  it('grades the URL\'s challenge and shows the explanations', async () => {
    stubSidebar();
    const date = challenges.serverDate();
    const set = challenges.setFor(date, 'flow-automation');
    const graded = challenges.gradeAnswers(set, Object.fromEntries(set.map((q) => [q.id, String(q.answer)])));
    const submit = jest.spyOn(Challenge, 'submit').mockResolvedValue({ recorded: true, date, challenge: 'flow-automation', graded });
    const body = set.map((q) => `answers[${q.id}]=${q.answer}`).join('&') + '&score=999&gameDate=2020-01-01';
    const res = await request(buildApp(PLAYER)).post('/challenges/flow-automation').type('form').send(body);
    expect(res.status).toBe(200);
    expect(submit.mock.calls[0][2]).toMatchObject({ challenge: 'flow-automation' });
    // Nothing but the answers is read from the body: no score, no date.
    expect(Object.keys(submit.mock.calls[0][2]).sort()).toEqual(['challenge', 'durationMs']);
    expect(res.text).toContain(set[0].explain);
    expect(res.text).toMatch(/Play another topic/);
  });

  it('sends the old single-challenge POST on to the mix, still a POST', async () => {
    const res = await request(buildApp(PLAYER)).post('/challenges').type('form').send('answers[x]=1');
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe('/challenges/daily');
  });
});
