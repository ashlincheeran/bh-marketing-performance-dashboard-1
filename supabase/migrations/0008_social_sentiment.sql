-- ════════════════════════════════════════════════════════════════
-- People & Brand Sentiment across social platforms.
-- Instagram · LinkedIn · Reddit · Glassdoor · Facebook, scraped via Apify
-- and tone-scored by Gemini on a fixed rubric. Subjects = the company
-- (betterhomes) + named individuals (e.g. Rupert Simmonds, Richard Waind).
--
-- Kept separate from the PR `mentions` table so the press view stays clean.
-- ════════════════════════════════════════════════════════════════

create table if not exists social_mentions (
  id               text primary key,        -- stable hash: channel + external id/url + subject
  channel          text not null,           -- instagram|linkedin|reddit|glassdoor|facebook
  subject          text not null,           -- 'betterhomes' | 'Rupert Simmonds' | 'Richard Waind'
  subject_kind     text not null default 'company',  -- company | person
  external_id      text,
  url              text,
  author           text,
  posted_at        timestamptz,
  content          text,
  rating           numeric,                 -- review star rating where applicable (Glassdoor)
  likes            integer not null default 0,
  comments         integer not null default 0,
  shares           integer not null default 0,
  sentiment        sentiment,               -- reuse the PR enum: positive|neutral|negative|mixed
  sentiment_score  numeric,                 -- -1.0 … 1.0 on a fixed rubric (month-over-month safe)
  sentiment_reason text,
  themes           text[] not null default '{}',
  noise_class      text,                    -- recruitment_noise|namesake|job_bot|null
  status           text not null default 'new',  -- new (kept) | rejected (noise/irrelevant)
  source_actor     text,
  query            text,                    -- the search term that surfaced it
  raw              jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists social_mentions_channel_idx on social_mentions (channel, posted_at desc);
create index if not exists social_mentions_subject_idx  on social_mentions (subject);
create index if not exists social_mentions_status_idx   on social_mentions (status);

-- Run log (mirrors ingest_runs) so the tab can show when the social bot last ran.
create table if not exists social_runs (
  id          bigint generated always as identity primary key,
  ran_at      timestamptz not null default now(),
  trigger     text not null default 'manual',
  ok          boolean not null default true,
  found       integer not null default 0,   -- raw items returned by all actors
  considered  integer not null default 0,   -- brand-new items assessed by Gemini
  inserted    integer not null default 0,   -- kept rows
  skipped     integer not null default 0,   -- rejected as noise/irrelevant
  error       text,
  params      jsonb
);
create index if not exists social_runs_ran_at_idx on social_runs (ran_at desc);

-- Single-row config: editable subjects + per-platform source settings, so the
-- tab can define "what to scrape and how" without a code deploy.
create table if not exists social_config (
  id         integer primary key default 1,
  payload    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint social_config_singleton check (id = 1)
);

-- RLS: public read (dashboard is read-only + unauthenticated); writes via service role only.
alter table social_mentions enable row level security;
alter table social_runs     enable row level security;
alter table social_config   enable row level security;

do $$ begin
  create policy "public read social_mentions" on social_mentions for select using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "public read social_runs" on social_runs for select using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "public read social_config" on social_config for select using (true);
exception when duplicate_object then null; end $$;
