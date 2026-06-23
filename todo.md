# TODO — Apify-dependent work (social, reviews, competitor socials)

This file is the hand-off for a Claude session that **has the Apify connector / `APIFY_TOKEN`**.
Everything here was *not* buildable in the session that created this file because that sandbox
could not reach `api.apify.com` (network allow-list blocked it). The PR-side of the dashboard
(news, Share of Voice, competitor news, competitive insights) is already live and reads from
Supabase. The job below is to fill the **Social & Reviews** tab and add **social Share of Voice
vs competitors**.

> Golden rule, learned from auditing a fabricated report: **never invent numbers.** Every
> aggregate must trace to stored rows, every timestamp comes from the platform record (not the
> report period), and every card states its "mention universe" explicitly.

---

## 0. Prerequisites
- [ ] Apify connector enabled for the session **or** `APIFY_TOKEN` set as an env var.
- [ ] For local testing from a sandbox: add `api.apify.com` to the network allow-list.
- [ ] In **Vercel** → Project → Settings → Environment Variables: add `APIFY_TOKEN`
      (production runs call Apify from Vercel, which already has open egress).
- [ ] Confirm reachability: `GET https://api.apify.com/v2/acts?token=$APIFY_TOKEN` → 200.

## 1. Data model (Supabase)
Reuse the existing `mentions` patterns but keep social separate so the PR view stays clean.
- [ ] New migration `supabase/migrations/0006_social.sql`:
  - `social_mentions` — one row per post/review:
    `id text pk, channel text (instagram|linkedin|facebook|reddit|trustpilot),
     brand text (betterhomes | competitor name), is_competitor bool default false,
     external_id text, url text, author text, posted_at timestamptz,
     content text, rating numeric null, likes int, comments int, shares int,
     sentiment sentiment null, sentiment_score numeric null, theme text[],
     noise_class text null (recruitment_noise|job_bot|namesake_brand|null),
     source_actor text, raw jsonb, created_at timestamptz default now()`.
  - Indexes on `(channel, posted_at desc)`, `(brand)`, `(is_competitor)`.
  - RLS: public read (mirror `0002_pr_media_rls.sql`), writes via service role only.
  - `social_sov_snapshots` (optional) mirroring `sov_snapshots` but per channel.

## 2. Ingestion — one fetch module per source
Call pattern (sync): `POST https://api.apify.com/v2/acts/{actorId}/run-sync-get-dataset-items?token=$APIFY_TOKEN`
with the actor input JSON. Actor IDs use `~` in the URL (e.g. `automation-lab~trustpilot`).
Always set a `maxItems`/`maxPosts` cap — uncapped runs are the only real cost risk.

### 2.1 Trustpilot — `automation-lab/trustpilot`
- Input: `{"companyUrls":["bhomes.com"],"maxReviewsPerCompany":25,"languages":["en"],"sort":"recency","date":"last3months","includeCompanyInfo":true}`
- Fields: `reviewId, reviewUrl, title, text, rating, publishedDate, experienceDate, authorName, country, replyMessage, companyTrustScore, companyTotalReviews`.
- [ ] **Dedupe by `reviewId`** (actor returned dupes in testing).
- [ ] **Post-filter `publishedDate` yourself** — the `last3months` preset leaked older reviews.
- Cost ≈ $0.0006/review (~$2 one-off for full ~2,900-review backfill).
- Proof run (verify in console): run `tPuAN9e6sHecdT3j0`, dataset `6gjcoUYkPn9AFlCd7`.

### 2.2 LinkedIn — `harvestapi/linkedin-post-search` (no cookies/login)
- Input: `{"searchQueries":["Betterhomes Dubai"],"maxPosts":15,"postedLimit":"month","sortBy":"date","profileScraperMode":"short"}`
- Fields: `content, linkedinUrl, author{name,type,followers}, postedAt.date, engagement{likes,comments,shares}, contentAttributes`.
- [ ] **High-precision mention filter:** keep posts where `contentAttributes[].company.id == "17927"`
      (betterhomes = `linkedin.com/company/better-homes-llc`) rather than string matching.
