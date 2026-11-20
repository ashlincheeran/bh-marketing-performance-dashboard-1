// The SEO tab: the Organic Growth Report. SEO and AI search month by month for
// a year, with the last three months set against the three before.
//
// Everything is live: PostHog for visitors, Google Search Console for
// searches, the CRM (Metabase) for leads and what they led to, and the press
// bot's coverage for which news sites count. Only whole months are shown, and
// a month joins once Search Console has published all of it, so no source is
// ever compared on part of a month.
//
// Two halves, split by speed as the tab always was: visitors and searches load
// with the page; the CRM half is asked for once the page is open, so a slow
// CRM never holds up the rest.
import { cacheKey, remembered, type RememberOptions } from "@/lib/cache";
import { getCoverageSites } from "@/lib/data";
import { daysInMonth, todayIn } from "@/lib/dateRanges";
import { getGscMetrics, getSearchMonthly, type SearchMonth } from "@/lib/gsc";
import { getGrowthCrm, type GrowthCrmMonth, type ServiceLine } from "@/lib/metabase";
import { getGrowthTraffic, type GrowthMonth } from "@/lib/posthog";

/** Months the report covers. */
export const REPORT_MONTHS = 12;
/** Top searches the keyword chart follows. */
const TOP_SEARCHES = 12;
/** Search Console publishes each Pacific-time day about three days late. */
const GSC_TZ = "America/Los_Angeles";
const GSC_LAG_DAYS = 3;
/** PostHog began recording bhomes.com on 10 Oct 2025, so November 2025 is its first whole month. */
export const POSTHOG_FIRST_MONTH = "2025-11";

const pad = (n: number) => String(n).padStart(2, "0");

/** The YYYY-MM `k` months after `m`, or before it when `k` is negative. */
export function addMonths(m: string, k: number): string {
  const i = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + k;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}

/** A month's first and last day. */
export const monthBounds = (m: string) => ({ month: m, from: `${m}-01`, to: `${m}-${pad(daysInMonth(m))}` });

/**
 * The report's months, oldest first: the latest month Search Console has
 * published in full, and the eleven before it. On 2 November, October's
 * last days are not yet published there, so the report still ends in
 * September; on 3 November it moves on.
 */
export function reportMonths(now = new Date()): string[] {
  const t = todayIn(GSC_TZ, now);
  const published = new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate() - GSC_LAG_DAYS));
  const month = `${published.getUTCFullYear()}-${pad(published.getUTCMonth() + 1)}`;
  const last = published.getUTCDate() === daysInMonth(month) ? month : addMonths(month, -1);
  return Array.from({ length: REPORT_MONTHS }, (_, i) => addMonths(last, i - (REPORT_MONTHS - 1)));
}

/** One source's condition, shown on the tab: a zero from a dead source reads exactly like a quiet month. */
export interface SourceStatus {
  name: string;
  state: "ok" | "partial" | "down" | "off";
  detail: string;
}

export interface KeywordMove {
  keyword: string;
  clicks: number;
  impressions: number;
  /** Average position in the quarter, and in the three months before (null where it did not appear). */
  position: number | null;
  before: number | null;
}

export interface GrowthReport {
  /** When this answer was worked out (lib/cache.ts). */
  cachedAt?: string | null;
  /** Twelve months, oldest first: the last three are the quarter, the three before it its comparison. */
  months: string[];
  /** Visitors, one per month; every figure null for a month PostHog did not record or did not answer for. */
  traffic: GrowthMonth[];
  /** The names each assistant arrived under, most used first. */
  assistantNames: Record<string, string[]>;
  /** Google search, one per month; null where Search Console did not answer. */
  search: (SearchMonth | null)[];
  searchSource: "direct" | "supermetrics";
  /** The quarter's top searches by clicks, brand searches left out, with their positions then and before. */
  keywords: KeywordMove[];
  /** How many sites the press bot has found covering betterhomes: where news visitors are counted from. */
  newsSites: number | null;
  sources: SourceStatus[];
  generatedAt: string;
}

const blankMonth = (month: string): GrowthMonth => ({
  month, seo: null, ai: null, offPlan: null, propertyManagement: null, byAssistant: null, aiLanding: null, news: null, newsPeople: null,
});

/** The visitors and searches half, remembered (lib/cache.ts) and kept only when every source answered in full. */
export async function getGrowthReport(opts: RememberOptions = {}): Promise<GrowthReport> {
  const months = reportMonths();
  return remembered(
    cacheKey("seoGrowth", { end: months[months.length - 1] }),
    () => computeGrowthReport(months),
    (d) => d.sources.every((s) => s.state === "ok"),
    opts,
  );
}

