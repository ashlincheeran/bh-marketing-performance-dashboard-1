// Daily ingestion via Google News (free RSS — no paid scraper needed).
// Searches several keywords, lets Gemini judge whether each article is really
// about betterhomes (+ sentiment), enriches from the outlet table, dedupes,
// and stores fresh ones as status='new'.
import crypto from "node:crypto";
import { adminClient } from "@/lib/supabase";
import { assessMention } from "@/lib/sentiment";
import type { Tier } from "@/lib/types";

// Keywords to monitor. Configurable via PR_QUERIES (comma-separated).
// Brand + people + sub-brand terms keep precision high; the AI confirms each hit.
const DEFAULT_QUERIES = [
  "betterhomes dubai",
  "betterhomes real estate",
  "PRIME by betterhomes",
  "Louis Harding betterhomes",
  "Linda Mahoney betterhomes",
];
const QUERIES = (process.env.PR_QUERIES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const KEYWORDS = QUERIES.length ? QUERIES : DEFAULT_QUERIES;

// Safety cap on AI assessments per run (keeps us within the function time limit).
const MAX_ASSESS = 50;

function hashId(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
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

interface NewsItem {
  title: string;
  link: string;
  source: string;
  date: string | null;
}

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
    if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, title.length - ` - ${source}`.length).trim();
    }
    let date: string | null = null;
    if (pub) {
      const d = new Date(pub);
      if (!isNaN(d.getTime())) date = d.toISOString().slice(0, 10);
    }
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
  skipped_irrelevant: number;
  sample: string[];
}

export async function runIngest(): Promise<IngestResult> {
  const db = adminClient();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");

  // 1) fetch every keyword from Google News, combine
  const all: NewsItem[] = [];
  for (const kw of KEYWORDS) all.push(...(await fetchKeyword(kw)));

  // 2) only consider articles newer than what we already have
  const maxRow = await db
    .from("mentions")
    .select("published_on")
    .not("published_on", "is", null)
    .order("published_on", { ascending: false })
    .limit(1)
    .maybeSingle();
  const cutoff: string | null = maxRow.data?.published_on ?? null;

  const seen = new Set<string>();
  const candidates = all
    .filter((it) => it.date && (!cutoff || it.date > cutoff))
    .map((it) => ({ ...it, id: hashId(it.title.toLowerCase().slice(0, 120) + "|" + it.source.toLowerCase()) }))
    .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

  // 3) drop ones already stored (by id, and by exact title vs history)
  const ids = candidates.map((c) => c.id);
  const haveId = new Set(
    (ids.length ? (await db.from("mentions").select("id").in("id", ids)).data ?? [] : []).map((r) => r.id),
  );
  const haveTitle = new Set(
    (candidates.length
      ? (await db.from("mentions").select("title").in("title", candidates.map((c) => c.title))).data ?? []
      : []
    ).map((r) => String(r.title).toLowerCase()),
  );
  const fresh = candidates
    .filter((c) => !haveId.has(c.id) && !haveTitle.has(c.title.toLowerCase()))
    .slice(0, MAX_ASSESS);

  // 4) outlet lookup for tier / EAV / reach
  const { data: outlets } = await db.from("outlets").select("id,name,tier,default_eav,default_reach");
  const byName = new Map((outlets ?? []).map((o) => [String(o.name).toLowerCase(), o]));

  // 5) AI judges each: is it really betterhomes? + sentiment
  const rows: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const c of fresh) {
    const a = await assessMention(c.title, c.source);
    if (!a.relevant) {
      skipped++;
      continue;
    }
    const match = byName.get(c.source.toLowerCase());
    rows.push({
      id: c.id,
      published_on: c.date,
      tier: (match?.tier as Tier) ?? "Other",
      outlet_id: match?.id ?? null,
      outlet_name: c.source || null,
      title: c.title,
      url: c.link || null,
      eav: null,
      reach: null,
      brand: "betterhomes",
      sentiment: a.sentiment,
      media_type: "online",
      tags: deriveTags(c.title),
      source: "googlenews",
      status: "new",
      raw: { link: c.link, source: c.source, pubDate: c.date },
    });
  }

  if (rows.length) {
    const { error } = await db.from("mentions").upsert(rows, { onConflict: "id" });
    if (error) throw new Error("insert failed: " + error.message);
  }

  return {
    keywords: KEYWORDS.length,
    found: all.length,
    considered: fresh.length,
    inserted: rows.length,
    skipped_irrelevant: skipped,
    sample: rows.slice(0, 8).map((r) => `${r.sentiment ?? "—"} · ${r.outlet_name} · ${r.title}`),
  };
}
