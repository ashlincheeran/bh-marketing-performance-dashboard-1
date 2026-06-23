// News ingestion. Runs on demand ("Run now"); no daily cron.
//
// Pipeline (per the agreed design):
//   1. Google News RSS — find candidate article LINKS for every keyword
//      (betterhomes terms + competitor terms). The keyword is only a net.
//   2. Apify — extract the FULL article text for each new link.
//   3. Our own code decides from the real content:
//        - text mentions betterhomes  → send the body to Gemini (relevance + tone) → store as our mention
//        - text mentions a competitor → Gemini confirms it's the real brokerage → tag for Share of Voice
//        - neither                    → drop (stored as rejected, auditable)
//   This keeps Google, Apify and Gemini all lightly loaded.
import crypto from "node:crypto";
import { adminClient } from "@/lib/supabase";
import { assessMention, assessCompetitor } from "@/lib/sentiment";
import { getKeywords } from "@/lib/keywords";
import { getSovBrands } from "@/lib/competitors";
import { fetchArticleTexts } from "@/lib/apify";
import { mentionsBetterhomes, matchedCompetitor } from "@/lib/match";
import { refreshInsightsCache } from "@/lib/insights";
import type { Tier } from "@/lib/types";

// How many brand-new articles to pull bodies for per run. Manual trigger, so a
// modest cap keeps each click fast + cheap; click again to process more.
const MAX_FETCH = Number(process.env.INGEST_MAX || 14);

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

async function fetchKeyword(keyword: string): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=en-US&gl=US&ceid=US:en`;
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
    updated: 0, skipped_irrelevant: 0, competitors: 0, bodies: 0, sample: [],
  };

  try {
    // 1) Google News RSS → candidate links for every keyword
    const all: NewsItem[] = [];
    for (let i = 0; i < KEYWORDS.length; i++) {
      const kw = KEYWORDS[i];
      p(`[${i + 1}/${KEYWORDS.length}] Google News: "${kw}"`);
      const items = await fetchKeyword(kw);
      all.push(...items);
      p(`  → ${items.length} articles found`);
    }
    result.found = all.length;

    // dedup by normalized title, keep dated ones
    const seen = new Set<string>();
    const candidates = all
      .filter((it) => it.date)
      .map((it) => ({ ...it, key: norm(it.title) }))
      .filter((c) => (c.key && !seen.has(c.key) ? (seen.add(c.key), true) : false));

    // what we already have (for dedup + date self-heal)
    const existing = (await db.from("mentions").select("id,title,published_on,url").limit(10000)).data ?? [];
    const byNorm = new Map(existing.map((e) => [norm(String(e.title ?? "")), e]));

    const toUpdate: { id: string; date: string; url: string | null }[] = [];
    const brandNew: typeof candidates = [];
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

    p(`─────────────────────────────────────`);
    p(`Found ${all.length} total · ${candidates.length} unique · ${brandNew.length} new · ${toUpdate.length} date-healed`);

    // 2) Apify — pull full text for this run's new links
    const fresh = brandNew.slice(0, MAX_FETCH);
    result.considered = fresh.length;

    if (fresh.length === 0) {
      p(`No new articles to process.`);
    } else {
      p(`Fetching ${fresh.length} article bodies via Apify (browser)…`);
      const texts = await fetchArticleTexts(fresh.map((c) => c.link).filter(Boolean));
      result.bodies = texts.size;
      p(`Got ${texts.size}/${fresh.length} full article bodies`);
      p(`─────────────────────────────────────`);

      // outlet lookup for tier
      const { data: outlets } = await db.from("outlets").select("id,name,tier");
      const byName = new Map((outlets ?? []).map((o) => [String(o.name).toLowerCase(), o]));

      // 3) decide from the real content
      const rows: Record<string, unknown>[] = [];
      const samples: string[] = [];
      for (let i = 0; i < fresh.length; i++) {
        const c = fresh[i];
        const body = texts.get(c.link) || "";
        const hay = `${c.title} ${c.source} ${body}`;
        const match = byName.get(c.source.toLowerCase()) as any;
        const base = {
          published_on: c.date,
          outlet_name: c.source || null,
          title: c.title,
          url: c.link || null,
          eav: null,
          reach: null,
          media_type: "online",
          tags: deriveTags(c.title),
          raw: { link: c.link, source: c.source, pubDate: c.date, hasBody: !!body },
        };

        const shortTitle = c.title.length > 55 ? c.title.slice(0, 55) + "…" : c.title;

        if (mentionsBetterhomes(hay)) {
          p(`[${i + 1}/${fresh.length}] betterhomes match · Gemini checking…`);
          p(`  "${shortTitle}" (${c.source})`);
          const a = await assessMention(c.title, c.source, body);
          rows.push({
            id: hashId(c.key),
            ...base,
            tier: a.relevant ? ((match?.tier as Tier) ?? "Other") : "Other",
            outlet_id: a.relevant ? (match?.id ?? null) : null,
            brand: "betterhomes",
            sentiment: a.sentiment,
            source: "googlenews",
            status: a.relevant ? "new" : "rejected",
            metadata: { hasBody: !!body },
          });
          if (a.relevant) {
            p(`  → KEPT · sentiment: ${a.sentiment ?? "unknown"}`);
            samples.push(`${a.sentiment ?? "—"} · ${c.source} · ${c.title}`);
          } else {
            p(`  → rejected (Gemini: not the Dubai brokerage)`);
            result.skipped_irrelevant++;
          }
        } else {
          const comp = matchedCompetitor(hay, brands);
          if (comp) {
            p(`[${i + 1}/${fresh.length}] ${comp} match · Gemini checking…`);
            p(`  "${shortTitle}" (${c.source})`);
            const a = await assessCompetitor(comp, c.title, c.source, body);
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
                ? { competitor: comp, hasBody: !!body }
                : { competitor: comp, hasBody: !!body, reason: "competitor not confirmed by AI" },
            });
            if (a.relevant) {
              p(`  → KEPT as competitor · sentiment: ${a.sentiment ?? "unknown"}`);
            } else {
              p(`  → rejected (Gemini: not their brokerage)`);
              result.skipped_irrelevant++;
            }
          } else {
            p(`[${i + 1}/${fresh.length}] no brand match · dropped`);
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
              metadata: { reason: "no brand in text", hasBody: !!body },
            });
            result.skipped_irrelevant++;
          }
        }
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

    p(`─────────────────────────────────────`);
    p(`Done — ${result.inserted} betterhomes kept · ${result.competitors} competitors · ${result.skipped_irrelevant} rejected`);

    // Refresh the AI competitive insights from the new data (non-fatal).
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
    p(`ERROR: ${error}`);
    throw e;
  }
}
