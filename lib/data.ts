// Single source the dashboard reads from: Supabase when configured, otherwise
// the bundled JSON seed (so the app still renders before the DB is wired).
import { enrichMentions, latestPublishedOn, type Insight } from "@/lib/pr";
import { onePerPlacement } from "@/lib/placement";
import { buildPressMentions, type PressArticle, type PressMentions, type PressRow } from "@/lib/pressMentions";
import { asRecord, errorMessage, oneLine } from "@/lib/coerce";
import { readClient } from "@/lib/supabase";
import { INSIGHTS_SCOPE, readInsightsCache, type InsightEvidence } from "@/lib/insightsCache";
import { COMPANY_COLUMNS, US, aliasList, companyNamed, registryFromRows, siteList } from "@/lib/news/registry";
import { KEPT_NOTE, REJECTED_NOTE, dubaiDay, rejectedByHand, runEnv, runEnvFilter } from "@/lib/news/store";
import { ownSiteIn, withoutOwnSite } from "@/lib/news/ownSite";
import type { MentionRow } from "@/lib/news/write";
import type { ArticleRow, ArticleStatus, DecidedMention, Decision, MentionRole, Registry, StepCounts } from "@/lib/news/types";
import type { Mention, Outlet, RawMention, Sentiment, Tier } from "@/lib/types";
import rawMentions from "@/data/mentions.json";
import outletsJson from "@/data/outlets.json";

type ReadDb = NonNullable<ReturnType<typeof readClient>>;

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

interface MentionsResult {
  mentions: Mention[];
  source: "supabase" | "seed";
  /** Why the live read failed, when it did and the page fell back to the bundled file. */
  error?: string;
}

/**
 * `{ articleId }` for a row whose metadata.articleId (read as
 * `articleId:metadata->>articleId`) names one of the news bot's articles, and
 * nothing for any other row.
 */
const articleOf = (v: unknown): { articleId?: string } => (typeof v === "string" && v.trim() ? { articleId: v.trim() } : {});

/**
 * Once `dropped` is folded into `kept`, the bot's rows `kept` stands for: those
 * it stood for already, `dropped` itself when the bot wrote it, and those
 * `dropped` stood for. An old bot row names no article, but the article
 * imported from it names the row (legacy_mention_id), so Press mentions looks
 * each one up.
 */
function foldBotRows(kept: { botRowIds?: string[] }, dropped: { id: string; botRowIds?: string[] }, droppedIsBot: boolean) {
  const ids = [...(kept.botRowIds ?? []), ...(droppedIsBot ? [dropped.id] : []), ...(dropped.botRowIds ?? [])];
  if (ids.length) kept.botRowIds = [...new Set(ids)];
}

/**
 * The clips getMentions counts, from the mentions rows it read: one per
 * placement (lib/placement.ts), each marked foundByBot when it, or a twin
 * folded into it, is the bot's own ('googlenews'), and given the bot's
 * article when it, or a twin folded into it, names one (metadata.articleId,
 * read as `articleId`). The bot's rows folded into a clip are kept on it
 * (botRowIds). Pure, so it can be tested.
 *
 * The archive's copy of a story wins when only it names the outlet the rate
 * card's way, so the bot's find can be the copy folded away. The story was
 * still found by the bot, and Share of Voice counts it as such; Press
 * mentions lists it with the rest of that article.
 */
export function clipsFromRows(rows: Record<string, any>[]): RawMention[] {
  return onePerPlacement(
    rows.map(
      (r): RawMention => ({
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
        ...(r.source === "googlenews" ? { foundByBot: true } : {}),
        ...articleOf(r.articleId),
      }),
    ),
    (m) => ({ brand: m.brand, date: m.date, title: m.title, outlet: m.outlet, url: m.url }),
    (kept, dropped) => {
      if (dropped.foundByBot) kept.foundByBot = true;
      if (!kept.articleId && dropped.articleId) kept.articleId = dropped.articleId;
      foldBotRows(kept, dropped, dropped.source === "googlenews");
    },
  );
}

