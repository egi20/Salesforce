-- 027 Remove the `partner` role.
--
-- IT GRANTED NOTHING. `is_partner` has been on `users` since migration 001. It is written
-- at registration, read back into the session as `isPartner`, listed in the data export and
-- cleared on erasure — and no route, no view and no middleware has ever asked for it. A
-- grep across routes/, views/, middleware/ and config/ for `isPartner` returns nothing.
--
-- That mattered because of what the codebase CLAIMED about it. `models/User.js` said, in
-- the comment that justifies keeping `partner` out of `PUBLIC_ROLES`, that "a partner
-- account carries a commission rate, which is why the reference's `user_types[]=partner`
-- POST was a real escalation". The first half is true of the reference and false here: the
-- referral rate comes from `config/referrals.js` DEFAULT_RATE_BPS for every account that
-- enrols, partner or not. So the role was a security argument standing on a fact that was
-- not true — and documentation that is wrong is more dangerous than documentation that is
-- missing, because people build on it. This file is the other half of that correction;
-- `models/User.js` now says the line is `admin`, which is true.
--
-- The filter on public registration STAYS, and so does its test. `User.PUBLIC_ROLES` is
-- still an allowlist and `addSelfServiceRoles` still never removes or grants a privileged
-- flag. Removing one dormant entry from the list does not relax the mechanism.
--
-- Safe to run: verified against this database before writing it — zero rows with
-- `is_partner = 1` and zero with `user_type = 'partner'`. The UPDATE is a belt-and-braces
-- step for any deployment where that is not true, and it runs BEFORE the ENUM changes,
-- because MySQL would otherwise coerce an out-of-range value to '' and leave a row whose
-- type is empty rather than wrong-but-readable.
--
-- If partners become a real thing later, the role comes back with the meaning it has then,
-- in a migration of its own. A flag kept against a future that has not been designed is a
-- flag nobody can reason about today.

UPDATE users SET user_type = 'consultant' WHERE user_type = 'partner';

ALTER TABLE users
  MODIFY COLUMN user_type ENUM('consultant','company','recruiter','admin') NOT NULL DEFAULT 'consultant';

ALTER TABLE users DROP COLUMN is_partner;
