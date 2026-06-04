-- ════════════════════════════════════════════════════════════════
-- Row-level security for PR & Media.
-- Applied AFTER the initial data load.
--
-- The dashboard is currently read-only and unauthenticated, so we allow
-- public SELECT. Writes are blocked for anon/authenticated (no write policy),
-- so only the service role (server-side ingestion) can modify data.
-- When we add login, tighten these SELECT policies to `authenticated`.
-- ════════════════════════════════════════════════════════════════

alter table mentions enable row level security;
alter table outlets  enable row level security;
alter table brands   enable row level security;

do $$ begin
  create policy "public read mentions" on mentions for select using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "public read outlets" on outlets for select using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "public read brands" on brands for select using (true);
exception when duplicate_object then null; end $$;

-- Views run as the querying role so the policies above apply through them
-- (and to satisfy the Supabase "security definer view" advisor).
alter view mentions_enriched set (security_invoker = on);
alter view pr_monthly       set (security_invoker = on);
alter view pr_annual        set (security_invoker = on);
