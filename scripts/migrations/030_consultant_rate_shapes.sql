-- 030 An hourly rate and an expected salary, beside the day rate.
--
-- One figure could not describe the market. A consultant billing by the hour was storing a
-- day rate they had worked out themselves, and one open to a permanent role had nowhere to
-- say what it would take — so the Hub either had the wrong number or no number.
--
-- THE THREE ARE STORED, NOT DERIVED, and that is the whole design decision.
--
-- An hourly rate is not a day rate divided by eight. The divisor is 7, 7.5 or 8 depending
-- on the contract, and a Hub that picked one would be quoting a figure its owner never
-- agreed to — the same objection `utils/contractorEconomics.js` makes to computing tax and
-- `utils/sowEstimation.js` makes to `Math.round(total * pct / 100)`. An expected salary is
-- not a converted day rate either: it is a different engagement, with holiday, sick pay and
-- employer contributions inside it rather than on top. Converting between them would be
-- inventing an assumption and printing it as the consultant's own.
--
-- So each is NULL until somebody types it, each is shown only if it is there, and nothing
-- fills one in from another.
--
-- `annual_salary` is DECIMAL(12,2) rather than (10,2): a day rate tops out in the
-- thousands, a salary in the hundreds of thousands, and in a currency with a small unit
-- (10,2) runs out at 99,999,999.99 — enough, but the column should not be the thing that
-- decides.
--
-- All three are covered by the SINGLE `rate_visible` switch from migration 029. Hiding the
-- day rate while publishing the hourly one would defeat it: multiply by a working day and
-- you are within a few per cent of the number that was meant to be private.

ALTER TABLE consultant_profiles
  ADD COLUMN hourly_rate   DECIMAL(10,2) NULL DEFAULT NULL AFTER day_rate,
  ADD COLUMN annual_salary DECIMAL(12,2) NULL DEFAULT NULL AFTER hourly_rate;
