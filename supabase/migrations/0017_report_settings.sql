-- ════════════════════════════════════════════════════════════════
-- The weekly email: who gets it, which page, which day, on or off.
--
-- Its own table rather than a key in app_settings, because app_settings is
-- readable by anyone holding the public anon key (the dashboard needs that to
-- show the Supermetrics notice), and a list of colleagues' email addresses
-- must not be. RLS is on with NO policy, so only the service role reads or
-- writes it: the Settings page behind its PIN, and the weekly send.
--
-- Singleton JSON row (id = 1), same pattern as app_settings. Starts OFF with
-- nobody on the list, so applying this sends nothing until someone sets it up.
-- ════════════════════════════════════════════════════════════════
create table if not exists report_settings (
  id         integer primary key default 1,
  payload    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint report_settings_singleton check (id = 1)
);

alter table report_settings enable row level security;

insert into report_settings (id, payload) values (1, '{
  "enabled": false,
  "weekday": 1,
  "page": "/",
  "subject": "Weekly marketing dashboard",
  "intro": "",
  "recipients": []
}'::jsonb)
on conflict (id) do nothing;
