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
 * ONE game, done properly, rather than the reference's nine. The other eight (match,
 * flashcard, typing, word search, bug hunter, scenario, code quiz, streak check-in) are
 * the same client-authoritative shape wearing different UI; porting them would be porting
 * the bug eight more times. The streak is kept, but DERIVED from attempt dates rather than
 * posted by a `POST /streak/checkin` the browser can call as often as it likes.
 */

/**
 * The question bank.
 *
 * `answer` is an index into `options` and is NEVER serialised to a client — `publicFormOf`
 * is the only thing a route may render, and a test asserts the route module cannot reach
 * the raw bank. `explain` is shown AFTER grading, which is the part that makes this worth
 * playing rather than a slot machine.
 *
 * `module` ties a question to `config/cloudFamilies.js`, so a result can say which cloud
 * somebody is weak on instead of only a number out of five.
 */
const QUESTIONS = Object.freeze([
  {
    id: 'gov-soql-101',
    module: 'apex',
    prompt: 'What is the synchronous Apex governor limit on SOQL queries per transaction?',
    options: ['50', '100', '150', '200'],
    answer: 0,
    explain: 'Synchronous Apex allows 100 SOQL queries; asynchronous allows 200. The figure people most often quote wrong is 50, which is the DML statement limit.'
  },
  {
    id: 'gov-dml-101',
    module: 'apex',
    prompt: 'How many DML statements may a single Apex transaction issue?',
    options: ['100', '150', '200', '50'],
    answer: 1,
    explain: '150 DML statements per transaction. This is why bulkification matters: one statement over a collection, never one per record in a loop.'
  },
  {
    id: 'deploy-coverage',
    module: 'apex',
    prompt: 'What Apex code coverage does a production deployment require?',
    options: ['60%', '70%', '75%', '80%'],
    answer: 2,
    explain: '75% org-wide, and every trigger must have some coverage. Coverage is a deployment gate, not a measure of test quality.'
  },
  {
    id: 'order-of-execution',
    module: 'apex',
    prompt: 'In the order of execution, when do validation rules run relative to before-save triggers?',
    options: [
      'Before the before-save trigger',
      'After the before-save trigger',
      'After the after-save trigger',
      'Validation rules do not run on trigger-modified records'
    ],
    answer: 1,
    explain: 'Before-save triggers and before-save flows run first; system and custom validation rules run after them. A before trigger can therefore make a record fail validation.'
  },
  {
    id: 'sharing-owd',
    module: 'security',
    prompt: 'Which setting determines the baseline access a user has to records they do not own?',
    options: ['Profile', 'Permission set', 'Organisation-wide defaults', 'Role hierarchy'],
    answer: 2,
    explain: 'Organisation-wide defaults set the floor. Role hierarchy, sharing rules and manual sharing only ever open access up from there — they never restrict it.'
  },
  {
    id: 'with-sharing',
    module: 'security',
    prompt: 'An Apex class declared "without sharing" does what?',
    options: [
      'Ignores the running user’s sharing rules',
      'Ignores field-level security as well',
      'Runs as the Automated Process user',
      'Refuses to compile outside a managed package'
    ],
    answer: 0,
    explain: 'It ignores sharing rules, but NOT field-level security or object permissions — those need explicit checks such as Security.stripInaccessible or WITH SECURITY_ENFORCED.'
  },
  {
    id: 'flow-vs-trigger',
    module: 'automation',
    prompt: 'Which automation runs FIRST when a record is saved?',
    options: ['Record-triggered flow (after save)', 'Before-save flow', 'Apex before trigger', 'Workflow rule'],
    answer: 1,
    explain: 'Before-save flows run before Apex before triggers. They are also the cheapest way to set a field on the record being saved, because no extra DML is issued.'
  },
  {
    id: 'data-cloud-dmo',
    module: 'data-cloud',
    prompt: 'In Data Cloud, what is a Data Model Object?',
    options: [
      'A raw copy of an ingested source table',
      'The canonical, harmonised shape that sources are mapped into',
      'A calculated metric published to Tableau',
      'A permission construct for row-level access'
    ],
    answer: 1,
    explain: 'Sources land as Data Lake Objects and are mapped into Data Model Objects, which is where harmonisation and identity resolution happen.'
  },
  {
    id: 'agentforce-grounding',
    module: 'agentforce',
    prompt: 'What does "grounding" mean for an Agentforce agent?',
    options: [
      'Restricting it to a single Salesforce org',
      'Supplying it with retrieved org data so its answers refer to real records',
      'Disabling its ability to take actions',
      'Running it on Hyperforce rather than a pod'
    ],
    answer: 1,
    explain: 'Grounding supplies retrieved context — records, knowledge articles, Data Cloud segments — so the answer is about the customer in front of you rather than a plausible invention.'
  },
  {
    id: 'cpq-price-rule',
    module: 'cpq',
    prompt: 'In Revenue Cloud / CPQ, what does a price rule act on?',
    options: [
      'The opportunity record only',
      'Quote and quote line fields, at a defined calculation event',
      'The order after activation',
      'The renewal contract exclusively'
    ],
    answer: 1,
    explain: 'Price rules fire at a chosen calculator event (On Initialization, Before/On/After Calculate) and inject values into quote and quote line fields.'
  },
  {
    id: 'mulesoft-api-led',
    module: 'mulesoft',
    prompt: 'In MuleSoft’s API-led connectivity, which layer talks directly to the source system?',
    options: ['Experience API', 'Process API', 'System API', 'Gateway policy'],
    answer: 2,
    explain: 'System APIs front the source systems. Process APIs orchestrate across them; Experience APIs shape the result for one consumer.'
  },
  {
    id: 'lwc-wire',
    module: 'lightning',
    prompt: 'What does the @wire decorator in a Lightning Web Component do?',
    options: [
      'Registers an event listener on the DOM',
      'Reads Salesforce data reactively through the Lightning Data Service or an Apex method',
      'Declares a public property settable from the parent',
      'Imports a static resource'
    ],
    answer: 1,
    explain: '@wire is the reactive read. @api declares a public property; @track is now only needed for mutating the internals of objects and arrays.'
  },
  {
    id: 'bulk-api-2',
    module: 'integration',
    prompt: 'What is the main practical difference between Bulk API 2.0 and Bulk API 1.0?',
    options: [
      'Bulk API 2.0 supports SOAP as well as REST',
      'Bulk API 2.0 manages batching for you — you upload the whole file',
      'Bulk API 2.0 has no record limit',
      'Bulk API 2.0 is synchronous'
    ],
    answer: 1,
    explain: 'In 2.0 you create a job, upload the data and Salesforce splits it into batches. In 1.0 you create and manage each batch yourself.'
  },
  {
    id: 'platform-event',
    module: 'integration',
    prompt: 'A platform event published with the "Publish Immediately" behaviour is delivered when?',
    options: [
      'Only after the transaction commits',
      'Immediately, whether or not the transaction later rolls back',
      'On the next scheduled batch run',
      'Only to subscribers inside the same org'
    ],
    answer: 1,
    explain: 'Publish Immediately delivers even if the transaction rolls back — which is the point when you need an audit signal, and a trap when you assumed the record was saved.'
  },
  {
    id: 'sandbox-refresh',
    module: 'devops',
    prompt: 'Which sandbox type can be refreshed most frequently?',
    options: ['Full Copy', 'Partial Copy', 'Developer Pro', 'Developer'],
    answer: 3,
    explain: 'Developer sandboxes refresh once a day. Developer Pro is also daily but larger; Partial Copy is every 5 days; Full Copy every 29.'
  },
  {
    id: 'experience-cloud-audience',
    module: 'experience-cloud',
    prompt: 'What does an Experience Cloud "audience" control?',
    options: [
      'Which licence a member consumes',
      'Which page variation or component a visitor sees',
      'The site’s SEO indexability',
      'Guest user object permissions'
    ],
    answer: 1,
    explain: 'Audiences drive personalisation — page variations, branding sets, component visibility. They are not a security control; guest access is still governed by the guest user profile and sharing.'
  },
  {
    id: 'field-history',
    module: 'platform',
    prompt: 'How many fields per object can be tracked with standard field history tracking?',
    options: ['10', '20', '25', '40'],
    answer: 1,
    explain: '20 fields per object, retained 18–24 months unless Field Audit Trail is licensed. It is the limit most data-migration plans discover late.'
  },
  {
    id: 'external-id-upsert',
    module: 'integration',
    prompt: 'Why does an integration commonly upsert on an External Id field?',
    options: [
      'It is faster than insert',
      'It lets the source system key records without knowing Salesforce Ids',
      'It bypasses validation rules',
      'It is required for Bulk API'
    ],
    answer: 1,
    explain: 'The external system keeps its own key. Upserting on an indexed External Id makes the load idempotent — re-running it updates rather than duplicating.'
  },
  {
    id: 'omni-routing',
    module: 'service-cloud',
    prompt: 'In Omni-Channel, what does a routing configuration primarily define?',
    options: [
      'Which agents exist in the queue',
      'How work items are prioritised and how much capacity each consumes',
      'The case page layout',
      'Business hours'
    ],
    answer: 1,
    explain: 'Routing configurations set priority, routing model and the capacity weight of each work item. Presence configurations decide what an agent can accept.'
  },
  {
    id: 'skinny-table',
    module: 'platform',
    prompt: 'Large data volumes: what is a skinny table?',
    options: [
      'A custom object with fewer than ten fields',
      'A Salesforce-created table joining frequently queried fields to avoid a join at read time',
      'An archived copy of deleted records',
      'A Data Cloud data lake object'
    ],
    answer: 1,
    explain: 'Salesforce Support creates skinny tables; they contain a subset of fields from the base and custom-field tables so reads avoid the join. They are not self-service.'
  }
]);

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

