-- ════════════════════════════════════════════════════════════════
-- Tracked keywords: the bot's search list, editable from the dashboard.
-- Moving this out of code/env means add/remove works from the UI and the
-- next run (cron or "Run now") uses the live list — no redeploy.
--   kind='pr'         → betterhomes searches (Gemini still filters relevance)
--   kind='competitor' → SoV + competitor-news searches (label = display name)
-- ════════════════════════════════════════════════════════════════
create table if not exists tracked_keywords (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('pr', 'competitor')),
  query       text not null,
  label       text,                      -- display name (competitors)
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (kind, query)
);

create index if not exists tracked_keywords_kind_idx on tracked_keywords (kind, active);

alter table tracked_keywords enable row level security;
do $$ begin
  create policy "public read tracked_keywords" on tracked_keywords for select using (true);
exception when duplicate_object then null; end $$;

-- ── seed: betterhomes searches (Louis removed; Richard Waind + CEO + market terms added) ──
insert into tracked_keywords (kind, query, label) values
  ('pr', 'betterhomes dubai', null),
  ('pr', 'betterhomes dubai property market', null),
  ('pr', 'betterhomes real estate', null),
  ('pr', 'PRIME by betterhomes', null),
  ('pr', 'Richard Waind betterhomes', null),
  ('pr', 'CEO betterhomes', null),
  ('pr', 'property market updates', null),
  ('pr', 'webinar', null),
  ('pr', 'dubai real estate', null),
  ('pr', 'dubai property markets', null),
  ('pr', 'dubai mortgage', null),
  ('pr', 'dubai offplan', null),
  ('pr', 'dubai secondary market', null),
  ('pr', 'dubai communities', null)
on conflict (kind, query) do nothing;

-- ── seed: competitors (Metropolitan added; CEO names left for the team to add in-app) ──
insert into tracked_keywords (kind, query, label) values
  ('competitor', 'haus and haus dubai', 'Haus & Haus'),
  ('competitor', 'engel volkers dubai', 'Engel & Völkers'),
  ('competitor', 'allsopp and allsopp dubai', 'Allsopp & Allsopp'),
  ('competitor', 'sothebys realty dubai', 'Sotheby''s'),
  ('competitor', 'driven properties dubai', 'Driven Properties'),
  ('competitor', 'white and co real estate dubai', 'White & Co'),
  ('competitor', 'metropolitan premium properties dubai', 'Metropolitan')
on conflict (kind, query) do nothing;
