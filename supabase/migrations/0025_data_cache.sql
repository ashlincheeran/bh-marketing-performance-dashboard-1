-- Remembered answers for the slow reads (lib/cache.ts): the CRM through
-- Metabase, the SEO and website sources. One row per question; the answer is
-- shown at once and worked out again in the background once it is older than
-- an hour, or marked stale by Refresh everything. Only the service key reads
-- or writes it: row level security is on with no policies.
create table if not exists data_cache (
  key text primary key,
  payload jsonb not null,
  computed_at timestamptz not null,
  stale boolean not null default false,
  refresh_started_at timestamptz
);

alter table data_cache enable row level security;