/**
 * The five questions for a date, with their options shuffled.
 *
 * Returns the FULL question, answer included. Only `publicFormOf` may reach a template.
 */
function dailySetFor(dateIso, { size = QUESTIONS_PER_DAY } = {}) {
  const picked = shuffled(QUESTIONS.slice(), rngFrom(seedFor(dateIso, 'pick'))).slice(0, size);

  return picked.map((question) => {
    const order = shuffled(
      question.options.map((label, index) => ({ label, index })),
      rngFrom(seedFor(dateIso, `opts:${question.id}`))
    );
    return {
      id: question.id,
      module: question.module,
      prompt: question.prompt,
      explain: question.explain,
      options: order.map((o) => o.label),
      // Where the correct option ended up after shuffling.
      answer: order.findIndex((o) => o.index === question.answer)
    };
  });
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
  if (QUESTIONS.length < QUESTIONS_PER_DAY) {
    throw new Error(`the bank holds ${QUESTIONS.length} questions but a day needs ${QUESTIONS_PER_DAY}`);
  }
  if (!Number.isInteger(POINTS_PER_CORRECT) || POINTS_PER_CORRECT < 0) {
    throw new Error('points per correct answer must be a non-negative integer');
  }
  return true;
}

module.exports = {
  QUESTIONS_PER_DAY,
  POINTS_PER_CORRECT,
  STREAK_GRACE_DAYS,
  bankSize: () => QUESTIONS.length,
  dailySetFor,
  publicFormOf,
  gradeAnswers,
  serverDate,
  assertChallengeIntegrity
};
