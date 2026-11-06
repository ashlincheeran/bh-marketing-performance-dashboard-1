-- Test mode for the news bot.
--
-- Production and the preview share this database, so a test run on the
-- preview would otherwise change the live PR tab before the branch is merged.
-- With counting off (app_settings.payload.news.countOnPrTab = false) the check
-- step still asks the AI and saves its decision, but marks the article held
-- instead of writing it to mentions. Bot Activity shows held articles, so the
-- PR team can see what the bot would count before it counts. Turning counting
-- back on runs the publish step, which writes every held decision and marks
-- it decided.
--
--   read ──check──▶ held ──publish──▶ decided      (counting off, then on)
--   read ──check──▶ decided                       (counting on)

alter table news_articles drop constraint if exists news_articles_status_check;
alter table news_articles add constraint news_articles_status_check
  check (status in ('queued','reading','read','checking','decided','held','no_names','unreadable','skipped','duplicate','failed'));

alter table news_runs drop constraint if exists news_runs_step_check;
alter table news_runs add constraint news_runs_step_check
  check (step in ('search','read','check','seed','recheck','publish'));
