-- ════════════════════════════════════════════════════════════════
-- Every PIN attempt at the unlock screen, so wrong guesses can be limited
-- (lib/gateLimit.ts, app/api/unlock/route.ts).
--
-- Both PINs are four digits: 10,000 guesses each. The 400 ms pause on every
-- attempt slowed one guess but limited nothing, because requests run side by
-- side: 200 in flight covered every PIN in about 20 seconds. The count has to
-- live here, since serverless instances share no memory and a count kept in
-- one of them would not stop the others.
--
-- One row per attempt. The row is written as a failure before the PIN is
-- compared and set to ok once it proves right, so attempts sent at the same
-- moment all see each other. The unlock route judges at most 8 wrong PINs per
-- address and 60 across all addresses in any 15 minutes, and now and then
-- deletes rows older than a day.
--
-- RLS is on with NO policy, and nothing is granted to anon or authenticated:
-- the rows hold visitors' addresses, and only the service role (the unlock
-- route) reads or writes them.
-- ════════════════════════════════════════════════════════════════
create table if not exists gate_attempts (
  id   bigserial primary key,
  ip   text not null,
  gate text not null,
  ok   boolean not null,
  at   timestamptz not null default now()
);

-- (at): the count across all addresses, and the daily prune.
-- (ip, at): the count for one address.
create index if not exists gate_attempts_at on gate_attempts (at);
create index if not exists gate_attempts_ip_at on gate_attempts (ip, at);

alter table gate_attempts enable row level security;

revoke all on table gate_attempts from public, anon, authenticated;
revoke all on sequence gate_attempts_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table gate_attempts to service_role;
grant usage, select on sequence gate_attempts_id_seq to service_role;
