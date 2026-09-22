-- The notification feed behind the bell icon. Applied live on 2026-09-21.
--
-- Two kinds of thing land here, and both must be TRUE rather than hopeful:
--
--   success — a sync that actually changed stored data. Written only after the
--             write is read back, using the counts and timestamps the database
--             itself reports. A notification saying "updated" when the write
--             silently failed is worse than no notification at all.
--
--   warning / error — something upstream is broken or throttled: a Metabase
--             timeout, a Supermetrics row-quota 429, a missing credential.
--
-- DEDUPE. A Metabase timeout fires on every page load, so inserting per
-- occurrence would bury the feed in one repeated problem. dedupe_key is unique:
-- a repeat bumps `count` and `created_at` instead, so the list reads "Metabase
-- leads timed out (x7), last 11:42" — one line, honest about frequency.
--
-- created_at is the LAST occurrence and drives unread state; first_seen_at is
-- when the problem started, which is what tells you whether it is new or
-- long-running.
create table if not exists notifications (
  id            bigserial primary key,
  kind          text not null check (kind in ('success', 'warning', 'error')),
  source        text not null,
  title         text not null,
  body          text,
  dedupe_key    text not null unique,
  count         integer not null default 1,
  first_seen_at timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists notifications_recent_idx on notifications (created_at desc);

alter table notifications enable row level security;
do $$ begin
  create policy "public read notifications" on notifications for select using (true);
exception when duplicate_object then null; end $$;
