-- Gender and date of birth were asked at sign-up "for aggregate diversity reporting".
-- No such report was ever built and nothing in the application read either column, so they
-- were personal data held with no purpose — and gender and age are the two fields most
-- likely to be read as a basis for discrimination. Data minimisation says do not collect what
-- you do not use, and storage limitation says delete what you hold without a purpose.
--
-- The form no longer asks (2026-11-11), and this drops both columns, which deletes every
-- value already stored. If a diversity report is ever wanted, it starts with a stated
-- purpose, a legal basis and a new column — not with these.
ALTER TABLE users
  DROP COLUMN gender,
  DROP COLUMN date_of_birth;
