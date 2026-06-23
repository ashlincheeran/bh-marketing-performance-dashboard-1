-- AI-generated competitive insights, cached so the dashboard renders fast and
-- only regenerates after a bot run or a manual "Refresh" click (not per page load).
create table if not exists insights_cache (
  scope text primary key,
  payload jsonb not null,
  source text not null default 'ai',
  generated_at timestamptz not null default now()
);

alter table insights_cache enable row level security;

drop policy if exists "insights_cache anon read" on insights_cache;
create policy "insights_cache anon read" on insights_cache
  for select to anon, authenticated using (true);
