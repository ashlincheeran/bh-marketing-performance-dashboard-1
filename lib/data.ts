// Single source the dashboard reads from: Supabase when configured, otherwise
// the bundled JSON seed (so the app still renders before the DB is wired).
import { enrichMentions } from "@/lib/pr";
import { outletKey } from "@/lib/match";
import { readClient } from "@/lib/supabase";
import { DEFAULT_QUERIES } from "@/lib/keywords";
import { DEFAULT_COMPETITORS } from "@/lib/competitors";
import type { FactCheck, Mention, Outlet, RawMention, Sentiment, Tier } from "@/lib/types";
import rawMentions from "@/data/mentions.json";
import outletsJson from "@/data/outlets.json";

/**
 * Every row a query matches, read 1,000 at a time.
 *
 * Supabase caps one select at 1,000 rows whatever `.limit()` asks for. The PR
 * read asked for 5,000 and got rows 0-999 of 1,307 (edge log, 20 Oct 2026),
 * which silently dropped every clip before 16 Jan 2023 and turned Compare's
 * "-1% vs B" into "+11%". Same pattern as lib/paidStore.ts. The query needs a
 * unique tiebreak in its order, or rows on a page boundary can repeat or vanish.
 *
 * A failed page fails the whole read: a partial history shown as the whole one
 * is exactly the bug this replaces.
 */
export async function readAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ rows: T[]; error: string | null }> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await page(offset, offset + PAGE - 1);
    if (error) return { rows, error: error.message };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return { rows, error: null };
  }
}

export interface MentionsResult {
  mentions: Mention[];
  source: "supabase" | "seed";
  /** Why the live read failed, when it did and the page fell back to the bundled file. */
  error?: string;
}

const headline = (t: string | null | undefined) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const withinAWeek = (a: string | null, b: string | null) =>
  a == null || b == null ? a == b : Math.abs(Date.parse(a) - Date.parse(b)) <= 7 * 86_400_000;
/** "Khaleej Times" rather than "khaleejtimes.com": the name the outlets' rate card knows. */
const named = (outlet: string | null) => !!outlet && !/\.[a-z]{2,}$/i.test(outlet.trim());

/**
 * One row per placement: the same headline from the same publication, for the
 * same brand, within a week is one story, whatever name the feed gave the
 * publication.
 *
 * The news feed names an outlet by its title one day and its web address the
 * next, and copies also came in through the import and the backfill, so 11
 * stories sat in the table two or three times: 14 extra press mentions in the
 * twelve months to Oct 2026. A headline carried by two DIFFERENT publications
 * stays two placements, as the PR team counts syndication.
 */
function onePerPlacement<T>(
  rows: T[],
  pick: (r: T) => { brand: string; date: string | null; title: string | null; outlet: string | null; url: string | null },
): T[] {
  const kept: T[] = [];
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const r = pick(row);
    if (!headline(r.title)) {
      kept.push(row);
      continue;
    }
    const key = `${r.brand}|${headline(r.title)}|${outletKey(r.outlet, r.url)}`;
    const at = groups.get(key) ?? [];
    const twin = at.find((i) => withinAWeek(pick(kept[i]).date, r.date));
    if (twin === undefined) {
      at.push(kept.length);
      groups.set(key, at);
      kept.push(row);
    } else if (!named(pick(kept[twin]).outlet) && named(r.outlet)) {
      kept[twin] = row;
    }
  }
  return kept;
}

