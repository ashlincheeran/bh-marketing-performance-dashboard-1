-- Daily paid-media rows cached from Supermetrics, plus a per-day sync ledger.
-- Applied live on 2026-09-21. See lib/paidStore.ts for how they are used.
--
-- Why: Supermetrics bills a monthly ROW quota and every page load re-fetched the
-- whole window per selected account. The API already returns one row per DATE
-- (date is the first requested dimension), so the daily grain was always there
-- and being aggregated away. Keeping it means a day is fetched once and read
-- forever.
--
-- The primary key is the natural grain of a Supermetrics row, so re-fetching a
-- day UPSERTS over it rather than duplicating — that is what makes re-syncing a
-- restated day safe.
--
-- adset_k / ad_k exist because NULL is not equal to NULL in a unique index: at
-- campaign level both are null, so without a non-null stand-in the same row
-- could be inserted endlessly. Generated, so the nullable columns keep their
-- real meaning for reads.
create table if not exists paid_daily (
  date                date    not null,
  platform            text    not null,
  account_id          text    not null,
  level               text    not null,
  campaign            text    not null,
  adset               text,
  ad                  text,
  adset_k             text generated always as (coalesce(adset, '')) stored,
  ad_k                text generated always as (coalesce(ad, '')) stored,
  account_name        text,
  campaign_id         text,
  granularity         text,
  objective           text,
  goal                text,
  currency            text,
  impressions         numeric not null default 0,
  clicks              numeric not null default 0,
  cost                numeric not null default 0,
  result              numeric not null default 0,
  result_label        text,
  link_clicks         numeric,
  website_conversions numeric,
  website_leads       numeric,
  facebook_leads      numeric,
  conversions         numeric,
  synced_at           timestamptz not null default now(),
  constraint paid_daily_pk primary key
    (date, platform, account_id, level, campaign, adset_k, ad_k)
);

create index if not exists paid_daily_range_idx on paid_daily (date, platform, account_id, level);

alter table paid_daily enable row level security;
do $$ begin
  create policy "public read paid_daily" on paid_daily for select using (true);
exception when duplicate_object then null; end $$;

-- Which (account, level, day) has actually been fetched.
--
-- This is the date check that stops data being missed. A row here means that day
-- was fetched and stored; its ABSENCE means the day is a gap and must be
-- fetched, even if the days either side are present. Tracking a single "last
-- updated" date instead would silently skip any day whose fetch failed.
--
-- rows = how many records came back. Zero is recorded rather than left absent: a
-- day with no spend is a real answer, and without this it would be re-fetched
-- forever.
create table if not exists paid_sync_days (
  platform   text not null,
  account_id text not null,
  level      text not null,
  date       date not null,
  rows       integer not null default 0,
  synced_at  timestamptz not null default now(),
  constraint paid_sync_days_pk primary key (platform, account_id, level, date)
);

alter table paid_sync_days enable row level security;
do $$ begin
  create policy "public read paid_sync_days" on paid_sync_days for select using (true);
exception when duplicate_object then null; end $$;
