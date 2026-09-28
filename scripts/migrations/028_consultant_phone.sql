-- 028 A phone number on the consultant profile.
--
-- Shown to a viewer under the exact same gate as the email address already is
-- (`canSeeContact` in routes/consultants.js — signed-in company, recruiter or admin
-- accounts, never an anonymous visitor). Nullable and optional: a profile that predates
-- this column, or a consultant who simply does not want to list a number, is not
-- incomplete for lacking one.

ALTER TABLE consultant_profiles
  ADD COLUMN phone VARCHAR(40) NULL DEFAULT NULL AFTER website_url;