export async function getMentions(): Promise<MentionsResult> {
  const db = readClient();
  let error: string | undefined;
  if (db) {
    const [mRes, oRes] = await Promise.all([
      readAllRows((from, to) =>
        db
          .from("mentions")
          .select("id,published_on,tier,outlet_name,title,url,eav,reach,brand,sentiment,source,metadata")
          .neq("status", "rejected")
          .neq("source", "competitor_news") // competitor coverage lives in its own feed, not the betterhomes view
          .order("published_on", { ascending: false, nullsFirst: false })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      db.from("outlets").select("name,tier,default_eav,default_reach"),
    ]);
    error = mRes.error ?? oRes.error?.message;
    if (!error) {
      const raw: RawMention[] = onePerPlacement(mRes.rows.map((r) => ({
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
        // The proving sentence, for stories the bot fact-checked.
        factCheck: (r.metadata as { factCheck?: FactCheck } | null)?.factCheck ?? null,
      })), (m) => ({ brand: m.brand, date: m.date, title: m.title, outlet: m.outlet, url: m.url }));
      // The rate card only fills gaps, so an unseeded `outlets` table would
      // silently zero the EAV/reach of every clip that has no figure of its own
      // (most of them — the historical import carries tier but not value). Fall
      // back to the bundled card in that case rather than reporting zeros.
      const outlets: Outlet[] = oRes.data?.length
        ? oRes.data.map((o) => ({
            outlet: o.name,
            tier: o.tier as Tier,
            default_eav: o.default_eav,
            default_reach: o.default_reach,
          }))
        : (outletsJson as unknown as Outlet[]);
      return { source: "supabase", mentions: enrichMentions(raw, outlets) };
    }
  }
  return {
    source: "seed",
    error: db ? error : "Supabase is not configured",
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

/**
 * All competitor news the bot logged (one row per tracked rival), newest first.
 * All of it, not the latest 500: Share of Voice counts these per date range, so
 * a cap would quietly shrink every older range's competitor side.
 */
export async function getCompetitorNews(): Promise<CompetitorNewsItem[]> {
  const db = readClient();
  if (!db) return [];
  const { rows: data, error } = await readAllRows((from, to) =>
    db
      .from("mentions")
      .select("id,published_on,outlet_name,title,url,metadata")
      .eq("source", "competitor_news")
      .neq("status", "rejected")
      .order("published_on", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) return [];
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

import type { Insight } from "@/lib/pr";

/** The cached AI insights (and when they were generated), or null if none yet. */
export async function getCachedInsights(): Promise<{ insights: Insight[]; generatedAt: string } | null> {
  const db = readClient();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from("insights_cache")
      .select("payload,generated_at")
      .eq("scope", "pr")
      .maybeSingle();
    if (error || !data?.payload) return null;
    const insights = data.payload as Insight[];
    if (!Array.isArray(insights) || insights.length === 0) return null;
    return { insights, generatedAt: data.generated_at as string };
  } catch {
    return null;
  }
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
 *
 * Counted only where competitor coverage exists. The bot stored no competitor
 * story after 22 Jun 2026 while betterhomes stories kept arriving, so this read
 * 42% for the year (17% like for like, to 22 Jun). The window now ends at the
 * latest stored competitor story, and an earlier month with no competitor story
 * at all is left out, so a gap in collection can't read as rivals going quiet.
 */
export interface SovResult {
  items: SovItem[];
  capturedOn: string | null;
  /** Last day counted, when stored competitor coverage ends before today (Dubai). */
  through: string | null;
  /** "YYYY-MM" months with betterhomes stories but no competitor story, left out. */
  monthsLeftOut: string[];
}

export async function getSov(): Promise<SovResult> {
  const none: SovResult = { items: [], capturedOn: null, through: null, monthsLeftOut: [] };
  const db = readClient();
  if (!db) return none;
  const yearStart = `${new Date().getUTCFullYear()}-01-01`;
  const [{ rows, error }, latest] = await Promise.all([
    readAllRows((from, to) =>
      db
        .from("mentions")
        .select("id,source,metadata,published_on,title,outlet_name,url")
        .neq("status", "rejected")
        .in("source", ["googlenews", "competitor_news"])
        .gte("published_on", yearStart)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // Across all years: coverage that ended last December still ends the window.
    db
      .from("mentions")
      .select("published_on")
      .eq("source", "competitor_news")
      .neq("status", "rejected")
      .order("published_on", { ascending: false, nullsFirst: false })
      .limit(1),
  ]);
  if (error || latest.error) return none;
  // No competitor story stored at all: there is nothing to take a share of.
  const compThrough = (latest.data?.[0]?.published_on as string | null | undefined) ?? null;
  if (!compThrough) return none;

  const brandOf = (r: Record<string, any>) =>
    r.source === "competitor_news" ? ((r.metadata as { competitor?: string } | null)?.competitor ?? "Competitor") : "betterhomes";
  // The same story stored twice would count twice for whoever it names.
  const data = onePerPlacement(rows, (r) => ({
    brand: brandOf(r),
    date: r.published_on ?? null,
    title: r.title ?? null,
    outlet: r.outlet_name ?? null,
    url: r.url ?? null,
  }));
  const compMonths = new Set(
    data.filter((r) => r.source === "competitor_news" && r.published_on).map((r) => String(r.published_on).slice(0, 7)),
  );
  const counts = new Map<string, number>();
  const leftOut = new Set<string>();
  for (const r of data) {
    const day = String(r.published_on ?? "");
    if (!day || day > compThrough) continue;
    if (!compMonths.has(day.slice(0, 7))) {
      leftOut.add(day.slice(0, 7));
      continue;
    }
    const brand = brandOf(r);
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
  const today = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10); // Dubai, UTC+4, no DST
  return {
    items,
    capturedOn: today,
    through: compThrough < today ? compThrough : null,
    monthsLeftOut: [...leftOut].sort(),
  };
}

// ── People Sentiment (social) reads ─────────────────────────────
import { mergeConfig } from "@/lib/socialTypes";
import type { SocialConfig, SocialMention, SocialRun } from "@/lib/socialTypes";

/** The editable social/people-sentiment config (subjects + per-platform sources). */
export async function getSocialConfig(): Promise<SocialConfig> {
  const db = readClient();
  if (!db) return mergeConfig(null);
  try {
    const { data } = await db.from("social_config").select("payload").eq("id", 1).maybeSingle();
    return mergeConfig((data?.payload as Partial<SocialConfig>) ?? null);
  } catch {
    return mergeConfig(null);
  }
}

/**
 * Kept social mentions, newest first, for the feed + aggregates. All of them:
 * the tab's totals cover everything stored, so a row cap would undercount them
 * without saying so.
 */
export async function getSocialMentions(): Promise<SocialMention[]> {
  const db = readClient();
  if (!db) return [];
  try {
    const { rows, error } = await readAllRows((from, to) =>
      db
        .from("social_mentions")
        .select(
          "id,channel,subject,subject_kind,url,author,posted_at,content,rating,likes,comments,shares,sentiment,sentiment_score,sentiment_reason,status",
        )
        .neq("status", "rejected")
        .order("posted_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (error) return [];
    return rows as SocialMention[];
  } catch {
    return [];
  }
}

/** Recent social-bot run history for the status line. */
export async function getSocialRuns(limit = 5): Promise<SocialRun[]> {
  const db = readClient();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from("social_runs")
      .select("ran_at,trigger,ok,found,considered,inserted,skipped,error")
      .order("ran_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as SocialRun[];
  } catch {
    return [];
  }
}

// ── Social Performance (benchmark) reads ────────────────────────
import { mergePerfConfig } from "@/lib/perfTypes";
import type { PerfConfig, PerfMetrics, PerfPost, PerfRun } from "@/lib/perfTypes";

/** The editable benchmark config (brands + per-platform handles + actor ids). */
export async function getPerfConfig(): Promise<PerfConfig> {
  const db = readClient();
  if (!db) return mergePerfConfig(null);
  try {
    const { data } = await db.from("social_config").select("payload").eq("id", 1).maybeSingle();
    const benchmark = (data?.payload as { benchmark?: Partial<PerfConfig> } | null)?.benchmark ?? null;
    return mergePerfConfig(benchmark);
  } catch {
    return mergePerfConfig(null);
  }
}

/** Per-brand-per-platform benchmark snapshots (seed or live). */
export async function getPerfMetrics(): Promise<PerfMetrics[]> {
  const db = readClient();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from("social_perf_metrics")
      .select(
        "brand,is_us,platform,followers,posts,reels,images,avg_likes,avg_comments,avg_plays,total_plays,engagement_rate,time_window,period_label,source,captured_at",
      )
      .order("total_plays", { ascending: false });
    if (error || !data) return [];
    return data as PerfMetrics[];
  } catch {
    return [];
  }
}

/**
 * Scraped posts from the last 400 days (top-post cards), highest-reach first.
 *
 * By date, not "top 400 by plays ever": the card says "this period", and the
 * all-time list put a 25 Jun Instagram post at the top of a "Last month" view.
 * 400 days covers the longest window (a year) with room for the run date.
 */
export async function getPerfPosts(): Promise<PerfPost[]> {
  const db = readClient();
  if (!db) return [];
  try {
    const since = new Date(Date.now() - 400 * 864e5).toISOString();
    const { rows, error } = await readAllRows((from, to) =>
      db
        .from("social_perf_posts")
        .select("id,brand,is_us,platform,external_id,url,type,posted_at,likes,comments,shares,plays,caption")
        .gte("posted_at", since)
        .order("plays", { ascending: false, nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (error) return [];
    return rows as PerfPost[];
  } catch {
    return [];
  }
}

/** Recent benchmark-run history for the status line. */
export async function getPerfRuns(limit = 5): Promise<PerfRun[]> {
  const db = readClient();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from("social_perf_runs")
      .select("ran_at,trigger,ok,time_window,brands,platforms,posts_found,metrics_written,error")
      .order("ran_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as PerfRun[];
  } catch {
    return [];
  }
}

// ── SEO tab config (editable target keyword list) ───────────────
export const DEFAULT_SEO_KEYWORDS = [
  "rent apartment abu dhabi",
  "dubai villa for sale",
  "apartment for rent abu dhabi",
  "villa for sale in dubai",
  "apartments for sale in abu dhabi",
  "townhouses for sale in dubai",
  "villas for sale in dubai",
  "dubai marina apartments for sale",
  "villas for sale in sharjah",
  "apartment for sale in dubai",
  "apartment for rent in dubai",
  "property for sale in dubai",
  "villas for sale in abu dhabi",
  "dubai apartment for sale",
];

export interface SeoConfig {
  keywords: string[];
}

export type PaidAccountRef = { id: string; name: string };
export type PaidConfig = { accounts: Record<"google" | "meta" | "linkedin", PaidAccountRef[]> };
const EMPTY_PAID: PaidConfig = { accounts: { google: [], meta: [], linkedin: [] } };

/**
 * Which ad accounts the Digital Performance tab shows.
 *
 * Defaults to empty rather than to "everything": the connected platforms expose
 * 41 Meta accounts alone, most of them closed, disabled, or read-only messaging
 * integrations. An empty selection makes the tab ask which accounts matter,
 * which is cheaper and more honest than guessing and rendering noise.
 */
export async function getPaidConfig(): Promise<PaidConfig> {
  const db = readClient();
  if (!db) return EMPTY_PAID;
  try {
    const { data } = await db.from("paid_config").select("payload").eq("id", 1).maybeSingle();
    const acc = (data?.payload as PaidConfig | null)?.accounts;
    if (!acc) return EMPTY_PAID;
    const pick = (k: "google" | "meta" | "linkedin") =>
      (Array.isArray(acc[k]) ? acc[k] : []).filter((a) => a && typeof a.id === "string" && a.id).map((a) => ({ id: a.id, name: String(a.name || a.id) }));
    return { accounts: { google: pick("google"), meta: pick("meta"), linkedin: pick("linkedin") } };
  } catch {
    return EMPTY_PAID;
  }
}

/** The editable SEO config (target keywords tracked in GSC). */
export async function getSeoConfig(): Promise<SeoConfig> {
  const db = readClient();
  if (!db) return { keywords: DEFAULT_SEO_KEYWORDS };
  try {
    const { data } = await db.from("seo_config").select("payload").eq("id", 1).maybeSingle();
    const kw = (data?.payload as { keywords?: string[] } | null)?.keywords;
    return { keywords: kw?.length ? kw : DEFAULT_SEO_KEYWORDS };
  } catch {
    return { keywords: DEFAULT_SEO_KEYWORDS };
  }
}
