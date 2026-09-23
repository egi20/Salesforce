-- 023 Account erasure.
--
-- WHY THIS IS NOT `DELETE FROM users`.
--
-- The privacy policy promised "ask us and your account and its data are removed" and nothing
-- in the application could do it. The obvious implementation — delete the row and let the
-- foreign keys cascade — is wrong three separate ways, and each one is a rule this codebase
-- already states somewhere else:
--
-- 1. `rate_submissions` cascades. Deleting a person's contributed figures silently moves a
--    PUBLISHED percentile for everybody. CLAUDE.md: there is deliberately no path to correct
--    or remove a figure, because an aggregate whose inputs can be edited is an aggregate
--    nobody should trust. Erasure must not become that path by the back door.
-- 2. `posts` and `post_replies` cascade. `posts.reply_count` is maintained in the same
--    transaction as the row it counts and NOTHING recomputes it, so a reply vanishing from
--    under somebody else's question leaves that counter permanently wrong — and an accepted
--    answer disappearing leaves the question pointing at nothing.
-- 3. `payments` and `invoices` cascade. Those are financial records with a statutory
--    retention period, and the right to erasure does not override a legal obligation to keep
--    them. Deleting them to satisfy a privacy request creates a different legal problem.
--
-- So erasure ANONYMISES. Every field that identifies a person is destroyed or overwritten;
-- the rows that belong to somebody else's record, to an aggregate, or to a legal obligation
-- survive with nothing left to tie them to a human being. Once the link is severed, a day
-- rate in a percentile is not personal data any more, which is exactly why the aggregate can
-- stay honest and the promise can still be kept.
--
-- This column is the record that it happened and when. It is NOT a soft-delete flag people
-- can undo: `models/AccountErasure.js` destroys the underlying data in the same transaction,
-- and there is no route that reverses it.

ALTER TABLE users
  ADD COLUMN anonymised_at DATETIME NULL DEFAULT NULL AFTER is_active,
  ADD KEY idx_users_anonymised (anonymised_at);
