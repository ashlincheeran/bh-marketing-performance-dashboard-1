// Daily ingestion via Google News (free RSS — no paid scraper needed).
// Searches several keywords, lets Gemini judge whether each article is really
// about betterhomes (+ sentiment), enriches from the outlet table, dedupes,
// self-heals dates on existing date-less rows, and logs each run.
import crypto from "node:crypto";
import { adminClient } from "@/lib/supabase";
import { assessMention } from "@/lib/sentiment";
import { getKeywords } from "@/lib/keywords";
import { computeAndStoreSov } from "@/lib/sov";
import { getSovBrands } from "@/lib/competitors";
import type { Sentiment, Tier } from "@/lib/types";

const KEYWORDS = getKeywords();
const MAX_ASSESS = 50;

function hashId(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}
// normalized title — used for dedup and stable ids (robust to case/punctuation)
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

// Hard exclusion: "Better Homes & Gardens" (incl. its US real-estate brand) is a
// different company that the AI sometimes confuses with betterhomes. Never keep it.
function isObviousNonBetterhomes(title: string, source: string): boolean {
  const hay = `${title} ${source}`.toLowerCase();
  return (hay.includes("better homes") && hay.includes("garden")) || hay.includes("bhgre");
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
  inserted: number;
  updated: number;
  skipped_irrelevant: number;
  competitors: number; // competitor news rows stored this run
  sample: string[];
}

// Search Google News for each tracked competitor and store their recent coverage
// as `source='competitor_news'` rows. brand is a FK to brands(id), so we leave it
// null and keep the competitor's display name in metadata.competitor. These rows
// power the "What competitors are publishing" feed and the competitive insights —
// they're filtered out of the betterhomes PR view.
async function ingestCompetitors(db: any): Promise<number> {
  const brands = getSovBrands().filter((b) => !b.isUs);
  if (!brands.length) return 0;
  const { data: outlets } = await db.from("outlets").select("id,name,tier");
  const byName = new Map((outlets ?? []).map((o: any) => [String(o.name).toLowerCase(), o]));

  const rows: Record<string, unknown>[] = [];
  for (const b of brands) {
    const items = await fetchKeyword(b.query);
    const seen = new Set<string>();
    const recent = items
      .filter((it) => it.date)
      .map((it) => ({ ...it, key: norm(it.title) }))
      .filter((c) => (c.key && !seen.has(c.key) ? (seen.add(c.key), true) : false))
      .sort((x, y) => (x.date! < y.date! ? 1 : -1))
      .slice(0, 25); // cap per competitor so storage stays bounded
    for (const c of recent) {
      const match = byName.get(c.source.toLowerCase()) as any;
      rows.push({
        id: hashId(`${b.name}|${c.key}`),
        published_on: c.date,
        tier: (match?.tier as Tier) ?? "Other",
        outlet_id: match?.id ?? null,
        outlet_name: c.source || null,
        title: c.title,
        url: c.link || null,
        eav: null,
        reach: null,
        brand: null,
        sentiment: null,
        media_type: "online",
        tags: deriveTags(c.title),
        source: "competitor_news",
        status: "new",
        metadata: { competitor: b.name },
        raw: { link: c.link, source: c.source, pubDate: c.date, competitor: b.name },
      });
    }
  }
  if (rows.length) {
    const { error } = await db.from("mentions").upsert(rows, { onConflict: "id" });
    if (error) throw new Error("competitor insert failed: " + error.message);
  }
  return rows.length;
}

export async function runIngest(trigger: "cron" | "manual" = "cron"): Promise<IngestResult> {
  const db = adminClient();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");

  const result: IngestResult = {
    keywords: KEYWORDS.length, found: 0, considered: 0,
    inserted: 0, updated: 0, skipped_irrelevant: 0, competitors: 0, sample: [],
  };

  try {
    // 1) fetch all keywords
    const all: NewsItem[] = [];
    for (const kw of KEYWORDS) all.push(...(await fetchKeyword(kw)));
    result.found = all.length;

    // 2) dedup candidates by normalized title (keep dated ones)
    const seen = new Set<string>();
    const candidates = all
      .filter((it) => it.date)
      .map((it) => ({ ...it, key: norm(it.title) }))
      .filter((c) => (c.key && !seen.has(c.key) ? (seen.add(c.key), true) : false));

    // 3) load everything we already have (id, title, date, url) for matching
    const existing = (await db.from("mentions").select("id,title,published_on,url").limit(10000)).data ?? [];
    const byNorm = new Map(existing.map((e) => [norm(String(e.title ?? "")), e]));

    // 4) split into: self-heal (existing but date-less) vs brand-new
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

    // 5) self-heal: backfill dates (+ link) on date-less rows we already track
    for (const u of toUpdate) {
      await db.from("mentions").update({ published_on: u.date, url: u.url }).eq("id", u.id);
    }
    result.updated = toUpdate.length;

    // 6) outlet lookup for tier/EAV/reach
    const { data: outlets } = await db.from("outlets").select("id,name,tier,default_eav,default_reach");
    const byName = new Map((outlets ?? []).map((o) => [String(o.name).toLowerCase(), o]));

    // 7) AI judges each brand-new article: betterhomes? + sentiment
    const fresh = brandNew.slice(0, MAX_ASSESS);
    result.considered = fresh.length;
    // Store BOTH kept and rejected (rejected = status 'rejected') so every
    // article the bot saw is auditable on the Bot Activity page — and so we
    // never re-assess the same noise on later runs.
    const rows: Record<string, unknown>[] = [];
    for (const c of fresh) {
      const a: { relevant: boolean; sentiment: Sentiment } = isObviousNonBetterhomes(c.title, c.source)
        ? { relevant: false, sentiment: null }
        : await assessMention(c.title, c.source);
      if (!a.relevant) result.skipped_irrelevant++;
      const match = byName.get(c.source.toLowerCase());
      rows.push({
        id: hashId(c.key),
        published_on: c.date,
        tier: a.relevant ? ((match?.tier as Tier) ?? "Other") : "Other",
        outlet_id: a.relevant ? (match?.id ?? null) : null,
        outlet_name: c.source || null,
        title: c.title,
        url: c.link || null,
        eav: null, reach: null,
        brand: "betterhomes",
        sentiment: a.sentiment,
        media_type: "online",
        tags: deriveTags(c.title),
        source: "googlenews",
        status: a.relevant ? "new" : "rejected",
        raw: { link: c.link, source: c.source, pubDate: c.date },
      });
    }
    if (rows.length) {
      const { error } = await db.from("mentions").upsert(rows, { onConflict: "id" });
      if (error) throw new Error("insert failed: " + error.message);
    }
    const kept = rows.filter((r) => r.status === "new");
    result.inserted = kept.length;
    result.sample = kept.slice(0, 8).map((r) => `${r.sentiment ?? "—"} · ${r.outlet_name} · ${r.title}`);

    // refresh competitor Share of Voice (non-fatal)
    try {
      await computeAndStoreSov(db);
    } catch {
      /* SoV refresh is best-effort */
    }

    // store competitor coverage for the feed + insights (non-fatal)
    try {
      result.competitors = await ingestCompetitors(db);
    } catch {
      /* competitor ingest is best-effort */
    }

    await db.from("ingest_runs").insert({
      trigger, ok: true, found: result.found, considered: result.considered,
      inserted: result.inserted, updated: result.updated, skipped: result.skipped_irrelevant,
    });
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.from("ingest_runs").insert({
      trigger, ok: false, error, found: result.found, considered: result.considered,
      inserted: result.inserted, updated: result.updated, skipped: result.skipped_irrelevant,
    });
    throw e;
  }
}
