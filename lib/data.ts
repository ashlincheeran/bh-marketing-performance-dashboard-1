// Single source the dashboard reads from: Supabase when configured, otherwise
// the bundled JSON seed (so the app still renders before the DB is wired).
import { enrichMentions } from "@/lib/pr";
import { readClient } from "@/lib/supabase";
import { DEFAULT_QUERIES } from "@/lib/keywords";
import { DEFAULT_COMPETITORS } from "@/lib/competitors";
import type { Mention, Outlet, RawMention, Sentiment, Tier } from "@/lib/types";
import rawMentions from "@/data/mentions.json";
import outletsJson from "@/data/outlets.json";

export interface MentionsResult {
  mentions: Mention[];
  source: "supabase" | "seed";
}

export async function getMentions(): Promise<MentionsResult> {
  const db = readClient();
  if (db) {
    const [mRes, oRes] = await Promise.all([
      db
        .from("mentions")
        .select("id,published_on,tier,outlet_name,title,url,eav,reach,brand,sentiment,source")
        .neq("status", "rejected")
        .neq("source", "competitor_news") // competitor coverage lives in its own feed, not the betterhomes view
        .order("published_on", { ascending: false, nullsFirst: false })
        .limit(5000),
      db.from("outlets").select("name,tier,default_eav,default_reach"),
    ]);
    if (!mRes.error && !oRes.error && mRes.data) {
      const raw: RawMention[] = mRes.data.map((r) => ({
        id: r.id,
        date: r.published_on,
        year: r.published_on ? Number(String(r.published_on).slice(0, 4)) : null,
        month: r.published_on ? Number(String(r.published_on).slice(5, 7)) : null,
        tier: r.tier as Tier,
        outlet: r.outlet_name,
        title: r.title,
        url: r.url,
        eav: r.eav,
        reach: r.reach,
        brand: r.brand ?? "betterhomes",
        sentiment: r.sentiment as Sentiment,
        source: r.source ?? "historical_import",
      }));
      const outlets: Outlet[] = (oRes.data ?? []).map((o) => ({
        outlet: o.name,
        tier: o.tier as Tier,
        default_eav: o.default_eav,
        default_reach: o.default_reach,
      }));
      return { source: "supabase", mentions: enrichMentions(raw, outlets) };
    }
  }
  return {
    source: "seed",
    mentions: enrichMentions(
      rawMentions as unknown as RawMention[],
      outletsJson as unknown as Outlet[],
    ),
  };
}

export interface IngestRun {
  ran_at: string;
  trigger: string;
  ok: boolean;
  found: number;
  considered: number;
  inserted: number;
  updated: number;
  skipped: number;
  error: string | null;
}

export interface BotActivityItem {
  id: string;
  published_on: string | null;
  outlet_name: string | null;
  title: string | null;
  url: string | null;
  status: string; // 'new' (kept) | 'reviewed' (approved) | 'rejected'
  sentiment: Sentiment;
}

/** Everything the news bot has seen (kept + rejected), newest first, for auditing. */
export async function getBotActivity(limit = 120): Promise<BotActivityItem[]> {
  const db = readClient();
  if (!db) return [];
  const { data, error } = await db
    .from("mentions")
    .select("id,published_on,outlet_name,title,url,status,sentiment")
    .eq("source", "googlenews")
    .order("published_on", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error || !data) return [];
  return data as BotActivityItem[];
}

export interface CompetitorNewsItem {
  id: string;
  brand: string; // competitor display name
  published_on: string | null;
  outlet_name: string | null;
  title: string | null;
  url: string | null;
}

/** Recent competitor news the bot logged (one row per tracked rival), newest first. */
export async function getCompetitorNews(limit = 500): Promise<CompetitorNewsItem[]> {
  const db = readClient();
  if (!db) return [];
  const { data, error } = await db
    .from("mentions")
    .select("id,published_on,outlet_name,title,url,metadata")
    .eq("source", "competitor_news")
    .neq("status", "rejected")
    .order("published_on", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id as string,
    brand: ((r.metadata as { competitor?: string } | null)?.competitor) ?? "Competitor",
    published_on: r.published_on as string | null,
    outlet_name: r.outlet_name as string | null,
    title: r.title as string | null,
    url: r.url as string | null,
  }));
}

export interface TrackedKeyword {
  id: number | null; // null when the table doesn't exist yet (defaults) → not removable
  query: string;
  label: string | null;
}

/** The bot's editable search lists for the Monitored Keywords UI. */
export async function getTrackedKeywords(): Promise<{ pr: TrackedKeyword[]; competitor: TrackedKeyword[] }> {
  const db = readClient();
  if (db) {
    try {
      const { data, error } = await db
        .from("tracked_keywords")
        .select("id,kind,query,label,active")
        .eq("active", true)
        .order("created_at", { ascending: true });
      if (!error && data) {
        const map = (kind: string) =>
          data
            .filter((r) => r.kind === kind)
            .map((r) => ({ id: r.id as number, query: r.query as string, label: (r.label as string) ?? null }));
        return { pr: map("pr"), competitor: map("competitor") };
      }
    } catch {
      /* table may not exist yet — fall back to defaults below */
    }
  }
  return {
    pr: DEFAULT_QUERIES.map((q) => ({ id: null, query: q, label: null })),
    competitor: DEFAULT_COMPETITORS.map((c) => ({ id: null, query: c.query, label: c.name })),
  };
}

/** Recent bot-run history for the dashboard status panel. */
export async function getIngestRuns(limit = 5): Promise<IngestRun[]> {
  const db = readClient();
  if (!db) return [];
  const { data, error } = await db
    .from("ingest_runs")
    .select("ran_at,trigger,ok,found,considered,inserted,updated,skipped,error")
    .order("ran_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as IngestRun[];
}

export interface SovItem {
  brand: string;
  mentions: number;
  share: number; // %
  isUs: boolean;
}

/**
 * News Share of Voice, year-to-date, computed from stored bot-found mentions so
 * it stays consistent with the feeds and refreshes without needing a bot run.
 * betterhomes counts its bot-found ('googlenews') articles only — its historical
 * archive is excluded so the comparison with competitors (who have no archive)
 * is like-for-like and fair.
 */
export async function getSov(): Promise<{ items: SovItem[]; capturedOn: string | null }> {
  const db = readClient();
  if (!db) return { items: [], capturedOn: null };
  const yearStart = `${new Date().getUTCFullYear()}-01-01`;
  const { data, error } = await db
    .from("mentions")
    .select("source,metadata,published_on,status")
    .neq("status", "rejected")
    .in("source", ["googlenews", "competitor_news"])
    .gte("published_on", yearStart)
    .limit(10000);
  if (error || !data) return { items: [], capturedOn: null };

  const counts = new Map<string, number>();
  for (const r of data) {
    const brand =
      r.source === "competitor_news"
        ? ((r.metadata as { competitor?: string } | null)?.competitor ?? "Competitor")
        : "betterhomes";
    counts.set(brand, (counts.get(brand) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  const items: SovItem[] = [...counts.entries()]
    .map(([brand, mentions]) => ({
      brand,
      mentions,
      share: Math.round((mentions / total) * 100),
      isUs: brand === "betterhomes",
    }))
    .sort((a, b) => b.mentions - a.mentions);
  return { items, capturedOn: new Date().toISOString().slice(0, 10) };
}
