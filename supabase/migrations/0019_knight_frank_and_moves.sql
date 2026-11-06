-- ════════════════════════════════════════════════════════════════
-- Knight Frank joins the tracked rivals, and the people list catches up
-- with the moves found in November 2026.
--
-- Louis Harding left betterhomes in 2026 and is now Partner and Head of
-- Residential at Knight Frank UAE, so he speaks for Knight Frank from now
-- on; his betterhomes row stays as former. Faisal Durrani, Knight Frank's
-- Head of Research for MENA, is among the most quoted voices in Dubai
-- property coverage, so adding Knight Frank will lower betterhomes' share
-- of voice.
-- ════════════════════════════════════════════════════════════════
insert into tracked_keywords (kind, query, label, active)
values ('competitor', 'knight frank dubai', 'Knight Frank', true)
on conflict (kind, query) do update set active = true, label = excluded.label;

insert into tracked_people (name, company, role, aliases, note, source_url, active) values
  ('Louis Harding', 'Knight Frank', 'Partner and Head of Residential, UAE', '{}', 'Joined from betterhomes, reported Sep 2026', 'https://www.consultancy-me.com/news/14474/knight-frank-appoints-louis-harding-as-head-of-residential-business-in-uae', true),
  ('Faisal Durrani', 'Knight Frank', 'Partner and Head of Research, MENA', '{}', 'Quoted on Dubai luxury sales, Jan and Jul 2026', 'https://www.knightfrank.ae/contact/people/aeme257', true),
  ('Will McKintosh', 'Knight Frank', 'Regional Partner and Head of Residential, MENA', '{}', 'Title from 2025; may have changed since Louis Harding joined', 'https://www.consultancy-me.com/news/14474/knight-frank-appoints-louis-harding-as-head-of-residential-business-in-uae', true),
  ('Petri Mannila', 'Knight Frank', 'Partner and Head of Prime Residential', '{}', 'Appointment date not confirmed', 'https://meconstructionnews.com/60552/knight-frank-appoints-petri-mannila-as-partner-and-head-of-prime-residential/amp', true),
  ('Marcus Flacks', 'betterhomes', 'Director of Marketing', '{}', 'Named on the senior team in an undated release', 'https://mid-east.info/?p=296478', true)
on conflict (name, company) do nothing;

update tracked_people
set note = 'Back as CEO by Aug 2026 after Louis Harding left; also CEO of Cencorp, the group that owns betterhomes'
where name = 'Richard Waind' and company = 'betterhomes';

update tracked_people
set role = 'Director of Leasing',
    note = 'Gulf News called him Director of Leasing in Jul 2026; the team page says Director and Head of Global Affiliates. Spelt Simmons in The National, Apr 2025'
where name = 'Rupert Simmonds' and company = 'betterhomes';

update tracked_people
set note = 'Left in 2026; now Partner and Head of Residential at Knight Frank UAE, which is tracked as a rival'
where name = 'Louis Harding' and company = 'betterhomes';
