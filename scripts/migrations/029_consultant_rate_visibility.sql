-- 029 Let a consultant publish a profile without publishing their rate.
--
-- A public profile is how somebody gets found. Their day rate is the number they negotiate
-- with, and the two have never been separable here: listing the profile published the
-- figure. The jobs side has had this since migration 001 — `jobs.rate_visible` lets an
-- employer advertise a role without advertising its budget — and the consultant had no
-- equivalent. The asymmetry was the bug: one side of the market could keep its number back
-- and the other could not.
--
-- DEFAULT 1, because every profile that exists today was published with its rate showing
-- and changing that silently would hide figures their owners chose to publish. Hiding is
-- an action somebody takes.
--
-- The column is only half of it. A figure hidden in the view and still answering the
-- `rate_max` filter is a figure anybody can binary-search — set the filter to 700, then
-- 600, and watch when the profile drops out. `ConsultantProfile.buildFilter` therefore
-- treats a hidden rate as an UNKNOWN one rather than a known one it declines to print, and
-- the rate sorts place it with the profiles that have no rate at all.

ALTER TABLE consultant_profiles
  ADD COLUMN rate_visible TINYINT(1) NOT NULL DEFAULT 1 AFTER currency;
