# betterhomes — Marketing Performance Dashboard

Internal marketing-intelligence hub for **betterhomes** (Cencorp group). Built with
Next.js (App Router) + Chart.js, data in **Supabase**, deployed on **Vercel**.

The first section is **PR & Media** — tracking where betterhomes is mentioned in the
press, across which tiers, with what earned-ad-value (EAV) and reach.

---

## Status

| Section | State |
|---|---|
| **PR & Media** | ✅ Built — live on the parsed clipping history (2020–2026, 1,186 clips) |
| Dashboard / Social / SEO / Blog / Competitors | ⏳ Planned |

### Build roadmap
1. **Schema + import history** ✅ — parse the clipping workbook, define the Supabase schema, render the PR page.
2. **Wire Supabase** — point the app at the DB (swap the JSON import for a query); seed with `scripts/seed_supabase.mjs`.
3. **News ingestion + cron** — daily job finds new mentions, auto-fills tier/EAV/reach from the outlet table, auto-classifies sentiment with Claude, and queues them for review. Replaces the manual "Google → News tab → check one by one" routine.

---

## Architecture

```
Press-clipping workbook ──▶ scripts/parse_clippings.py ──▶ data/*.json (+ .csv)
                                                              │
                                          seed_supabase.mjs   ▼
News API / SerpApi / Apify ─▶ /api/ingest (Vercel Cron) ─▶  Supabase (Postgres)
   (Step 3)                     enrich + Claude sentiment      │
                                                               ▼
                                              Next.js on Vercel  ──▶  dashboard
```

### Data model (`supabase/migrations/0001_pr_media.sql`)
- **`mentions`** — one row per clip (date, tier, outlet, title, url, eav, reach, brand, sentiment, source, status).
- **`outlets`** — reference table seeded from history: each outlet's usual tier + median EAV + reach (used to backfill clips that lack figures).
- **`brands`** — betterhomes + sub-brands (CRC, PRIME, Off-plan, Lomond, BetterStay…).
- **`mentions_enriched` / `pr_monthly` / `pr_annual`** — views the dashboard reads.

### Verified vs modeled
- **Tier, outlet, headline, date, link** come straight from the clipping records.
- **EAV / reach** exist in the source only from 2024 and only partially, so the dashboard
  fills gaps from each outlet's rate-card median and flags those values with `*` ("modeled").
- **Sentiment** is **not** in the source spreadsheet — it's blank today and gets populated
  by the Step-3 ingestion (Claude classification).

---

## Local development

```bash
npm install
npm run dev        # http://localhost:3000  (redirects to /pr)
```

The PR page currently reads `data/mentions.json` + `data/outlets.json` directly, so it
runs with no external services. Step 2 swaps this for a Supabase query.

### Regenerate the data from the workbook
```bash
pip install openpyxl
python3 scripts/parse_clippings.py     # rewrites data/mentions.json, outlets.json, *.csv
```

### Seed Supabase (after Step 2)
```bash
# apply supabase/migrations/0001_pr_media.sql in your project, then:
export SUPABASE_URL=...  SUPABASE_SERVICE_ROLE_KEY=...
node scripts/seed_supabase.mjs
```

See `.env.example` for all configuration.

---

## Repo layout
```
app/                  Next.js routes (/, /pr)
components/           Sidebar, Chart wrapper, PRDashboard
lib/                  types, theme tokens, PR aggregation helpers
data/                 parsed history (json + csv) and the source workbook
scripts/              parse_clippings.py, seed_supabase.mjs
supabase/migrations/  Postgres schema
```
