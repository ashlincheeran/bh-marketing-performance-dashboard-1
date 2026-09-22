-- ════════════════════════════════════════════════════════════════
-- Rework the PR search list around what the coverage sheet actually contains.
--
-- Measured against the PR team's own Aug–Sep 2026 log: the bot pulled ten
-- articles into its candidate list and nine of them are on that sheet. So the
-- old list was not failing to FIND coverage — it was drowning it. Eight of the
-- fourteen PR queries named no brand at all, and each run only has budget for a
-- couple of dozen articles, so generic terms crowded out the ones that matter.
--
-- Two changes:
--   1. Retire the queries that carry no brand and no topic value. "webinar" is
--      a global word with nothing to do with Dubai property; "property market
--      updates" and "dubai communities" return open-ended archive.
--   2. Add the brand forms lib/match.ts already accepts but nobody ever
--      searched for ("better homes" spaced, "bhomes"), the people who get
--      quoted without the brand in the headline, and the topics the sheet's own
--      stories sit on.
--
-- Retired rather than deleted: active=false keeps them visible in Settings, so
-- the team can see what was dropped and switch any of it back on.
-- ════════════════════════════════════════════════════════════════

update tracked_keywords
   set active = false
 where kind = 'pr'
   and query in ('webinar', 'property market updates', 'dubai communities');

insert into tracked_keywords (kind, query, label) values
  -- brand forms the matcher accepts but the search list never used
  ('pr', 'betterhomes', null),
  ('pr', 'better homes dubai', null),
  ('pr', 'bhomes', null),
  -- how we are usually credited: as the source of the numbers
  ('pr', 'betterhomes data', null),
  ('pr', 'betterhomes analysis dubai', null),
  -- named spokespeople; they are quoted in stories whose headline never says
  -- "betterhomes", which is exactly the coverage that was being missed
  ('pr', 'Richard Waind', null),
  ('pr', 'Alex Leigh betterhomes', null),
  -- topics carrying our commentary in the Aug–Sep sheet
  ('pr', 'dubai prime property', null),
  ('pr', 'dubai golden visa property', null),
  ('pr', 'dubai branded residences', null),
  ('pr', 'dubai residential market report', null),
  ('pr', 'dubai land department data', null)
on conflict (kind, query) do update set active = true;
