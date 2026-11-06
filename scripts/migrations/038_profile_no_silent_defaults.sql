-- 038 A profile states only what its owner chose.
--
-- Availability defaulted to 'not_available', work mode to 'remote' and contract to ticked.
-- The form showed those as if they were answers, so a consultant who pressed Save without
-- looking published three facts nobody had decided. Availability and work mode are now NULL
-- until chosen, and neither type of work is pre-ticked. Rows that already exist keep their
-- values: there is no way to tell a deliberate "remote" from a default one after the fact.
--
-- works_anywhere is the "Anywhere (remote)" choice in the countries picker. It is its own
-- column rather than every country code at once: "anywhere" is a statement about the
-- person, and a list of 250 codes is a statement about a list.

ALTER TABLE consultant_profiles
  MODIFY COLUMN availability ENUM('immediate','two_weeks','one_month','busy','not_available') NULL DEFAULT NULL,
  MODIFY COLUMN work_mode ENUM('remote','hybrid','onsite') NULL DEFAULT NULL,
  MODIFY COLUMN open_to_contract TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN works_anywhere TINYINT(1) NOT NULL DEFAULT 0 AFTER willing_to_travel;
