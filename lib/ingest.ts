// News ingestion. Runs daily on a Vercel cron (see vercel.json) and on demand
// via the "Run now" button; the `trigger` column records which.
//
// Pipeline:
//   1. Google News RSS — find candidate article LINKS for every keyword
//      (betterhomes terms + competitor terms). The keyword is only a net, but
//      WHICH keyword found an article is kept: Google matches full article
//      text, so a hit on a brand query is itself evidence the brand is in the
//      body even when the headline never says so.
//   2. Resolve each Google News wrapper link to the publisher's URL, then pull
//      the full article text through Apify.
//   3. Our own code decides from the real content:
//        - text mentions betterhomes  → Gemini (relevance + tone) → our mention
//        - text mentions a competitor → Gemini confirms the brokerage → Share of Voice
//        - neither                    → drop (stored as rejected, auditable)
//
// THE BUG THIS PIPELINE WAS BUILT AROUND
// Step 2 silently returned nothing for months: RSS hands over a wrapper link,
// and the crawler would not follow it off news.google.com. Step 3 then ran on
// `title + outlet` alone and filed everything "no brand in text". Of the ten
// articles it considered across Aug–Sep 2026, nine are on the PR team's own
// coverage sheet. It rejected all nine.
//
// So the rule now: a "no brand in text" verdict is only allowed when there IS
// text. Every other outcome is recorded under its own reason and counted, never
// collapsed into the same silent rejection.
import crypto from "node:crypto";
import { adminClient } from "@/lib/supabase";
import { notify, notifyIfStored } from "@/lib/notify";
import { assessMention, assessCompetitor } from "@/lib/sentiment";
import { getKeywords } from "@/lib/keywords";
import { getSovBrands } from "@/lib/competitors";
import { fetchArticleBodies, summariseBodies, type ArticleBody } from "@/lib/apify";
import { mentionsBetterhomes, matchedCompetitor } from "@/lib/match";
import { refreshInsightsCache } from "@/lib/insights";
import type { Tier } from "@/lib/types";

// How many brand-new articles to pull bodies for per run.
const MAX_FETCH = Number(process.env.INGEST_MAX || 24);

/**
 * A query that names us. A hit on one of these means Google found the brand in
 * the article — headline or body — which is the signal that survives even when
 * our own body fetch fails.
 */
const BRAND_QUERY = /better\s?homes|bhomes|waind|prime by|alex leigh|linda mahoney|louis harding/i;

function hashId(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 140);
}
function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function deriveTags(title: string): string[] {
  const t = title.toLowerCase();
  const tags = new Set<string>();
  if (/rent|tenant|lease|leasing/.test(t)) tags.add("leasing");
  if (/report/.test(t)) tags.add("market-report");
  if (/ceo|appoint|steps down|director|leadership/.test(t)) tags.add("leadership");
  if (/off-plan|off plan|offplan/.test(t)) tags.add("off-plan");
  if (/top 50/.test(t)) tags.add("top-50");
  if (/ramadan/.test(t)) tags.add("ramadan");
  return [...tags];
}

interface NewsItem { title: string; link: string; source: string; date: string | null; }
interface Candidate extends NewsItem { key: string; keywords: string[]; brandQuery: boolean; }

function parseGoogleNews(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const block of xml.split("<item>").slice(1)) {
    const item = block.split("</item>")[0];
    const grab = (re: RegExp) => item.match(re)?.[1]?.trim() ?? "";
    const rawTitle = decodeEntities(grab(/<title>([\s\S]*?)<\/title>/));
    if (!rawTitle) continue;
    const link = grab(/<link>([\s\S]*?)<\/link>/);
    const source = decodeEntities(grab(/<source[^>]*>([\s\S]*?)<\/source>/));
    const pub = grab(/<pubDate>([\s\S]*?)<\/pubDate>/);
    let title = rawTitle;
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(` - ${source}`.length)).trim();
    let date: string | null = null;
    if (pub) { const d = new Date(pub); if (!isNaN(d.getTime())) date = d.toISOString().slice(0, 10); }
    items.push({ title, link, source, date });
  }
  return items;
}

// UAE edition. The coverage we care about sits on Zawya, TradeArabia,
// gdnonline, MENAFN, Khaleej Times and Arabian Business; the US edition
// under-represents all of them.
const EDITION = process.env.NEWS_EDITION || "hl=en-AE&gl=AE&ceid=AE:en";

