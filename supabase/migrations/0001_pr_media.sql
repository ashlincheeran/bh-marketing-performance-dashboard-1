-- ════════════════════════════════════════════════════════════════
-- betterhomes Marketing Hub — PR & Media schema (Step 1)
-- Holds the press-clipping history + ongoing scraped mentions.
-- ════════════════════════════════════════════════════════════════

-- ── enums ───────────────────────────────────────────────────────
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

-- ── brands (betterhomes + sub-brands tracked in the clippings) ──
create table if not exists brands (
  id    text primary key,   -- slug, e.g. 'betterhomes', 'crc', 'prime'
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
  default_eav   integer,        -- median earned-ad-value from the rate card
  default_reach integer,        -- median audience reach
  rate_card_url text,
  clip_count    integer not null default 0,
  first_seen    date,
  last_seen     date,
  created_at    timestamptz not null default now()
);

-- ── mentions (one row per press clip) ───────────────────────────
create table if not exists mentions (
  id          text primary key,           -- stable hash (see scripts/parse_clippings.py)
  published_on date,
  tier        media_tier not null default 'Other',
  outlet_id   bigint references outlets(id) on delete set null,
  outlet_name text,                        -- denormalized for fast display
  title       text,
  url         text,
  eav         integer,                     -- raw value from the clipping (nullable)
  reach       integer,                     -- raw value from the clipping (nullable)
  brand       text references brands(id) on delete set null,
  sentiment   sentiment,                   -- null until enriched by the ingestion step
  sentiment_rationale text,
  source      text not null default 'historical_import',  -- historical_import | newsdata | serpapi | apify | manual
  status      mention_status not null default 'reviewed',
  raw         jsonb,                        -- original provider payload (scraped items)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists mentions_published_on_idx on mentions (published_on desc);
create index if not exists mentions_tier_idx          on mentions (tier);
create index if not exists mentions_brand_idx         on mentions (brand);
create index if not exists mentions_status_idx        on mentions (status);
create index if not exists mentions_outlet_idx        on mentions (outlet_id);

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
  (m.reach is null and coalesce(o.default_reach, 0) > 0) as reach_modeled
from mentions m
left join outlets o on o.id = m.outlet_id;

-- ── handy aggregates for the dashboard ──────────────────────────
create or replace view pr_monthly as
select
  date_trunc('month', published_on)::date as month,
  tier,
  count(*)            as clips,
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

-- ── row-level security ──────────────────────────────────────────
-- The Next.js server reads/writes with the service-role key (bypasses RLS).
-- These policies allow signed-in users to read once we add auth.
alter table mentions enable row level security;
alter table outlets  enable row level security;
alter table brands   enable row level security;

do $$ begin
  create policy "read mentions" on mentions for select to authenticated using (true);
  create policy "read outlets"  on outlets  for select to authenticated using (true);
  create policy "read brands"   on brands   for select to authenticated using (true);
exception when duplicate_object then null; end $$;
