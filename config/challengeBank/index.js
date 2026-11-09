'use strict';

/**
 * The challenge question bank: one JSON file per topic, one question per line, as
 * [id, module, prompt, options, answerIndex, explanation]. DATA ONLY — the rules that keep
 * it off the browser live in `config/challenges.js`, the only module that requires this
 * directory (a test pins that). JSON rather than code so a question is reviewed as text and
 * a diff shows exactly which one changed.
 *
 * Each topic holds at least `MIN_PER_TOPIC` (60) questions. A day uses six from a topic —
 * five for its set and one for the mix — so a smaller bank repeats within days; at 60 a
 * given question comes up for a topic about one day in ten.
 *
 * `answer` is an index into `options` and is NEVER serialised to a client before an
 * attempt is closed. `explain` is shown after grading and names the right option in prose,
 * so it is as secret as `answer` until then.
 *
 * Writing a question: one option must be right in every reading, the other three plainly
 * wrong to somebody who knows. A question with two defensible answers marks a correct
 * player wrong, and nobody can appeal to a bank they cannot see. Two of the first twenty
 * did exactly that and are corrected here:
 *
 *   - `gov-soql-101` marked "50" as the synchronous SOQL limit. It is 100 (the explanation
 *     already said so); every player who knew the limit was scored wrong on it.
 *   - `sandbox-refresh` asked which sandbox refreshes "most frequently" with Developer and
 *     Developer Pro both refreshing daily. Replaced by `sandbox-full-refresh`.
 *
 * Limits quoted here are the documented per-transaction governor limits and platform
 * limits; when Salesforce changes one, change the question in the same commit.
 */

const TOPICS = ['admin-security', 'apex-lwc', 'flow-automation', 'data-integration', 'agentforce-ai', 'sales-service'];

/** Explicit requires, so a missing file fails at boot rather than on first play. */
const FILES = {
  'admin-security': require('./admin-security.json'),
  'apex-lwc': require('./apex-lwc.json'),
  'flow-automation': require('./flow-automation.json'),
  'data-integration': require('./data-integration.json'),
  'agentforce-ai': require('./agentforce-ai.json'),
  'sales-service': require('./sales-service.json')
};

function fromRow(row, topic) {
  if (!Array.isArray(row) || row.length !== 6) throw new Error(`malformed question row in ${topic}: ${JSON.stringify(row).slice(0, 80)}`);
  const [id, module, prompt, options, answer, explain] = row;
  return Object.freeze({ id, module, prompt, options: Object.freeze(options.slice()), answer, explain });
}

const TOPIC_QUESTIONS = Object.freeze(
  Object.fromEntries(TOPICS.map((topic) => [topic, Object.freeze(FILES[topic].map((row) => fromRow(row, topic)))]))
);

module.exports = { TOPIC_QUESTIONS };
