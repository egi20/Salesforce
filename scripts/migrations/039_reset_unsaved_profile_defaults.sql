-- 039 Clear the old defaults on profiles nobody has saved yet.
--
-- 038 stopped NEW profiles starting as "Not available / Remote / Contract", but a profile row
-- is created the moment the consultant role is added, so every consultant who added the role
-- before 038 and has not yet saved the form still opens it pre-filled with three answers
-- nobody gave. Those rows are recognisable: still exactly the old defaults, and nothing a
-- save writes has ever been set — no title, bio, role, country or figure. For them the three
-- columns go back to unanswered. Any row with any of that filled in was saved by a person and
-- is left exactly as it is.

UPDATE consultant_profiles
   SET availability = NULL, work_mode = NULL, open_to_contract = 0
 WHERE availability = 'not_available'
   AND work_mode = 'remote'
   AND open_to_contract = 1
   AND open_to_permanent = 0
   AND headline IS NULL
   AND bio IS NULL
   AND primary_role IS NULL
   AND country IS NULL
   AND day_rate IS NULL
   AND hourly_rate IS NULL
   AND annual_salary IS NULL;