async function computeGrowthReport(months: string[]): Promise<GrowthReport> {
  const windows = months.map(monthBounds);
  const quarter = windows.slice(-3), previous = windows.slice(-6, -3);
  const tracked = months.filter((m) => m >= POSTHOG_FIRST_MONTH);
  const sitesAsk = getCoverageSites();

  const [sites, traffic, search, kw] = await Promise.all([
    sitesAsk,
    sitesAsk.then((s) => getGrowthTraffic(tracked, s ?? [])),
    getSearchMonthly(windows),
    // The quarter's top searches, then the same searches in the three months before.
    (async () => {
      const now = await getGscMetrics(quarter[0].from, quarter[2].to, [], { top: TOP_SEARCHES });
      const before = now.keywords.length
        ? await getGscMetrics(previous[0].from, previous[2].to, now.keywords.map((k) => k.keyword))
        : null;
      return { now, before };
    })(),
  ]);

  const byMonth = new Map(traffic.months.map((t) => [t.month, t]));
  const trafficRows = months.map((m) => byMonth.get(m) ?? blankMonth(m));
  const before = new Map((kw.before?.keywords ?? []).map((k) => [k.keyword, k.position]));
  const keywords: KeywordMove[] = kw.now.keywords.map((k) => ({
    keyword: k.keyword,
    clicks: k.clicks,
    impressions: k.impressions,
    position: k.position,
    before: before.get(k.keyword) ?? null,
  }));

  const sources: SourceStatus[] = [];
  const missing = trafficRows.filter((t) => t.month >= POSTHOG_FIRST_MONTH && (t.seo == null || t.byAssistant == null));
  sources.push(
    !traffic.connected
      ? { name: "PostHog", state: "off", detail: "no API key configured" }
      : missing.length === tracked.length
        ? { name: "PostHog", state: "down", detail: "did not answer for any month; visitor figures are blank, not zero" }
        : missing.length
          ? { name: "PostHog", state: "partial", detail: `did not answer for ${missing.map((t) => t.month).join(", ")}; reload to try again` }
          : { name: "PostHog", state: "ok", detail: "answered" },
  );
  const searchGap = search.months.filter((m) => m == null).length;
  const searchName = search.source === "direct" ? "Search Console" : "Search Console · Supermetrics";
  sources.push(
    !search.connected
      ? { name: searchName, state: "off", detail: search.error ?? "not connected" }
      : searchGap === months.length
        ? { name: searchName, state: "down", detail: search.error ?? "did not answer" }
        : searchGap || search.error || kw.now.error
          ? { name: searchName, state: "partial", detail: search.error ?? kw.now.error ?? "did not answer for every month" }
          : { name: searchName, state: "ok", detail: "answered" },
  );
  sources.push(
    sites == null
      ? { name: "Press coverage", state: "partial", detail: "the press bot's coverage could not be read, so news-site visitors are not shown" }
      : { name: "Press coverage", state: "ok", detail: `${sites.length} sites` },
  );
  // The news part of a month can fail on its own; the rest of PostHog's answer stands.
  if (sites && traffic.connected && trafficRows.some((t) => t.month >= POSTHOG_FIRST_MONTH && t.seo != null && t.news == null)) {
    sources.push({ name: "PostHog · news sites", state: "partial", detail: "did not answer for every month; news-site visitors are blank, not zero" });
  }

  return {
    months,
    traffic: trafficRows,
    assistantNames: traffic.assistantNames,
    search: search.months,
    searchSource: search.source,
    keywords,
    newsSites: sites?.length ?? null,
    sources,
    generatedAt: new Date().toISOString(),
  };
}

export interface GrowthCrmReport {
  cachedAt?: string | null;
  /** The same twelve months as the visitors half. */
  months: string[];
  /** One per month: zeros for a month with nothing, null when the CRM did not answer. */
  crm: (GrowthCrmMonth | null)[];
  connected: boolean;
  error?: string;
  generatedAt: string;
}

const zeroLines = (): Record<ServiceLine | "total", number> => ({ sale: 0, rent: 0, offplan: 0, pm: 0, other: 0, total: 0 });
const zeroMonth = (month: string): GrowthCrmMonth => ({
  month, leads: zeroLines(), aiLeads: zeroLines(),
  listed: { sale: 0, rent: 0 }, reserved: { sale: 0, rent: 0 }, completed: { sale: 0, rent: 0 },
  commission: { completedSale: 0, completedRent: 0, awaiting: 0 },
});

/** The CRM half: leads by service line and what they led to, remembered and kept only when the CRM answered. */
export async function getGrowthCrmReport(opts: RememberOptions = {}): Promise<GrowthCrmReport> {
  const months = reportMonths();
  return remembered(
    cacheKey("seoGrowthCrm", { end: months[months.length - 1] }),
    async () => {
      const first = monthBounds(months[0]).from, last = monthBounds(months[months.length - 1]).to;
      const crm = await getGrowthCrm(first, last);
      const byMonth = new Map(crm.months.map((m) => [m.month, m]));
      const ok = crm.connected && !crm.error;
      return {
        months,
        crm: months.map((m) => (ok ? (byMonth.get(m) ?? zeroMonth(m)) : null)),
        connected: crm.connected,
        error: crm.error,
        generatedAt: new Date().toISOString(),
      };
    },
    (d) => d.connected && !d.error,
    opts,
  );
}
