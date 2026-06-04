-- ════════════════════════════════════════════════════════════════
-- betterhomes Marketing Hub — PR & Media schema
-- Press-clipping history + ongoing scraped mentions.
-- Designed to scale: extendable enums, flexible `tags`, and a `metadata`
-- catch-all so new attributes don't require a migration. Other dashboard
-- sections (social, seo, blog, competitors) will add their own tables.
-- ════════════════════════════════════════════════════════════════

-- ── enums (values can be added later with ALTER TYPE … ADD VALUE) ─
do $$ begin
  create type media_tier as enum ('T1-Global', 'T1-Local', 'T2', 'T3', 'Other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type sentiment as enum ('positive', 'neutral', 'negative', 'mixed');
exception when duplicate_object then null; end $$;

do $$ begin
  -- imported history is trusted; scraped items land as 'new' for review.
  create type mention_status as enum ('new', 'reviewed', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type media_format as enum
    ('online', 'print', 'press_release', 'podcast', 'radio', 'tv', 'social', 'other');
exception when duplicate_object then null; end $$;

-- ── brands (betterhomes + sub-brands tracked in the clippings) ──
create table if not exists brands (
  id    text primary key,   -- slug, e.g. 'betterhomes', 'CRC', 'PRIME'
  name  text not null
);

insert into brands (id, name) values
  ('betterhomes',  'betterhomes'),
  ('CRC',          'CRC'),
  ('PRIME',        'PRIME by Betterhomes'),
  ('Off-plan',     'Off-plan'),
  ('Lomond',       'Lomond'),
  ('BetterStay',   'BetterStay'),
  ('BH Mortgages', 'BH Mortgages'),
  ('Top 50 Homes', 'Top 50 Homes'),
  ('Linda''s',     'Linda''s'),
  ('Cencorp',      'Cencorp')
on conflict (id) do nothing;

-- ── outlets (reference table: tier + rate-card EAV / reach) ─────
create table if not exists outlets (
  id            bigint generated always as identity primary key,
  name          text not null unique,
  tier          media_tier not null default 'Other',
  country       text,
  language      text,
  default_eav   integer,        -- median earned-ad-value from the rate card
  default_reach integer,        -- median audience reach
  rate_card_url text,
  clip_count    integer not null default 0,
  first_seen    date,
  last_seen     date,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

-- ── mentions (one row per press clip) ───────────────────────────
create table if not exists mentions (
  id           text primary key,          -- stable hash (scripts/parse_clippings.py)
  published_on date,
  tier         media_tier not null default 'Other',
  outlet_id    bigint references outlets(id) on delete set null,
  outlet_name  text,                       -- denormalized for fast display
  title        text,
  url          text,
  eav          integer,                    -- raw value from the clipping (nullable)
  reach        integer,                    -- raw value from the clipping (nullable)
  brand        text references brands(id) on delete set null,
  sentiment    sentiment,                  -- null until enriched
  sentiment_rationale text,
  media_type   media_format not null default 'other',
  language     text,                        -- 'en', 'ar', …
  tags         text[] not null default '{}',-- market-report, leasing, leadership, …
  source       text not null default 'historical_import', -- historical_import | newsdata | serpapi | apify | manual
  status       mention_status not null default 'reviewed',
  metadata     jsonb not null default '{}'::jsonb,  -- catch-all for future attributes
  raw          jsonb,                        -- original provider payload (scraped items)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists mentions_published_on_idx on mentions (published_on desc);
create index if not exists mentions_tier_idx          on mentions (tier);
create index if not exists mentions_brand_idx         on mentions (brand);
create index if not exists mentions_status_idx        on mentions (status);
create index if not exists mentions_outlet_idx        on mentions (outlet_id);
create index if not exists mentions_tags_idx          on mentions using gin (tags);

-- keep updated_at fresh
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists mentions_updated_at on mentions;
create trigger mentions_updated_at before update on mentions
  for each row execute function set_updated_at();

-- ── enriched view: fill EAV/reach from the outlet rate card ─────
create or replace view mentions_enriched as
select
  m.*,
  coalesce(m.eav,   o.default_eav,   0) as eav_eff,
  coalesce(m.reach, o.default_reach, 0) as reach_eff,
  (m.eav   is null and coalesce(o.default_eav,   0) > 0) as eav_modeled,
  (m.reach is null and coalesce(o.default_reach, 0) > 0) as reach_modeled,
  o.country as outlet_country
from mentions m
left join outlets o on o.id = m.outlet_id;

-- ── handy aggregates for the dashboard ──────────────────────────
create or replace view pr_monthly as
select
  date_trunc('month', published_on)::date as month,
  tier,
  count(*)               as clips,
  sum(eav_eff)::bigint   as eav,
  sum(reach_eff)::bigint as reach
from mentions_enriched
where published_on is not null
group by 1, 2;

create or replace view pr_annual as
select
  extract(year from published_on)::int as year,
  tier,
  count(*) as clips
from mentions_enriched
where published_on is not null
group by 1, 2;
