-- ════════════════════════════════════════════════════════════════
-- Share-of-Voice snapshots: daily count of news mentions per brand
-- (betterhomes + competitors), so we can chart real news SoV over time.
-- ════════════════════════════════════════════════════════════════
create table if not exists sov_snapshots (
  id           bigint generated always as identity primary key,
  captured_on  date not null default current_date,
  brand        text not null,
  query        text,
  mentions_30d integer not null default 0,
  created_at   timestamptz not null default now(),
  unique (captured_on, brand)
);

create index if not exists sov_captured_idx on sov_snapshots (captured_on desc);

alter table sov_snapshots enable row level security;
do $$ begin
  create policy "public read sov" on sov_snapshots for select using (true);
exception when duplicate_object then null; end $$;
