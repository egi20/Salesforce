-- 043 The rate index's share form asks five things, and two old columns stop being required.
--
-- /rates now carries the share form inline: role, engagement, the figure, years of experience
-- and — optionally — the country. `work_mode` is no longer asked, and `country` is optional.
-- Both columns were NOT NULL with `work_mode` defaulting to 'remote', which would have
-- recorded every new figure as remote work nobody said was remote. A default that writes a
-- fact somebody did not give is the same trap as a pre-filled profile answer (migration 038).
--
-- Existing rows keep what they hold. A NULL country is simply not counted in the "By region"
-- tab, and a NULL work mode is not counted anywhere: nothing aggregates on it today.

ALTER TABLE rate_submissions
  MODIFY work_mode ENUM('remote','hybrid','onsite') NULL DEFAULT NULL,
  MODIFY country   CHAR(2) NULL DEFAULT NULL;
