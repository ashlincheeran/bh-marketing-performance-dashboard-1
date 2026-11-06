-- The status the old bot's row had when its story was imported.
--
-- Until the branch is merged, production runs the old Bot Activity, whose
-- Reject sets a row's status and nothing else. A re-check held in test mode
-- and published later would otherwise put such a row back in the count. A
-- row whose status has changed since the import, with nothing the new bot
-- wrote on it, was changed by a person, and the bot leaves it alone
-- (lib/news/write.ts decidedByPerson).

alter table news_articles add column if not exists legacy_status text;

-- The stories imported so far: their rows' statuses now are the ones they
-- had when imported, earlier the same day.
update news_articles a
   set legacy_status = m.status::text
  from mentions m
 where m.id = a.legacy_mention_id
   and a.legacy_status is null;