- [ ] Classify & exclude `recruitment_noise` (job aggregators like LiveuaeJobs; job-seeker posts tagging many agencies).
- [ ] Report as **"indexed mentions"**, not absolute totals (search isn't exhaustive).
- Companion actors (same dev): `linkedin-company-posts` (owned), `linkedin-post-comments`, `linkedin-post-reactions`.
- Proof run: run `wJRlkCfNaHM2JsV9E`, dataset `L40z6XEPRLeSndUuK`.

### 2.3 Instagram — two-method (important)
- [ ] **Do NOT use generic hashtag scraping.** `#betterhomes` is polluted by betterhomes.de,
      Better Homes & Gardens (US), etc. (Tested: 0/12 were the Dubai brand.)
- [ ] **Primary:** `data-slayer/instagram-tagged-posts` with `{"username":"betterhomesuae","maxResults":10}` (10/10 genuine in testing).
- [ ] **Fallback** (community actor ~79% reliable): `apify/instagram-scraper` (99.8%) on the
      @betterhomesuae profile + tags `#betterhomesuae` / `#bhomes`. Try primary, fall back on failure.
- [ ] Records are huge — fetch with field selection:
      `GET /v2/datasets/{id}/items?clean=true&fields=code,taken_at_date,like_count,comment_count,caption.text,user.username,user.full_name&flatten=caption,user`
- Post URL: `https://www.instagram.com/p/{code}/`.
- Proof runs: tagged `f5djMbPv8lWZ0WvQs` / dataset `NPjyaU4y5NaZcr3eq`; hashtag-FAIL `ysIezjwU2EX7fQtMM`.

### 2.4 Reddit — `trudax/reddit-scraper-lite`
- Input: `{"searches":["betterhomes dubai"],"searchPosts":true,"searchComments":true,"sort":"new","time":"year","maxItems":20,"skipCommunity":true,"skipUserPosts":true,"includeNSFW":false,"proxy":{"useApifyProxy":true,"apifyProxyGroups":["RESIDENTIAL"]}}`
- [ ] **Run query variants and dedupe:** `"betterhomes dubai"`, `"better homes dubai"`, `"bhomes"`.
- Output: posts + comments with permanent URLs, `createdAt`, subreddit, author.
- Proof run: run `cymD7fLg0lZmbKFDR`, dataset `I83CljZAVvuYX0Uqq`.

### 2.5 Facebook
- [ ] Select an Apify Facebook actor (page posts + public mentions), mirror the pattern above.

## 3. Normalize → dedupe → classify → score
- [ ] Map every source into the `social_mentions` row schema above.
- [ ] Dedupe per source key (reviewId / post id / IG code / reddit id).
- [ ] Post-filter dates (actor date filters proven unreliable).
- [ ] Noise classifier: `recruitment_noise`, `job_bot`, `namesake_brand` → store but exclude from sentiment/aggregates.
- [ ] **Sentiment on a FIXED written rubric** (−1.0…+1.0 with criteria) so month-over-month is
      meaningful — use the Claude API (or Gemini, as the PR side does). Persist the score + tone per row.
- [ ] Theme + spokesperson tags (Harding / Simmonds / Waind).

## 4. Competitors on social (the other half of the ask)
- [ ] Run §2 actors for each tracked competitor too (Haus & Haus, Engel & Völkers, Allsopp & Allsopp,
      Sotheby's, Driven Properties, White & Co — see `lib/competitors.ts`), storing rows with
      `is_competitor=true` and `brand=<competitor>`.
  - LinkedIn: per-competitor `searchQueries`; find each competitor's company entity id for precision.
  - Instagram: per-competitor `username` for tagged-posts.
  - Trustpilot: per-competitor `companyUrls`.
  - Reddit: per-competitor query variants.
- [ ] Compute **social Share of Voice per channel** (betterhomes vs competitors) → snapshot daily.

## 5. Wire into the dashboard
- [ ] `lib/data.ts`: add `getSocial(channel?)`, `getSocialSov(channel)` (graceful empty when tables missing).
- [ ] `components/SocialReviews.tsx`: replace each channel card's empty state with real KPIs
      (mentions 30d, net sentiment on the rubric, engagement) + a SoV bar vs competitors + a feed table.
- [ ] Extend `lib/insights.ts` `buildCompetitiveInsights` to fold in social signals (e.g. "Allsopp is
      getting 3× your LinkedIn engagement on launch posts — mirror that format").
- [ ] Keep the "mention universe" line on every card (already drafted in `SocialReviews.tsx`).

## 6. Scheduling
- [ ] Collection: **Apify Schedules** (daily) appending to named datasets, **or** extend the existing
      daily Vercel cron (`vercel.json` → `/api/ingest`, 09:00 UTC = 1 PM Dubai) to also pull Apify
      datasets and upsert into `social_mentions`.
- [ ] Processing (normalize/classify/score) runs right after collection.

## 7. Costs (measured in the handoff test)
- ~$0.0005–0.003 per item; realistic volume (100 reviews + 200 LinkedIn + 200 IG + 100 Reddit + news) ≈ **$1–2/month** in actor fees.
- Apify plan: free = $5 credit/mo (caps some actors, e.g. IG hashtag first-page only); **Starter (~$39/mo)** needed for Schedules + full volume.
- If an actor's input schema drifts: `GET https://api.apify.com/v2/acts/{actorId}` → read `inputSchema` (or the Apify MCP `fetch-actor-details`).

## 8. Non-negotiable principles
1. Every aggregate traces to stored rows (clickable).
2. Sentiment uses a fixed written rubric (else MoM deltas are meaningless).
3. Each source states its mention universe in the UI footer.
4. Timestamps come from the platform record, never the report period.
