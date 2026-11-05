-- ════════════════════════════════════════════════════════════════
-- The article store behind the news bot (docs/news-pipeline.md).
--
-- One row per article ever found, kept forever, so the same article is
-- never read or sent to the AI twice. A row moves through the steps:
--
--   queued ──read──▶ read ──check──▶ decided
--      │              (names found)    (the AI sorted it)
--      ├─▶ no_names    read in full, no tracked company or person: free reject
--      ├─▶ unreadable  blocked and the headline names nobody: retried later
--      ├─▶ skipped     another company's name in the headline (Better Homes & Gardens)
--      └─▶ duplicate   the same article as another row (dup_of)
--
-- reading and checking are claims held by one run at a time (claimed_at,
-- claimed_by); a claim older than its lease is taken back, so a run that dies
-- never strands an article. Counted coverage is still written to `mentions`,
-- which is what the PR page reads.
-- ════════════════════════════════════════════════════════════════
create table if not exists news_articles (
  id                text primary key,
  google_link       text,
  url               text,
  url_key           text,
  title             text not null,
  title_key         text not null,
  outlet            text,
  outlet_key        text not null default '',
  published_on      date,
  found_by          text[] not null default '{}',
  status            text not null default 'queued'
                    check (status in ('queued','reading','read','checking','decided','no_names','unreadable','skipped','duplicate','failed')),
  read_attempts     integer not null default 0,
  ai_attempts       integer not null default 0,
  body_status       text,
  body_chars        integer,
  read_via          text,
  candidates        jsonb,
  decision          jsonb,
  legacy_mention_id text,
  dup_of            text,
  note              text,
  error             text,
  next_try_at       timestamptz,
  claimed_at        timestamptz,
  claimed_by        text,
  first_seen_at     timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists news_articles_google_link on news_articles (google_link) where google_link is not null;
create unique index if not exists news_articles_url_key on news_articles (url_key) where url_key is not null and status <> 'duplicate';
create index if not exists news_articles_title_outlet on news_articles (title_key, outlet_key);
create index if not exists news_articles_status on news_articles (status, published_on desc);
create index if not exists news_articles_legacy on news_articles (legacy_mention_id) where legacy_mention_id is not null;

alter table news_articles enable row level security;
do $$ begin
  -- Public news metadata, read by Bot Activity. Writes go through the service role only.
  create policy "public read news_articles" on news_articles for select using (true);
exception when duplicate_object then null; end $$;

-- One row per step a run takes, for Bot Activity and for diagnosing a bad morning.
create table if not exists news_runs (
  id          bigserial primary key,
  run_day     date not null,
  run_id      text not null,
  step        text not null check (step in ('search','read','check','seed','recheck')),
  link        integer not null default 0,
  trigger     text not null default 'cron',
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  counts      jsonb not null default '{}'::jsonb,
  error       text
);
create index if not exists news_runs_day on news_runs (run_day desc, started_at desc);

alter table news_runs enable row level security;
do $$ begin
  create policy "public read news_runs" on news_runs for select using (true);
exception when duplicate_object then null; end $$;

-- Atomically hand a run up to p_limit articles in p_from, moving them to
-- p_to. Rows another run already holds are skipped (SKIP LOCKED), and a claim
-- older than p_lease_seconds is taken back. Newest first, so a backlog never
-- delays this morning's stories.
create or replace function claim_news_articles(p_from text, p_to text, p_limit integer, p_run text, p_lease_seconds integer default 600)
returns setof news_articles
language sql
security invoker
as $$
  update news_articles a
     set status = p_to, claimed_at = now(), claimed_by = p_run, updated_at = now()
   where a.id in (
     select id from news_articles
      where (status = p_from and (next_try_at is null or next_try_at <= now()))
         or (status = p_to and claimed_at < now() - make_interval(secs => p_lease_seconds))
      order by published_on desc nulls last, first_seen_at
      limit p_limit
      for update skip locked)
  returning a.*;
$$;

revoke all on function claim_news_articles(text, text, integer, text, integer) from public, anon, authenticated;
grant execute on function claim_news_articles(text, text, integer, text, integer) to service_role;