async function fetchKeyword(keyword: string): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&${EDITION}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    return parseGoogleNews(await res.text());
  } catch {
    return [];
  }
}

export interface IngestResult {
  keywords: number;
  found: number;
  considered: number;
  inserted: number;       // betterhomes mentions kept
  updated: number;        // existing rows date-healed
  skipped_irrelevant: number;
  competitors: number;    // competitor rows tagged
  bodies: number;         // articles whose full text we successfully read
  unreadable: number;     // considered, but the body could not be retrieved
  sample: string[];
}

export async function runIngest(
  trigger: "cron" | "manual" = "manual",
  onProgress?: (msg: string) => void,
): Promise<IngestResult> {
  const p = onProgress ?? (() => {});
  const db = adminClient();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");

  const prKeywords = await getKeywords();
  const brands = await getSovBrands();
  const competitorQueries = brands.filter((b) => !b.isUs).map((b) => b.query);
  const KEYWORDS = [...new Set([...prKeywords, ...competitorQueries])];

  p(`Starting run · ${KEYWORDS.length} keywords (${prKeywords.length} PR + ${competitorQueries.length} competitor)`);

  const result: IngestResult = {
    keywords: KEYWORDS.length, found: 0, considered: 0, inserted: 0,
    updated: 0, skipped_irrelevant: 0, competitors: 0, bodies: 0, unreadable: 0, sample: [],
  };

  try {
    // 1) Google News RSS → candidate links, remembering which keyword found each
    const byKey = new Map<string, Candidate>();
    for (let i = 0; i < KEYWORDS.length; i++) {
      const kw = KEYWORDS[i];
      p(`[${i + 1}/${KEYWORDS.length}] Google News: "${kw}"`);
      const items = await fetchKeyword(kw);
      result.found += items.length;
      for (const it of items) {
        if (!it.date) continue;
        const key = norm(it.title);
        if (!key) continue;
        const existing = byKey.get(key);
        if (existing) {
          if (!existing.keywords.includes(kw)) existing.keywords.push(kw);
          existing.brandQuery ||= BRAND_QUERY.test(kw);
        } else {
          byKey.set(key, { ...it, key, keywords: [kw], brandQuery: BRAND_QUERY.test(kw) });
        }
      }
      p(`  → ${items.length} articles found`);
    }
    const candidates = [...byKey.values()];

    // what we already have (for dedup + date self-heal)
    const existing = (await db.from("mentions").select("id,title,published_on,url").limit(10000)).data ?? [];
    const byNorm = new Map(existing.map((e) => [norm(String(e.title ?? "")), e]));

    const toUpdate: { id: string; date: string; url: string | null }[] = [];
    const brandNew: Candidate[] = [];
    for (const c of candidates) {
      const ex = byNorm.get(c.key);
      if (ex) {
        if (!ex.published_on && c.date) toUpdate.push({ id: ex.id, date: c.date, url: ex.url ?? c.link ?? null });
      } else {
        brandNew.push(c);
      }
    }
    for (const u of toUpdate) {
      await db.from("mentions").update({ published_on: u.date, url: u.url }).eq("id", u.id);
    }
    result.updated = toUpdate.length;

    /**
     * Order the backlog before spending the budget on it.
     *
     * Previously this was `brandNew.slice(0, MAX_FETCH)` — keyword order. Since
     * broad queries return years of archive, the run's whole allowance went on
     * articles from 2017–2022 that happened to sit near the top of the first
     * keyword's results, while that morning's coverage further down was never
     * reached. Brand-query hits first, then newest first.
     */
    brandNew.sort((a, b) => {
      if (a.brandQuery !== b.brandQuery) return a.brandQuery ? -1 : 1;
      return (b.date ?? "").localeCompare(a.date ?? "");
    });

    p(`─────────────────────────────────────`);
    p(`Found ${result.found} total · ${candidates.length} unique · ${brandNew.length} new · ${toUpdate.length} date-healed`);
    p(`${brandNew.filter((c) => c.brandQuery).length} of the new ones came from a brand query`);

    // 2) Resolve wrapper links + pull full text for this run's new candidates
    const fresh = brandNew.slice(0, MAX_FETCH);
    result.considered = fresh.length;

    if (fresh.length === 0) {
      p(`No new articles to process.`);
    } else {
      p(`Resolving ${fresh.length} links and fetching bodies via Apify…`);
      const bodies = await fetchArticleBodies(fresh.map((c) => c.link).filter(Boolean));
      result.bodies = [...bodies.values()].filter((b) => b.status === "ok").length;
      result.unreadable = fresh.length - result.bodies;
      p(`Bodies: ${summariseBodies(bodies)}`);
      if (result.unreadable > 0) {
        p(`${result.unreadable} article${result.unreadable === 1 ? "" : "s"} could not be read — these are NOT counted as "no mention"`);
      }
      p(`─────────────────────────────────────`);

      const { data: outlets } = await db.from("outlets").select("id,name,tier");
      const byName = new Map((outlets ?? []).map((o) => [String(o.name).toLowerCase(), o]));

      // 3) decide from the real content
      const rows: Record<string, unknown>[] = [];
      const samples: string[] = [];
      for (let i = 0; i < fresh.length; i++) {
        const c = fresh[i];
        const body: ArticleBody | undefined = bodies.get(c.link);
        const text = body?.text ?? "";
        const bodyOk = body?.status === "ok";
        const hay = `${c.title} ${c.source} ${text}`;
        const match = byName.get(c.source.toLowerCase()) as { id?: number; tier?: string } | undefined;
        const evidence = {
          bodyStatus: body?.status ?? "missing",
          resolveStatus: body?.resolveStatus ?? null,
          bodyChars: text.length,
          keywords: c.keywords,
          brandQuery: c.brandQuery,
        };
        const base = {
          published_on: c.date,
          outlet_name: c.source || null,
          title: c.title,
          url: body?.resolvedUrl || c.link || null,
          eav: null,
          reach: null,
          media_type: "online",
          tags: deriveTags(c.title),
          raw: { link: c.link, resolved: body?.resolvedUrl ?? null, source: c.source, pubDate: c.date, ...evidence },
        };

        const shortTitle = c.title.length > 55 ? c.title.slice(0, 55) + "…" : c.title;
        const keep = (a: { relevant: boolean; sentiment: unknown }, extra: Record<string, unknown>) => ({
          id: hashId(c.key),
          ...base,
          tier: a.relevant ? ((match?.tier as Tier) ?? "Other") : "Other",
          outlet_id: a.relevant ? (match?.id ?? null) : null,
          brand: "betterhomes",
          sentiment: a.sentiment,
          source: "googlenews",
          status: a.relevant ? "new" : "rejected",
          metadata: { ...evidence, ...extra },
        });

        if (mentionsBetterhomes(hay)) {
          p(`[${i + 1}/${fresh.length}] betterhomes in ${bodyOk ? "body" : "headline"} · Gemini checking…`);
          p(`  "${shortTitle}" (${c.source})`);
          const a = await assessMention(c.title, c.source, text, bodyOk);
          rows.push(keep(a, { verdict: bodyOk ? "body" : "headline_only" }));
          if (a.relevant) {
            p(`  → KEPT · sentiment: ${a.sentiment ?? "unknown"}`);
            samples.push(`${a.sentiment ?? "—"} · ${c.source} · ${c.title}`);
          } else {
            p(`  → rejected (Gemini: not the Dubai brokerage)`);
            result.skipped_irrelevant++;
          }
          continue;
        }

        const comp = matchedCompetitor(hay, brands);
        if (comp) {
          p(`[${i + 1}/${fresh.length}] ${comp} match · Gemini checking…`);
          p(`  "${shortTitle}" (${c.source})`);
          const a = await assessCompetitor(comp, c.title, c.source, text);
          rows.push({
            id: hashId(`${comp}|${c.key}`),
            ...base,
            tier: a.relevant ? ((match?.tier as Tier) ?? "Other") : "Other",
            outlet_id: a.relevant ? (match?.id ?? null) : null,
            brand: null,
            sentiment: a.sentiment,
            source: "competitor_news",
            status: a.relevant ? "new" : "rejected",
            metadata: a.relevant
              ? { ...evidence, competitor: comp }
              : { ...evidence, competitor: comp, reason: "competitor not confirmed by AI" },
          });
          if (a.relevant) p(`  → KEPT as competitor · sentiment: ${a.sentiment ?? "unknown"}`);
          else { p(`  → rejected (Gemini: not their brokerage)`); result.skipped_irrelevant++; }
          continue;
        }

        /**
         * No brand found — but that only MEANS something if we read the article.
         *
         * A brand query surfaced it → Google matched the full text, so the brand
         * is in there somewhere even though our copy of the body is missing. Ask
         * Gemini rather than dropping it, and record that the verdict came from
         * the headline so nobody mistakes it for a read.
         */
        if (!bodyOk && c.brandQuery) {
          p(`[${i + 1}/${fresh.length}] body unreadable (${body?.status}) but found via brand query · Gemini checking…`);
          p(`  "${shortTitle}" (${c.source})`);
          const a = await assessMention(c.title, c.source, text, false);
          rows.push(keep(a, { verdict: "headline_only", reason: a.relevant ? undefined : "rejected on headline" }));
          if (a.relevant) {
            p(`  → KEPT (headline-only verdict) · sentiment: ${a.sentiment ?? "unknown"}`);
            samples.push(`${a.sentiment ?? "—"} · ${c.source} · ${c.title}`);
          } else { p(`  → rejected`); result.skipped_irrelevant++; }
          continue;
        }

        const reason = bodyOk
          ? "no brand in text"
          : `body unavailable (${body?.status ?? "missing"}) — verdict withheld`;
        p(`[${i + 1}/${fresh.length}] ${bodyOk ? "no brand match · dropped" : "UNREADABLE · not judged"}`);
        p(`  "${shortTitle}" (${c.source})`);
        rows.push({
          id: hashId(c.key),
          ...base,
          tier: "Other",
          outlet_id: null,
          brand: "betterhomes",
          sentiment: null,
          source: "googlenews",
          status: "rejected",
          metadata: { ...evidence, reason },
        });
        result.skipped_irrelevant++;
      }

      if (rows.length) {
        const { error } = await db.from("mentions").upsert(rows, { onConflict: "id" });
        if (error) throw new Error("insert failed: " + error.message);
      }
      result.inserted = rows.filter((r) => r.source === "googlenews" && r.status === "new").length;
      result.competitors = rows.filter((r) => r.source === "competitor_news" && r.status === "new").length;
      result.sample = samples.slice(0, 8);
    }

    await db.from("ingest_runs").insert({
      trigger, ok: true, found: result.found, considered: result.considered,
      inserted: result.inserted, updated: result.updated, skipped: result.skipped_irrelevant,
    });

    // Announced from the stored run row, not from the counters in memory, and
    // only when something was actually added — a nightly "0 new" is not news.
    await notifyIfStored(
      "news",
      (n) => `${n.rows} new press ${n.rows === 1 ? "mention" : "mentions"}`,
      (n) => `News bot (${trigger}) · confirmed ${n.at}`,
      "news:run",
      async () => {
        const { data } = await db
          .from("ingest_runs")
          .select("inserted, ran_at")
          .order("ran_at", { ascending: false })
          .limit(1);
        const row = data?.[0];
        return row ? { rows: Number(row.inserted ?? 0), at: String(row.ran_at) } : null;
      },
    );

    // An ingest that reads nothing is broken, not quiet — say so loudly enough
    // that it can't sit undetected for a quarter again.
    if (result.considered > 0 && result.bodies === 0) {
      await notify(
        "error",
        "news",
        "News bot read no article bodies",
        `${result.considered} articles considered, 0 bodies retrieved. Brand checks are running on headlines only.`,
        "news:no-bodies",
      );
    }

    p(`─────────────────────────────────────`);
    p(`Done — ${result.inserted} betterhomes kept · ${result.competitors} competitors · ${result.skipped_irrelevant} rejected · ${result.bodies}/${result.considered} bodies read`);

    try {
      p(`Generating competitive insights…`);
      const ins = await refreshInsightsCache(db);
      p(ins.ok ? `Insights updated` : `Insights skipped (no AI key / not enough data)`);
    } catch {
      p(`Insights step skipped`);
    }

    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.from("ingest_runs").insert({
      trigger, ok: false, error, found: result.found, considered: result.considered,
      inserted: result.inserted, updated: result.updated, skipped: result.skipped_irrelevant,
    });
    await notify("error", "news", "News bot run failed", error, "news:failed");
    p(`ERROR: ${error}`);
    throw e;
  }
}
