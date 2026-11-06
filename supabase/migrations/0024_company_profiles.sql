-- Every company the news bot tracks, editable in PR & Media settings: its
-- other spellings and its own websites, beside the name and the Google News
-- search the table already holds. Until now both lists were written in the
-- code (lib/news/registry.ts COMPANY_ALIASES, lib/news/ownSite.ts
-- COMPANY_SITES); the values below are exactly those, so nothing the bot does
-- changes with this migration.
--
--   aliases  every way the press writes a rival. Empty means its name alone.
--            A rival's name that is also an ordinary word (Metropolitan) is
--            left out on purpose, so it never matches by itself.
--   sites    the company's own websites: a story published there never counts
--            for it. "name.*" is the name under any ending (knightfrank.*).
--
-- betterhomes gets a row of its own (kind 'us') to hold its websites. Its
-- spellings stay in the code, behind the strict rules that keep Better Homes
-- & Gardens out (lib/match.ts), and its searches are the 'pr' keywords.
--
-- news_runs.env: which deployment ran the step, so the live Bot Activity
-- shows the live bot's runs only. Every run before this migration was a test
-- on the preview.

alter table tracked_keywords add column if not exists aliases text[] not null default '{}';
alter table tracked_keywords add column if not exists sites text[] not null default '{}';
-- 'us' joins 'pr' and 'competitor': the one row holding betterhomes' own websites.
alter table tracked_keywords drop constraint if exists tracked_keywords_kind_check;
alter table tracked_keywords add constraint tracked_keywords_kind_check check (kind in ('pr', 'competitor', 'us'));

update tracked_keywords as k
   set aliases = v.aliases, sites = v.sites
  from (values
    ('Allsopp & Allsopp', array['Allsopp & Allsopp', 'Allsopp and Allsopp', 'Allsopp Allsopp'], array['allsoppandallsopp.com']),
    ('Haus & Haus', array['Haus & Haus', 'haus & haus', 'haus and haus'], array['hausandhaus.com']),
    ('Driven Properties', array['Driven Properties', 'Driven | Forbes Global Properties', 'Driven Forbes Global Properties'], array['drivenproperties.com']),
    ('Engel & Völkers', array['Engel & Völkers', 'Engel & Volkers', 'Engel and Volkers', 'Engel and Völkers', 'Engel Volkers', 'Engel & Voelkers', 'Engel and Voelkers', 'Engel Voelkers'], array['engelvoelkers.*']),
    ('Metropolitan', array['Metropolitan Premium Properties', 'Metropolitan Group', 'Metropolitan Homes'], array['metropolitan.realestate']),
    ('Sotheby''s', array['Sotheby''s International Realty', 'Sotheby''s Realty', 'Dubai Sotheby''s', 'Dubai Sotheby''s International Realty', 'Luxhabitat Sotheby''s', 'Luxhabitat Sotheby''s International Realty', 'Luxhabitat', 'Sotheby''s'], array['sothebysrealty.*', 'luxhabitat.ae']),
    ('White & Co', array['White & Co', 'White & Co.', 'White and Co', 'White & Co Real Estate'], array['whiteandcogroup.com', 'whiteandco.ae']),
    ('fäm Properties', array['fäm Properties', 'fam Properties', 'fäm Real Estate'], array['famproperties.com']),
    ('Knight Frank', array['Knight Frank', 'Knight Frank UAE'], array['knightfrank.*'])
  ) as v(label, aliases, sites)
 where k.kind = 'competitor' and k.label = v.label;

insert into tracked_keywords (kind, query, label, active, sites)
select 'us', 'betterhomes', 'betterhomes', true, array['bhomes.com', 'betterhomes.ae']
 where not exists (select 1 from tracked_keywords where kind = 'us');

alter table news_runs add column if not exists env text;
update news_runs set env = 'preview' where env is null;
