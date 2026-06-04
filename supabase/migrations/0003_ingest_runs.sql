-- ════════════════════════════════════════════════════════════════
-- Bot run log — records each ingestion run so the dashboard can show
-- when the auto-updater last ran and what it did.
-- ════════════════════════════════════════════════════════════════
create table if not exists ingest_runs (
  id          bigint generated always as identity primary key,
  ran_at      timestamptz not null default now(),
  trigger     text not null default 'cron',   -- 'cron' | 'manual'
  ok          boolean not null default true,
  found       integer not null default 0,      -- articles returned by Google News
  considered  integer not null default 0,      -- fresh candidates assessed
  inserted    integer not null default 0,      -- new clips added
  updated     integer not null default 0,      -- existing clips date-backfilled
  skipped     integer not null default 0,      -- judged not-betterhomes
  error       text
);

create index if not exists ingest_runs_ran_at_idx on ingest_runs (ran_at desc);

alter table ingest_runs enable row level security;
do $$ begin
  create policy "public read ingest_runs" on ingest_runs for select using (true);
exception when duplicate_object then null; end $$;