export async function getMentions(): Promise<MentionsResult> {
  const db = readClient();
  let error: string | undefined;
  if (db) {
    const [mRes, oRes] = await Promise.all([
      readAllRows((from, to) =>
        db
          .from("mentions")
          .select("id,published_on,tier,outlet_name,title,url,eav,reach,brand,sentiment,source,articleId:metadata->>articleId")
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
      const raw = clipsFromRows(mRes.rows);
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
  /** Why the bot rejected it, in the bot's words. */
  reason: string | null;
}

const BOT_FIELDS = "id,published_on,outlet_name,title,url,status,sentiment,reason:metadata->>reason";

/**
 * Stories the fact check moved out of the count, whatever their date, so the
 * PR team can find any of them to keep it.
 *
 * Not the ones a person has decided since (metadata.personVerdict): a Reject
 * settles it, and listing it beside a Keep button would invite undoing it by
 * mistake, and a story a person kept is no longer a drop.
 */
export async function getFactCheckDrops(): Promise<BotActivityItem[]> {
  const db = readClient();
  if (!db) return [];
  const { data, error } = await db
    .from("mentions")
    .select(BOT_FIELDS)
    .eq("source", "googlenews")
    .eq("status", "rejected")
    .not("metadata->factCheck->>prevStatus", "is", null)
    .is("metadata->>personVerdict", null)
    .order("published_on", { ascending: false, nullsFirst: false });
  if (error || !data) return [];
  // Nor an old row withdrawn because the same story is stored under a newer
  // article: it is not a drop, and keeping it would count the story twice.
  return (data as BotActivityItem[]).filter((r) => !String(r.reason ?? "").startsWith(SAME_STORY_REASON));
}

/** The reason lib/news/write.ts gives an old row withdrawn as a duplicate of a newer article. */
const SAME_STORY_REASON = "news check: the same story as article";

export interface CompetitorNewsItem {
  id: string;
  /** The rival's label in tracked_keywords, as the news bot names it. */
  brand: string;
  published_on: string | null;
  outlet_name: string | null;
  title: string | null;
  url: string | null;
  /**
   * The news bot's article the story is (news_articles.id): its row's
   * metadata.articleId, or that of a row folded into it. Left out when no
   * row says.
   */
  articleId?: string;
  /** The bot's rows for the same story folded into this one, for Press mentions (clipsFromRows' botRowIds). */
  botRowIds?: string[];
}

interface CompetitorNewsResult {
  items: CompetitorNewsItem[];
  /**
   * Why the coverage or the rival list could not be read. `items` is then
   * empty, which must be shown as a failed read, never as "no coverage".
   */
  error: string | null;
}

/**
 * The active rivals in tracked_keywords as the news bot's registry holds them
 * (lib/news/registry.ts), with their other spellings and websites, and
 * betterhomes' websites from the 'us' row, so a row is matched to a company
 * the way the bot matches it. No spokespeople: only the companies are needed here.
 */
async function activeRivals(db: ReadDb): Promise<{ reg: Registry; error: null } | { reg: null; error: string }> {
  const { data, error } = await db
    .from("tracked_keywords")
    .select(COMPANY_COLUMNS)
    .in("kind", ["competitor", "us"])
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (error) return { reg: null, error: `the rival list could not be read: ${error.message}` };
  return { reg: registryFromRows(data ?? [], []), error: null };
}

/**
 * All competitor news the bot logged, newest first: one row per placement per
 * rival, for the rivals tracked now. All of it, not the latest 500: Share of
 * Voice counts these per date range, so a cap would quietly shrink every older
 * range's competitor side.
 *
 * Each row is named by the rival's current label, whatever spelling it was
 * stored under ("Engel & Volkers" is Engel & Völkers), and a rival no longer
 * tracked is left out: its old stories would otherwise go on taking a share
 * nobody can see in the keyword list. The same story stored twice, under the
 * outlet's name once and its web address once, is one story (lib/placement.ts).
 */
export async function getCompetitorNews(): Promise<CompetitorNewsResult> {
  const db = readClient();
  if (!db) return { items: [], error: "Supabase is not configured" };
  const [news, rivals] = await Promise.all([
    readAllRows((from, to) =>
      db
        .from("mentions")
        .select("id,published_on,outlet_name,title,url,competitor:metadata->>competitor,articleId:metadata->>articleId")
        .eq("source", "competitor_news")
        .neq("status", "rejected")
        .order("published_on", { ascending: false, nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    activeRivals(db),
  ]);
  if (news.error) return { items: [], error: `the competitor stories could not be read: ${news.error}` };
  if (!rivals.reg) return { items: [], error: rivals.error };
  return { items: competitorStories(news.rows, rivals.reg), error: null };
}

/**
 * A competitor_news row as getCompetitorNews reads it: metadata.competitor as
 * `competitor`, and metadata.articleId as `articleId`.
 */
export type CompetitorRow = Record<"id" | "published_on" | "outlet_name" | "title" | "url" | "competitor", unknown> & {
  articleId?: unknown;
};

/** Text as stored, or null for anything else. */
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * The competitor feed from its stored rows, newest first as given: each named
 * by the registry's label for its metadata.competitor (companyNamed, so any
 * spelling of a tracked rival is that rival), a row for no tracked rival left
 * out, then one per placement per rival. A story keeps the bot's article of a
 * twin folded into it when it names none itself, as getMentions' clips do.
 * Pure, so it can be tested.
 */
export function competitorStories(rows: CompetitorRow[], reg: Registry): CompetitorNewsItem[] {
  const items: CompetitorNewsItem[] = [];
  for (const r of rows) {
    const company = companyNamed(reg, text(r.competitor));
    if (!company || company.isUs) continue;
    items.push({
      id: String(r.id),
      brand: company.label,
      published_on: text(r.published_on),
      outlet_name: text(r.outlet_name),
      title: text(r.title),
      url: text(r.url),
      ...articleOf(r.articleId),
    });
  }
  return onePerPlacement(
    items,
    (c) => ({ brand: c.brand, date: c.published_on, title: c.title, outlet: c.outlet_name, url: c.url }),
    (kept, dropped) => {
      if (!kept.articleId && dropped.articleId) kept.articleId = dropped.articleId;
      // Every rival story is a bot row.
      foldBotRows(kept, dropped, true);
    },
  );
}

export interface TrackedKeyword {
  id: number;
  query: string;
  label: string | null;
  /** When it was added (tracked_keywords.created_at). For a rival, when the bot began looking for its coverage. */
  createdAt: string | null;
  /** A rival's other spellings (lib/news/registry.ts). Empty for a search, and for a rival known by its name alone. */
  aliases: string[];
  /** The company's own websites (lib/news/ownSite.ts). Empty for a search. */
  sites: string[];
}

interface TrackedKeywords {
  pr: TrackedKeyword[];
  competitor: TrackedKeyword[];
  /** The row holding betterhomes' own websites (kind 'us'), or null when there is none. */
  us: TrackedKeyword | null;
  /**
   * Why the lists could not be read. They are then empty, and the editor says
   * so: showing the built-in defaults instead read as the lists the bot uses,
   * when it searches with whatever the table holds.
   */
  error: string | null;
}

/**
 * The bot's editable search lists, as PR & Media settings shows the companies,
 * with each company's spellings and websites as the bot reads them.
 */
export async function getTrackedKeywords(): Promise<TrackedKeywords> {
  const failed = (error: string): TrackedKeywords => ({ pr: [], competitor: [], us: null, error });
  const db = readClient();
  if (!db) return failed("Supabase is not configured");
  try {
    const { data, error } = await db
      .from("tracked_keywords")
      .select("id,kind,query,label,active,created_at,aliases,sites")
      .eq("active", true)
      .order("created_at", { ascending: true });
    if (error) return failed(error.message);
    const map = (kind: string) =>
      (data ?? [])
        .filter((r) => r.kind === kind)
        .map((r) => ({
          id: Number(r.id),
          query: String(r.query),
          label: (r.label as string | null) ?? null,
          createdAt: (r.created_at as string | null) ?? null,
          aliases: aliasList(r.aliases),
          sites: siteList(r.sites),
        }));
    return { pr: map("pr"), competitor: map("competitor"), us: map("us")[0] ?? null, error: null };
  } catch (e) {
    return failed(errorMessage(e));
  }
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

/** The cached AI insights, with the evidence their run read and when it ran. */
interface CachedInsights {
  insights: Insight[];
  /** What the run read. Null for a set cached before Nov 2026, which can't be checked and so isn't shown. */
  evidence: InsightEvidence | null;
  generatedAt: string;
}

/** The cached AI insights, or null if there are none yet, in either of the shapes the cache has held (readInsightsCache). */
export async function getCachedInsights(): Promise<CachedInsights | null> {
  const db = readClient();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from("insights_cache")
      .select("payload,generated_at")
      .eq("scope", INSIGHTS_SCOPE)
      .maybeSingle();
    if (error || !data?.payload) return null;
    const cached = readInsightsCache(data.payload);
    if (!cached) return null;
    return { insights: cached.insights, evidence: cached.evidence, generatedAt: String(data.generated_at) };
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
interface SovResult {
  items: SovItem[];
  capturedOn: string | null;
  /** Last day counted, when stored competitor coverage ends before today (Dubai). */
  through: string | null;
  /** "YYYY-MM" months with betterhomes stories but no competitor story, left out. */
  monthsLeftOut: string[];
  /**
   * Why the share could not be worked out. `items` is then empty, which
   * callers must show as a failed read, not as "no Share of Voice yet".
   */
  error: string | null;
}

/**
 * The year is Dubai's: from 00:00 on 1 January in Dubai, which is 20:00 UTC on
 * 31 December, so the first four hours of the new year no longer count the
 * old one. The rivals are the ones tracked now, one story per placement, by
 * the same rules as the competitor feed (getCompetitorNews), and ours are one
 * per placement by the same rule.
 */
export async function getSov(): Promise<SovResult> {
  const none = (error: string | null): SovResult => ({ items: [], capturedOn: null, through: null, monthsLeftOut: [], error });
  const db = readClient();
  if (!db) return none("Supabase is not configured");
  const today = dubaiDay();
  const [rivals, ours] = await Promise.all([
    // Every year's: coverage that ended last December still ends the window.
    getCompetitorNews(),
    readAllRows((from, to) =>
      db
        .from("mentions")
        .select("id,published_on,title,outlet_name,url")
        .eq("source", "googlenews")
        .neq("status", "rejected")
        .gte("published_on", `${today.slice(0, 4)}-01-01`)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);
  if (rivals.error) return none(rivals.error);
  if (ours.error) return none(`our stories could not be read: ${ours.error}`);
  return shareOfVoice(rivals.items, ours.rows, today);
}

/**
 * Share of Voice for the Dubai year that `today` (YYYY-MM-DD, Dubai) is in,
 * from every rival story on record (getCompetitorNews: tracked rivals, one per
 * placement) and our bot-found rows, which are made one per placement here.
 * Pure, so it can be tested.
 */
export function shareOfVoice(
  rivals: CompetitorNewsItem[],
  ours: Record<"published_on" | "title" | "outlet_name" | "url", unknown>[],
  today: string,
): SovResult {
  const yearStart = `${today.slice(0, 4)}-01-01`;
  // No competitor story stored at all: there is nothing to take a share of.
  const compThrough = latestPublishedOn(rivals);
  if (!compThrough) return { items: [], capturedOn: null, through: null, monthsLeftOut: [], error: null };

  // The same story stored twice would count twice for whoever it names. The
  // rivals' stories come one per placement already.
  const ourStories = onePerPlacement(ours, (r) => ({
    brand: US.label,
    date: text(r.published_on),
    title: text(r.title),
    outlet: text(r.outlet_name),
    url: text(r.url),
  }));
  const stories = [
    ...rivals.map((c) => ({ brand: c.brand, day: c.published_on ?? "" })),
    ...ourStories.map((r) => ({ brand: US.label, day: text(r.published_on) ?? "" })),
  ].filter((s) => s.day >= yearStart);
  const compMonths = new Set(stories.filter((s) => s.brand !== US.label).map((s) => s.day.slice(0, 7)));
  const counts = new Map<string, number>();
  const leftOut = new Set<string>();
  for (const { brand, day } of stories) {
    if (day > compThrough) continue;
    if (!compMonths.has(day.slice(0, 7))) {
      leftOut.add(day.slice(0, 7));
      continue;
    }
    counts.set(brand, (counts.get(brand) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  const items: SovItem[] = [...counts.entries()]
    .map(([brand, mentions]) => ({
      brand,
      mentions,
      share: Math.round((mentions / total) * 100),
      isUs: brand === US.label,
    }))
    .sort((a, b) => b.mentions - a.mentions);
  return {
    items,
    capturedOn: today,
    through: compThrough < today ? compThrough : null,
    monthsLeftOut: [...leftOut].sort(),
    error: null,
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

// ── SEO tab config (the target keyword list, read from seo_config) ──
const DEFAULT_SEO_KEYWORDS = [
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

interface SeoConfig {
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

/**
 * The SEO tab's target keywords tracked in GSC: the seo_config row, which is
 * changed in the database by hand, or DEFAULT_SEO_KEYWORDS when it holds none.
 */
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

// ── News bot: Bot Activity, on PR & Media settings ──────────────
//
// What the news bot (docs/news-pipeline.md) shows the PR team: every stored
// article with what happened to it and why, this morning's run in numbers,
// the possible moves the AI noticed, and the spokespeople list. The pure parts
// are exported so lib/data.test.ts can check them without a database, and so
// app/actions.ts writes a person's Keep and Reject by the same rules that Bot
// Activity reads them back by.

/**
 * A news_articles status as stored, "held" included (migration 0022): sorted
 * by the AI while counting on the PR tab is switched off, so Bot Activity
 * shows what would count before it does.
 */
export type StoredArticleStatus = ArticleStatus;

/** The person's verdict an article's note records, if it records one. */
export function noteVerdict(note: string | null | undefined): "kept" | "rejected" | null {
  const n = (note ?? "").trim().toLowerCase();
  if (n.startsWith(KEPT_NOTE)) return "kept";
  if (n.startsWith(REJECTED_NOTE)) return "rejected";
  return null;
}

/** The `model` in metadata.factCheck of a row a person kept: where the AI's name goes when the AI proved it. */
export const PERSON_CHECK = "person";

/**
 * Statuses a later step can still take an article from: read, check, retry or
 * publish it. A person's Reject moves such an article to decided with no
 * company (rejectedDecision), so no run counts it, rival rows included.
 * decided, no_names, skipped and duplicate are final already.
 */
const OPEN_STATUSES: ReadonlySet<StoredArticleStatus> = new Set<StoredArticleStatus>([
  "queued",
  "reading",
  "read",
  "checking",
  "held",
  "unreadable",
  "failed",
]);

/** True when a later run could still sort or count this article. */
export const stillOpen = (status: string): boolean => OPEN_STATUSES.has(status as StoredArticleStatus);

/** The decision a person's Reject saves on an article a run could still count: about no company, by a person. */
export function rejectedDecision(checkedAt: string): Decision {
  return {
    mentions: [],
    irrelevantReason: "a person rejected it",
    possibleMoves: [],
    dropped: [],
    model: PERSON_CHECK,
    checkedAt,
  };
}

/**
 * The bot's own words as a sentence: "the AI found no tracked company in it"
 * becomes "The AI found no tracked company in it." Our name keeps its small
 * letter even at the start, as the brand writes it.
 */
function asSentence(text: unknown): string | null {
  const t = oneLine(text);
  if (!t) return null;
  const s = /^(betterhomes|bhomes)\b/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

/** The Dubai day of a timestamp, or "" when it isn't one: a bad date must not take the whole list down. */
function dayOf(iso: string | null | undefined): string {
  const d = new Date(iso ?? "");
  return Number.isNaN(d.getTime()) ? "" : dubaiDay(d);
}

const inParts = <T>(xs: T[], size = 100): T[][] =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, i * size + size));

/**
 * Which filter an article falls under in Bot Activity. "held": sorted as about
 * a tracked company while counting was off, so it waits to be published.
 */
export type NewsGroup = "ours" | "rivals" | "held" | "rejected" | "waiting" | "duplicate";

/** The colour of an article's result badge: one of the .sent-* classes in globals.css. */
export type NewsTone = "positive" | "mixed" | "negative" | "neutral" | "none";

/** One stored article, as Bot Activity lists it. */
export interface NewsArticleItem {
  id: string;
  title: string;
  outlet: string | null;
  /** The article's date, or the Dubai day the bot found it when the feed gave none. */
  date: string;
  /** The publisher's page once the Google link is unwrapped, else the Google News link. */
  link: string | null;
  status: StoredArticleStatus;
  /** What the bot made of it: "Ours", "Knight Frank", "Ours + Knight Frank", "Rejected", "No names", "Waiting"... */
  result: string;
  tone: NewsTone;
  group: NewsGroup;
  /** A person's Keep or Reject, which stands over whatever the bot decides. */
  person: "kept" | "rejected" | null;
  /** Said when part of it counts on the PR tab although the bot hasn't counted it, such as the old bot's row. */
  countNote: string | null;
  /** For each company it is about, the sentence that proves it, word for word from the article. */
  quotes: { company: string; isUs: boolean; role: MentionRole; quote: string }[];
  /** Why it was rejected, what it is waiting for, or why it stopped. */
  reason: string | null;
  /** Claims the AI made that the program refused, with why. */
  refused: string[];
  /** Keep makes sense: it doesn't count as ours now, and it isn't a copy of another article. */
  canKeep: boolean;
  /** Reject makes sense: part of it counts now or counts once published, or the AI gave up on it and a person has to decide. */
  canReject: boolean;
  /**
   * Ruled out by the program itself, with nothing of it counting and no
   * person's verdict: a look-alike name in the headline such as Better Homes
   * & Gardens, a page read in full naming nobody tracked, or a company's own
   * website. PR & Media settings lists these apart, under one line.
   */
  ruledOut: boolean;
}

/** The news_articles columns Bot Activity reads. */
export type NewsArticleRecord = Pick<
  ArticleRow,
  | "id"
  | "title"
  | "outlet"
  | "published_on"
  | "first_seen_at"
  | "url"
  | "google_link"
  | "decision"
  | "legacy_mention_id"
  | "note"
  | "error"
  | "read_attempts"
> & { status: StoredArticleStatus };

const ARTICLE_FIELDS =
  "id,title,outlet,published_on,first_seen_at,url,google_link,status,decision,legacy_mention_id,note,error,read_attempts";

/** A mentions row of a stored article: ours, a rival's, or the old bot's row it was imported from. */
export interface ArticleMentionRow {
  id: string;
  isUs: boolean;
  /** betterhomes, or the rival's label as the row gives it. */
  company: string;
  /** Counts on the PR tab: anything but rejected. */
  counting: boolean;
  personVerdict: "kept" | "rejected" | null;
}

/** The columns of a mentions row that articleMentionRows reads. */
type MentionRef = {
  id: string;
  status: string;
  source: string | null;
  competitor: string | null;
  personVerdict: string | null;
  /** metadata.rejected_by, which only the old rival feed's cleanup by hand wrote (rejectedByHand). */
  rejectedBy?: string | null;
  articleId: string | null;
};

/** The sources the bots write. A row from the historical import is "reviewed" from the start, which says nothing about a person. */
const BOT_SOURCES = new Set(["googlenews", "competitor_news"]);

/**
 * A mentions row read the way Bot Activity needs it. The company follows the
 * PR page's rule (getMentions, getSov): competitor_news is a rival's, anything
 * else ours. A bot's row reviewed without a verdict was kept by the old Bot
 * Activity, which set the status and nothing else, and a row rejected by hand
 * in the old rival feed's cleanup was a person's Reject (rejectedByHand).
 *
 * A rival's row is named and counted as the competitor feed and Share of
 * Voice count it (competitorStories): by the label of the rival `reg` tracks
 * now, whatever spelling it was stored under ("Engel & Volkers" is Engel &
 * Völkers), and not at all for a rival no longer tracked. Bot Activity said
 * such a row was still counted on the PR tab, which leaves it out.
 */
export function toArticleMentionRow(r: Omit<MentionRef, "articleId">, reg: Registry): ArticleMentionRow {
  const verdict =
    r.personVerdict === "kept" || r.personVerdict === "rejected"
      ? r.personVerdict
      : rejectedByHand({ status: r.status, metadata: { rejected_by: r.rejectedBy } })
        ? "rejected"
        : r.status === "reviewed" && BOT_SOURCES.has(r.source ?? "")
          ? "kept"
          : null;
  const isUs = r.source !== "competitor_news";
  const rival = isUs ? null : companyNamed(reg, r.competitor);
  const tracked = isUs || (!!rival && !rival.isUs);
  return {
    id: r.id,
    isUs,
    company: isUs ? US.label : rival && !rival.isUs ? rival.label : oneLine(r.competitor) || "a rival",
    counting: r.status !== "rejected" && tracked,
    personVerdict: verdict,
  };
}

/**
 * The person's verdict on an article. Our row's comes first, since Keep is
 * about us; then a Reject on any of its rows; then the note Keep and Reject
 * leave, which is all an article with no row to carry the verdict has.
 */
function personVerdictOf(rows: ArticleMentionRow[] | null, note: string | null): "kept" | "rejected" | null {
  const ours = rows?.find((r) => r.isUs && r.personVerdict)?.personVerdict;
  if (ours) return ours;
  if (rows?.some((r) => r.personVerdict === "rejected")) return "rejected";
  return noteVerdict(note);
}

/** What the bot made of an article, before any person's verdict. */
function botResult(status: StoredArticleStatus, ours: boolean, rivals: string[]): { result: string; tone: NewsTone; group: NewsGroup } {
  switch (status) {
    case "decided":
    case "held": {
      // Held: sorted, but not counted until it is published. What it would
      // count is said, so the PR team can check the bot before it counts.
      const held = status === "held";
      const suffix = held ? " (held)" : "";
      if (ours) {
        const names = rivals.length ? `Ours + ${rivals.join(", ")}` : "Ours";
        return { result: names + suffix, tone: "positive", group: held ? "held" : "ours" };
      }
      if (rivals.length) return { result: rivals.join(", ") + suffix, tone: "mixed", group: held ? "held" : "rivals" };
      return { result: "Rejected", tone: "none", group: "rejected" };
    }
    case "no_names":
      return { result: "No names", tone: "none", group: "rejected" };
    case "skipped":
      return { result: "Skipped", tone: "none", group: "rejected" };
    case "duplicate":
      return { result: "Duplicate", tone: "none", group: "duplicate" };
    case "unreadable":
      return { result: "Unreadable", tone: "neutral", group: "waiting" };
    case "failed":
      return { result: "Failed", tone: "negative", group: "waiting" };
    default:
      return { result: "Waiting", tone: "neutral", group: "waiting" };
  }
}

/** The bot's own note on an article as a sentence. The note Keep and Reject leave is shown as the verdict instead. */
const botNote = (a: NewsArticleRecord) => (noteVerdict(a.note) ? null : asSentence(a.note));

/** What an article the AI hasn't sorted is waiting for, or why it stopped, in plain words. */
function stateReason(a: NewsArticleRecord): string | null {
  const note = botNote(a);
  const error = asSentence(a.error);
  const tries = Math.max(1, Number(a.read_attempts) || 0);
  switch (a.status) {
    case "queued":
      return note ? `Waiting to be read again. Last try: ${note}` : "Waiting to be read.";
    case "reading":
      return "Being read now.";
    case "read":
      return `It names a tracked company or person, so it is waiting for the AI.${error ? ` Last try: ${error}` : ""}`;
    case "checking":
      return "With the AI now.";
    case "no_names":
      return note ?? "Read in full: it names no tracked company or person.";
    case "unreadable": {
      const why = note ?? "The page could not be read, and the headline names nobody the bot tracks.";
      return tries >= 3
        ? `${why} Tried ${tries} times, so it is not tried again.`
        : `${why} It is tried again on a later morning: ${tries} of 3 tries so far.`;
    }
    case "skipped":
      return note ?? "The headline rules it out.";
    case "duplicate":
      return "The same article as another one in this list, which is the one that counts.";
    case "failed":
      return `${error ?? "The AI could not answer after three tries."} A person needs to decide.`;
    default:
      return note;
  }
}

/**
 * How Bot Activity shows one article: what the bot made of it and why, the
 * person's verdict, and whether Keep and Reject apply.
 *
 * `rows` are the article's mentions rows, which say what really counts. Null
 * means they could not be read, and the decision stands in for them, so a
 * failed read never offers Keep on an article that already counts.
 *
 * A story imported from the old bot is stored as decided with no decision
 * (lib/news/migrate.ts), so for it the old bot's row is the result: it is not
 * a rejection just because the new bot never sorted it.
 *
 * `reg` is the companies tracked now, with their websites. Null means they
 * could not be read, and the decision is shown as stored.
 */
export function describeArticle(a: NewsArticleRecord, rows: ArticleMentionRow[] | null, reg: Registry | null): NewsArticleItem {
  const sorted = a.status === "decided" || a.status === "held";
  const imported = a.status === "decided" && !a.decision;
  // Shown as it is written (lib/news/write.ts writeDecision): never for the
  // company whose own website it is on (lib/news/ownSite.ts), a decision held
  // from before that rule included.
  const stored = sorted ? a.decision : null;
  const decision = stored && Array.isArray(stored.mentions) && reg ? withoutOwnSite(stored, ownSiteIn(a, reg)) : stored;
  const mentions = (decision && Array.isArray(decision.mentions) ? decision.mentions : []).filter(
    (m) => typeof m?.company === "string" && typeof m?.quote === "string",
  );
  const companies = imported
    ? [...new Set((rows ?? []).filter((r) => r.counting).map((r) => r.company))]
    : [...new Set(mentions.map((m) => m.company))];
  const ours = companies.includes(US.label);
  const rivals = companies.filter((c) => c !== US.label);
  const base: ReturnType<typeof botResult> =
    imported && !rows ? { result: "Imported", tone: "none", group: "waiting" } : botResult(a.status, ours, rivals);
  const person = personVerdictOf(rows, a.note);

  // The bot counts a decided article only: a held one waits for counting to be switched on.
  const botCounts = a.status === "decided" && companies.length > 0;
  const oursCounts = rows
    ? rows.some((r) => r.isUs && r.counting)
    : person === "kept" || (person !== "rejected" && botCounts && ours);
  const anyCounts = rows ? rows.some((r) => r.counting) : person === "kept" || (person !== "rejected" && botCounts);

  let reason: string | null = null;
  if (imported) reason = `${botNote(a) ?? "Imported from the old bot."} The new bot has not checked it.`;
  // A Reject saved before Bot Activity became the Review list named the old page: it reads as a Reject saved now.
  else if (sorted && !mentions.length) {
    reason = asSentence(oneLine(decision?.irrelevantReason).replace(/ on Bot Activity$/, "")) ?? "The AI found no tracked company in it.";
  }
  // Said in the past tense: counting may be on again by now, with the publish still to run.
  else if (a.status === "held") reason = "Sorted while counting on the PR tab was switched off, so it is held back until it is published.";
  else if (!sorted) reason = stateReason(a);

  let countNote: string | null = null;
  if (!person && anyCounts && !botCounts) {
    countNote = sorted
      ? "Still counted on the PR tab."
      : "Still counted on the PR tab from the old bot, until the new one checks it.";
  }

  // The program's own rejections, made without the AI: skipped by the
  // headline, read in full naming nobody, or a decision it wrote itself
  // ("none: ...", lib/news/run.ts and ownSite.ts) about no company.
  const byProgram =
    a.status === "no_names" ||
    a.status === "skipped" ||
    (!mentions.length && typeof decision?.model === "string" && decision.model.startsWith("none:"));

  return {
    id: a.id,
    title: a.title,
    outlet: a.outlet,
    date: a.published_on ?? dayOf(a.first_seen_at),
    link: a.url || a.google_link || null,
    status: a.status,
    result: base.result,
    tone: base.tone,
    group: person === "kept" ? "ours" : person === "rejected" ? "rejected" : base.group,
    person,
    countNote,
    // Not the headline a person's Keep stood in with (sentence 0): nobody found it as a sentence naming us.
    quotes: mentions
      .filter((m) => !(decision?.model === PERSON_CHECK && m.sentence === 0))
      .map((m) => ({ company: m.company, isUs: m.company === US.label, role: m.role, quote: m.quote })),
    reason,
    refused: (decision && Array.isArray(decision.dropped) ? decision.dropped : [])
      .slice(0, 3)
      .map((d) => asSentence(d?.company ? `${d.company}: ${d.why}` : d?.why))
      .filter((s): s is string => !!s),
    canKeep: a.status !== "duplicate" && !oursCounts,
    // A held article counts once published, so a person can reject it before then.
    canReject:
      anyCounts || (person !== "rejected" && (a.status === "failed" || (a.status === "held" && companies.length > 0))),
    // Still listed with the rest while part of it counts, or once a person has decided it.
    ruledOut: byProgram && !person && !anyCounts,
  };
}

/**
 * The mentions rows of each article, by article id: every row the news bot
 * or a person wrote for it, which carry metadata.articleId, and the old bot's
 * row an imported article came from (legacy_mention_id), each named by the
 * company `reg` tracks now. Null when they can't be read, so nothing is shown
 * as counting or not on a guess.
 */
async function articleMentionRows(
  db: ReadDb,
  articles: NewsArticleRecord[],
  reg: Registry,
): Promise<Map<string, ArticleMentionRow[]> | null> {
  const ids = new Set(articles.map((a) => a.id));
  const legacyOf = new Map<string, string>();
  for (const a of articles) if (a.legacy_mention_id) legacyOf.set(a.legacy_mention_id, a.id);
  const fields =
    "id,status,source,competitor:metadata->>competitor,personVerdict:metadata->>personVerdict,rejectedBy:metadata->>rejected_by,articleId:metadata->>articleId";
  // A hundred ids a read keeps each request's address well inside the gateway's limit.
  const reads = await Promise.all([
    ...inParts([...ids]).map((part) => db.from("mentions").select(fields).in("metadata->>articleId", part)),
    ...inParts([...legacyOf.keys()]).map((part) => db.from("mentions").select(fields).in("id", part)),
  ]);
  if (reads.some((r) => r.error)) return null;
  const out = new Map<string, ArticleMentionRow[]>();
  for (const r of reads.flatMap((res) => (res.data ?? []) as unknown as MentionRef[])) {
    const owner = r.articleId && ids.has(r.articleId) ? r.articleId : legacyOf.get(r.id);
    if (!owner) continue;
    const list = out.get(owner) ?? [];
    if (!list.some((x) => x.id === r.id)) list.push(toArticleMentionRow(r, reg));
    out.set(owner, list);
  }
  return out;
}

/**
 * The newest stored articles, by when the bot first found them, with what
 * happened to each. Null when news_articles can't be read, so Bot Activity
 * says so instead of showing an empty list as if the bot had found nothing.
 *
 * The companies tracked now are read once, beside the articles, for both
 * their rows and the own-website rule. When they can't be read, no row is
 * read either, so nothing is shown as counting or not on a guess.
 */
export async function getNewsArticles(limit = 300): Promise<NewsArticleItem[] | null> {
  const db = readClient();
  if (!db) return null;
  try {
    // The articles the new bot has worked on, latest first. By when they were
    // last touched, not first found: a re-checked old story was first found
    // years ago and would never reach the list. Imported stories the bot has
    // not looked at, and the old bot's second copies, are left out: there is
    // nothing yet to review in them.
    const [{ data, error }, companies] = await Promise.all([
      db
        .from("news_articles")
        .select(ARTICLE_FIELDS)
        .or("legacy_mention_id.is.null,decision.not.is.null,and(status.neq.decided,status.neq.duplicate)")
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true })
        .limit(limit),
      activeRivals(db),
    ]);
    if (error || !data) return null;
    const articles = data as unknown as NewsArticleRecord[];
    const reg = companies.reg;
    const rows = reg ? await articleMentionRows(db, articles, reg) : null;
    return articles.map((a) => describeArticle(a, rows ? (rows.get(a.id) ?? []) : null, reg));
  } catch {
    return null;
  }
}

/** One news_runs row (migration 0020): one step of one run. */
export interface NewsRunRecord {
  run_id: string;
  step: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  counts: unknown;
  error: string | null;
}

/** This morning's run, as Bot Activity sums it up. */
export interface NewsRunToday {
  /** The Dubai day the steps belong to, YYYY-MM-DD. */
  day: string;
  /** Steps logged today: 0 before the day's first run. */
  steps: number;
  /** Every step's counts added together. Not `remaining`, which is a snapshot: getNewsQueue gives it live. */
  counts: StepCounts;
  /** When the latest step finished, or started if it is still working. */
  lastStepAt: string | null;
  /** The problem that still stands today, in plain words, with the bot's own message as the detail. */
  problem: RunProblem | null;
  /** A step is working now. */
  running: boolean;
}

/**
 * A problem with a run. `ai`: Claude can't answer at all (no key, no credit, a
 * refused key), so nothing new counts until it can. `articles`: some articles
 * failed and are tried again later while the run went on. `step`: a step failed.
 */
export interface RunProblem {
  /**
   * preview: a preview's run stopped at Vercel's login between steps
   * (describeProblem). limit: the run reached its most links in one go. Neither
   * is a fault of the bot.
   */
  kind: "ai" | "articles" | "step" | "preview" | "limit";
  text: string;
  detail: string;
}

/** The counts a step adds to the day's: every StepCounts field except `remaining`. */
const ADDED_COUNTS: (keyof StepCounts)[] = [
  "queries",
  "queryFailures",
  "found",
  "fresh",
  "repeats",
  "skipped",
  "requeued",
  "read",
  "unreadable",
  "noNames",
  "duplicates",
  "checked",
  "ours",
  "rivals",
  "rejected",
  "aiFailures",
  "apifyReads",
  "held",
  "published",
];

/**
 * How long a step can stay open and still be working. A step works for up to
 * 200 seconds inside a 300-second function, so one still open after six
 * minutes died without finishing.
 */
const STEP_LIFE_MS = 6 * 60_000;

/** Each step as a person would name it. */
const STEP_NAME: Record<string, string> = {
  search: "search",
  read: "read",
  check: "check",
  seed: "import",
  recheck: "re-check",
  publish: "publish",
};

/**
 * Why the AI gave no answer, in a few plain words, read from the messages of
 * lib/claude.ts and lib/news/classify.ts: "The Claude account is out of credit
 * or at its usage limit (HTTP 400): ..." is "no credit". A message it doesn't
 * know is passed on as it is.
 */
export function aiProblem(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("anthropic_api_key")) return "no key is set";
  if (m.includes("key was refused")) return "the key was refused";
  if (/out of credit|credit balance|spend limit|usage limit|billing/.test(m)) return "no credit";
  if (m.includes("limiting how often")) return "too many requests for now";
  if (m.includes("problem on its side")) return "Claude is having problems on its side";
  if (m.includes("could not be reached")) return "Claude could not be reached";
  return oneLine(message).replace(/\.$/, "");
}

/** How lib/news/run.ts logs articles that failed while the step went on: "2 articles failed, the first: na_1: ...". */
const ARTICLES_FAILED = /^(\d+) (articles?) failed, the first: [^\s:]+: (.*)$/i;

/**
 * How lib/news/run.ts records a run whose next link could not be started, on
 * the last step's row, after any error the row had (lib/news/store.ts
 * noteRunEnding): "the check step could not be started (...), so what is left
 * waits for the next run".
 */
const NOT_STARTED = /(?:^|; )(the \S+ step could not be started\b.*)$/i;

/** How lib/news/run.ts nextMove records a run that reached its most links in one go: "stopped after 40 links with work still waiting, ...". */
const LINK_LIMIT = /(?:^|; )stopped after (\d+) links\b/i;

/**
 * A step's error as Bot Activity says it. A next link that could not be
 * started stopped the run, which is said as such: the step whose row it is on
 * did its own work. Articles that failed one by one are told apart by the way
 * run.ts words them; of the rest, Claude's errors all name Claude or its key,
 * and anything else is the step's own failure.
 */
export function describeProblem(step: string, message: string): RunProblem {
  const detail = oneLine(message).slice(0, 300);
  const stopped = NOT_STARTED.exec(oneLine(message));
  // Vercel's login in front of a preview (lib/news/run.ts VERCEL_LOGIN), or,
  // in a step logged before that was named, the redirect it answers with: the
  // route itself never redirects. A limit of previews, not a fault of the bot.
  if (stopped && /Vercel's login|answered HTTP 30\d\b/i.test(stopped[1])) {
    const next = /^the (\S+) step/i.exec(stopped[1])?.[1] ?? "next";
    return {
      kind: "preview",
      text: `This preview ran one step at a time: Vercel's login stops a preview from starting its next step by itself, so the ${next} step waits for the next run. Live runs on production are not affected`,
      detail,
    };
  }
  if (stopped) {
    return { kind: "step", text: `The run stopped after the ${STEP_NAME[step] ?? step} step: ${stopped[1].replace(/\.$/, "")}`, detail };
  }
  const limit = LINK_LIMIT.exec(oneLine(message));
  // An error the step's row had already is the problem to say; the limit alone is a stop, not a fault.
  if (limit && limit.index > 0) return describeProblem(step, oneLine(message).slice(0, limit.index));
  if (limit) {
    return {
      kind: "limit",
      text: `The run stopped after the ${STEP_NAME[step] ?? step} step: it reached its limit of ${limit[1]} links, and what is left waits for the next run`,
      detail,
    };
  }
  const some = ARTICLES_FAILED.exec(detail);
  if (some) {
    const [, n, articles, first] = some;
    const done = step === "check" ? "checked" : step === "read" ? "read" : "finished";
    return {
      kind: "articles",
      text: `${n} ${articles} could not be ${done} this time and ${n === "1" ? "is" : "are"} tried again later. The first: ${asSentence(first) ?? "no reason given."}`,
      detail,
    };
  }
  if (/claude|anthropic/i.test(detail)) return { kind: "ai", text: `The AI is not answering: ${aiProblem(detail)}`, detail };
  return { kind: "step", text: `The ${STEP_NAME[step] ?? step} step failed: ${detail.replace(/\.$/, "")}`, detail };
}

/**
 * A Dubai day's news_runs rows, summed up. Pure: `now` decides whether a step
 * left open is still working.
 *
 * The problem shown is the newest failure whose step has not finished cleanly
 * since, so a check that found no credit at 08:00 and worked at 11:00 is no
 * longer one. With no failure, a newest step left open past its life is: the
 * run died there, and the next run picks its articles up again.
 *
 * A failure is a step logged with ok false. A step that did nothing on
 * purpose logs its reason in `error` with ok true (runStep), such as a publish
 * while counting is off: that is neither a problem nor a clean finish, so it
 * neither shows in red as a failed step nor hides an older failure.
 */
export function summariseRunDay(day: string, rows: NewsRunRecord[], now = Date.now()): NewsRunToday {
  const counts: StepCounts = {};
  for (const r of rows) {
    const c = asRecord(r.counts);
    for (const key of ADDED_COUNTS) {
      const n = Number(c[key]);
      if (Number.isFinite(n) && n > 0) counts[key] = (counts[key] ?? 0) + n;
    }
  }
  const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);
  const newest = [...rows].sort((a, b) => time(b.started_at) - time(a.started_at));
  const lastAt = (r: NewsRunRecord) => r.finished_at ?? r.started_at;
  const lastStepAt = rows.reduce<string | null>((max, r) => (max === null || time(lastAt(r)) > time(max) ? lastAt(r) : max), null);
  const working = (r: NewsRunRecord) => !r.finished_at && now - time(r.started_at) < STEP_LIFE_MS;

  let problem: NewsRunToday["problem"] = null;
  const cleared = new Set<string>();
  for (const r of newest) {
    if (r.error && r.ok === false && !cleared.has(r.step)) {
      problem = describeProblem(r.step, r.error);
      break;
    }
    if (!r.error && r.finished_at && r.ok !== false) cleared.add(r.step);
  }
  const last = newest[0];
  if (!problem && last && !last.finished_at && !working(last)) {
    problem = {
      kind: "step",
      text: `The last ${STEP_NAME[last.step] ?? last.step} step stopped part way through. The next run picks its articles up again.`,
      detail: `It started at ${last.started_at} and never finished.`,
    };
  }
  return { day, steps: rows.length, counts, lastStepAt, problem, running: rows.some(working) };
}

/**
 * Today's (Dubai) run, summed up. Null when news_runs can't be read; `steps` 0
 * when the bot hasn't run yet today. Only this deployment's steps
 * (lib/news/store.ts runEnvFilter): production and the previews share the
 * table, and a preview's test run is not the live bot's morning.
 */
export async function getNewsRunToday(): Promise<NewsRunToday | null> {
  const db = readClient();
  if (!db) return null;
  const day = dubaiDay();
  try {
    const { data, error } = await db
      .from("news_runs")
      .select("run_id,step,started_at,finished_at,ok,counts,error")
      .eq("run_day", day)
      .or(runEnvFilter(runEnv()))
      .order("started_at", { ascending: false })
      .limit(500);
    if (error || !data) return null;
    return summariseRunDay(day, data as unknown as NewsRunRecord[]);
  } catch {
    return null;
  }
}

/** The statuses an article waits in, claims included. The final ones (decided, no_names, skipped, duplicate) are left out. */
const QUEUE_STATUSES = ["queued", "reading", "read", "checking", "held", "unreadable", "failed"] as const;

/** How many articles wait in each status: what is left for the next run, and what needs a person. */
export type NewsQueue = Record<(typeof QUEUE_STATUSES)[number], number>;

/** The queue right now. Null when it can't be counted, so no figure is shown as zero on a failed read. */
export async function getNewsQueue(): Promise<NewsQueue | null> {
  const db = readClient();
  if (!db) return null;
  try {
    const counted = await Promise.all(
      QUEUE_STATUSES.map((status) =>
        db.from("news_articles").select("id", { count: "exact", head: true }).eq("status", status),
      ),
    );
    if (counted.some((c) => c.error)) return null;
    return Object.fromEntries(QUEUE_STATUSES.map((status, i) => [status, counted[i].count ?? 0])) as NewsQueue;
  } catch {
    return null;
  }
}

/** A spokesperson on the news bot's list (tracked_people). */
export interface TrackedPerson {
  id: number;
  name: string;
  company: string;
  role: string | null;
  /** False: no longer speaks for `company`, and counts for it only when an article names the company too. */
  active: boolean;
  note: string | null;
}

/** The spokespeople list, by company and then name. Null when it can't be read, so the editor doesn't look empty. */
export async function getTrackedPeople(): Promise<TrackedPerson[] | null> {
  const db = readClient();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from("tracked_people")
      .select("id,name,company,role,active,note")
      .order("company", { ascending: true })
      .order("name", { ascending: true });
    if (error || !data) return null;
    return data.map((p) => ({
      id: Number(p.id),
      name: String(p.name),
      company: String(p.company),
      role: (p.role as string | null) ?? null,
      active: p.active !== false,
      note: (p.note as string | null) ?? null,
    }));
  } catch {
    return null;
  }
}

/** The news_articles columns Press mentions reads. */
const PRESS_ARTICLE_FIELDS = "id,status,legacy_mention_id,dup_of,candidates";

/** Press mentions on the PR tab (lib/pressMentions.ts), and why part of it could not be read. */
export interface PressMentionsResult extends PressMentions {
  /**
   * Why the articles or the people could not be read. The stories are then
   * listed without the people they name, which the section says, rather than
   * shown as naming nobody.
   */
  peopleError: string | null;
}

/**
 * What Press mentions reads for the rows the PR tab counts: the rows as the
 * list takes them (ours first, then the rivals'), the articles they name, and
 * the rows to look up as an imported article's old row (legacy_mention_id).
 * Those are the bots' rows behind a row that names no article: the row itself
 * when a bot wrote it, and the bot's rows folded into it (botRowIds), so the
 * PR agency's copy of a story the old bot found is still that story's. A clip
 * only the PR agency's history has was never imported. Pure, so it can be tested.
 */
export function pressLookups(
  ours: Mention[],
  rivals: CompetitorNewsItem[],
): { rows: PressRow[]; named: string[]; imported: string[] } {
  const rows: PressRow[] = [
    ...ours.map((m) => ({
      id: m.id,
      company: US.label,
      isUs: true,
      date: m.date,
      outlet: m.outlet,
      title: m.title,
      url: m.url,
      articleId: m.articleId ?? null,
      legacyIds: [...(m.source === "googlenews" ? [m.id] : []), ...(m.botRowIds ?? [])],
    })),
    ...rivals.map((c) => ({
      id: c.id,
      company: c.brand,
      isUs: false,
      date: c.published_on,
      outlet: c.outlet_name,
      title: c.title,
      url: c.url,
      articleId: c.articleId ?? null,
      legacyIds: [c.id, ...(c.botRowIds ?? [])],
    })),
  ];
  return {
    rows,
    named: [...new Set(rows.flatMap((r) => (r.articleId ? [r.articleId] : [])))],
    imported: [...new Set(rows.filter((r) => !r.articleId).flatMap((r) => r.legacyIds))],
  };
}

/**
 * Every press mention on record, one row per article (buildPressMentions),
 * from exactly the rows the PR tab's figures count: `ours` as getMentions
 * returns them and `rivals` as getCompetitorNews returns them, so the list and
 * the numbers agree.
 *
 * The articles their rows lead to (pressLookups) and the tracked people are
 * read at once, the articles a hundred ids a read. When the articles can't be
 * read, the rows that name the same article still go together, and nobody is
 * named.
 */
export async function getPressMentions(ours: Mention[], rivals: CompetitorNewsItem[]): Promise<PressMentionsResult> {
  const { rows, named, imported } = pressLookups(ours, rivals);
  const listed = (articles: PressArticle[], people: TrackedPerson[] | null, peopleError: string | null): PressMentionsResult => ({
    ...buildPressMentions(rows, articles, people, US.label),
    peopleError,
  });
  if (!named.length && !imported.length) return listed([], null, null);
  const db = readClient();
  if (!db) return listed([], null, "Supabase is not configured");
  try {
    const [reads, people] = await Promise.all([
      Promise.all([
        ...inParts(named).map((part) => db.from("news_articles").select(PRESS_ARTICLE_FIELDS).in("id", part)),
        ...inParts(imported).map((part) => db.from("news_articles").select(PRESS_ARTICLE_FIELDS).in("legacy_mention_id", part)),
      ]),
      getTrackedPeople(),
    ]);
    const failed = reads.find((r) => r.error)?.error;
    if (failed) return listed([], null, `the articles could not be read: ${failed.message}`);
    const articles = reads.flatMap((r) => (r.data ?? []) as unknown as PressArticle[]);
    return people ? listed(articles, people, null) : listed(articles, null, "the tracked people could not be read");
  } catch (e) {
    return listed([], null, errorMessage(e));
  }
}

/** A person on the list whom recent articles describe at another company: the AI's decision.possibleMoves, gathered. */
export interface PossibleMove {
  person: string;
  /** The company as the article gives it, which may not be a tracked one. */
  companyInArticle: string;
  /** The articles that say so, newest first. */
  articles: { id: string; title: string; outlet: string | null; date: string; link: string | null }[];
}

/** The news_articles columns getPossibleMoves reads. */
type PossibleMoveRecord = Pick<ArticleRow, "id" | "title" | "outlet" | "url" | "google_link" | "published_on" | "first_seen_at"> & {
  /** decision.possibleMoves, as stored. */
  moves: unknown;
};

/**
 * The possible moves in these articles, one entry per person and company, the
 * most recently reported first. An article dated before `sinceDay` is left
 * out: an old story read late describes where someone worked then.
 */
export function collectMoves(records: PossibleMoveRecord[], sinceDay: string): PossibleMove[] {
  const byKey = new Map<string, PossibleMove>();
  for (const r of records) {
    const date = r.published_on ?? dayOf(r.first_seen_at);
    if (!date || date < sinceDay) continue;
    for (const move of Array.isArray(r.moves) ? r.moves : []) {
      const person = oneLine(asRecord(move).person);
      const companyInArticle = oneLine(asRecord(move).companyInArticle);
      if (!person || !companyInArticle) continue;
      const key = `${person.toLowerCase()}|${companyInArticle.toLowerCase()}`;
      const entry = byKey.get(key) ?? { person, companyInArticle, articles: [] };
      if (!entry.articles.some((x) => x.id === r.id)) {
        entry.articles.push({ id: r.id, title: r.title, outlet: r.outlet, date, link: r.url || r.google_link || null });
      }
      byKey.set(key, entry);
    }
  }
  const moves = [...byKey.values()];
  for (const m of moves) m.articles.sort((a, b) => b.date.localeCompare(a.date));
  return moves.sort((a, b) => b.articles[0].date.localeCompare(a.articles[0].date));
}

/**
 * Possible moves from the articles the AI sorted in the last `days` days.
 * Null when they can't be read.
 */
export async function getPossibleMoves(days = 60): Promise<PossibleMove[] | null> {
  const db = readClient();
  if (!db) return null;
  const since = new Date(Date.now() - days * 86_400_000);
  try {
    const { rows, error } = await readAllRows((from, to) =>
      db
        .from("news_articles")
        .select("id,title,outlet,url,google_link,published_on,first_seen_at,moves:decision->possibleMoves")
        .in("status", ["decided", "held"])
        .gte("first_seen_at", since.toISOString())
        .order("first_seen_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (error) return null;
    return collectMoves(rows as unknown as PossibleMoveRecord[], dubaiDay(since));
  } catch {
    return null;
  }
}

// ── A person's Keep and Reject: the rows app/actions.ts writes ───

/**
 * The decision a person's Keep writes for betterhomes: one mention, so our
 * row has the shape of one the AI proved (lib/news/write.ts, mentionRowsFor).
 *
 * Its proof is the best the article has. First the AI's own sentence for us,
 * with how the AI said we are mentioned: there is one when a person keeps an
 * article they rejected before. Then the first sentence the name spotter
 * found naming us or one of our current people. Then the headline, as
 * sentence 0. Only the AI judges how we are mentioned, so the last two are
 * "passing".
 */
export function keepDecision(
  article: Pick<ArticleRow, "title" | "candidates" | "decision">,
  reg: Pick<Registry, "us" | "people">,
  checkedAt: string,
): Decision {
  const us = reg.us.label;
  const ourPeople = new Set(reg.people.filter((p) => p.active && p.company === us).map((p) => p.name));
  const decided = article.decision && Array.isArray(article.decision.mentions) ? article.decision.mentions : [];
  const fromAi = decided.find((m) => m?.company === us && typeof m.quote === "string" && m.quote.trim());
  const candidate = (Array.isArray(article.candidates) ? article.candidates : []).find(
    (c) => c?.companies?.includes(us) || c?.people?.some((name) => ourPeople.has(name)),
  );
  const mention: DecidedMention = fromAi
    ? { company: us, sentence: fromAi.sentence, quote: fromAi.quote, role: fromAi.role, sentiment: fromAi.sentiment ?? null }
    : candidate
      ? { company: us, sentence: candidate.n, quote: candidate.text, role: "passing", sentiment: null }
      : { company: us, sentence: 0, quote: article.title, role: "passing", sentiment: null };
  return { mentions: [mention], irrelevantReason: null, possibleMoves: [], dropped: [], model: PERSON_CHECK, checkedAt };
}

/** A metadata.factCheck that proves its row: the news check's ("pass"), or the old fact check's, which had a role and no result. */
function proves(check: unknown): boolean {
  const c = asRecord(check);
  return c.result === "pass" || (c.result === undefined && !!c.role);
}

/** Our row for an article a person kept, new to the table: the bot's shape, reviewed, with their verdict. */
export function keptRow(made: MentionRow): Record<string, unknown> {
  return { ...made, status: "reviewed", metadata: { ...made.metadata, personVerdict: "kept" } };
}

/**
 * What a person's Keep changes on our row when it is already stored. It
 * counts, reviewed, with their verdict, whatever was decided before. The rest
 * of the row stays as it is, its own proof included when it has one, since a
 * sentence a check found says more than a headline; only the reason it was
 * rejected goes.
 */
export function keptPatch(
  existing: { metadata: unknown },
  made: MentionRow,
  articleId: string,
): { status: "reviewed"; metadata: Record<string, unknown> } {
  const stored = { ...asRecord(existing.metadata) };
  delete stored.reason;
  return {
    status: "reviewed",
    metadata: {
      ...made.metadata,
      ...stored,
      articleId,
      factCheck: proves(stored.factCheck) ? stored.factCheck : made.metadata.factCheck,
      personVerdict: "kept",
    },
  };
}

/** What a person's Reject changes on a row of the article: it stops counting, with their verdict, which no later check overrides. */
export function rejectedPatch(existing: { metadata: unknown }, articleId: string): { status: "rejected"; metadata: Record<string, unknown> } {
  return { status: "rejected", metadata: { ...asRecord(existing.metadata), articleId, personVerdict: "rejected" } };
}

/**
 * A person to add to the spokespeople list, checked: a name of 2 to 80
 * characters, one of `companies` exactly as listed, and a role of up to 120
 * characters, which may be left out.
 */
export function checkPersonInput(
  input: unknown,
  companies: string[],
): { ok: true; person: { name: string; company: string; role: string | null } } | { ok: false; error: string } {
  const raw = asRecord(input);
  const name = oneLine(raw.name);
  const company = oneLine(raw.company);
  const role = oneLine(raw.role);
  if (name.length < 2 || name.length > 80) return { ok: false, error: "Give the person's name, 2 to 80 characters." };
  if (!companies.some((c) => oneLine(c) === company)) {
    return { ok: false, error: "Choose betterhomes or one of the tracked rivals as their company." };
  }
  if (role.length > 120) return { ok: false, error: "Keep the role to 120 characters or fewer." };
  return { ok: true, person: { name, company, role: role || null } };
}
