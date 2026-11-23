// The SEO tab: the Organic Growth Report. SEO and AI search month by month,
// for a period of whole months (lib/growthPeriod.ts, by default the last 3) set
// against the same number of months just before, with at least a year of trend.
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
import { getGscMetrics, getSearchMonthly, type SearchMonth } from "@/lib/gsc";
import { FIRST_MONTH, addMonths, gscMonth, latestMonth, monthBounds, resolvePeriod, type GrowthPeriod, type PeriodQuery } from "@/lib/growthPeriod";
import { getGrowthCrm, type GrowthCrmMonth, type ServiceLine } from "@/lib/metabase";
import { getGrowthTraffic, type GrowthMonth } from "@/lib/posthog";

/** Top searches the keyword chart follows. */
const TOP_SEARCHES = 12;
/** Search Console keeps 16 months: whole months are those from 15 before this one. */
const GSC_KEEPS_MONTHS = 16;
/** The Engage cutover (lib/metabase.ts): the CRM's lead records begin here. */
const CRM_FIRST_MONTH = "2024-12";

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
  /** Average position in the period, and in the months before it (null where it did not appear). */
  position: number | null;
  before: number | null;
}

export interface GrowthReport {
  /** When this answer was worked out (lib/cache.ts). */
  cachedAt?: string | null;
  /** The period, its comparison and the charts' months (lib/growthPeriod.ts). */
  period: GrowthPeriod;
  /** Every month below is one of these, oldest first: period.months. */
  months: string[];
  /** Visitors, one per month; every figure null for a month PostHog did not record or did not answer for. */
  traffic: GrowthMonth[];
  /** The names each assistant arrived under, most used first. */
  assistantNames: Record<string, string[]>;
  /** Google search, one per month; null where Search Console did not answer or keeps nothing (16 months back). */
  search: (SearchMonth | null)[];
  searchSource: "direct" | "supermetrics";
  /** The period's top searches by clicks, brand searches left out, with their positions then and before. */
  keywords: KeywordMove[];
  /** How many sites the press bot has found covering betterhomes: where news visitors are counted from. */
  newsSites: number | null;
  sources: SourceStatus[];
  generatedAt: string;
}

const blankMonth = (month: string): GrowthMonth => ({
  month, seo: null, ai: null, offPlan: null, propertyManagement: null, byAssistant: null, aiLanding: null, news: null, newsPeople: null,
});

/** The visitors and searches half for a period, remembered (lib/cache.ts) and kept only when every source answered in full. */
export async function getGrowthReport(q: PeriodQuery = {}, opts: RememberOptions = {}): Promise<GrowthReport> {
  const period = resolvePeriod(q, latestMonth());
  const answer = await remembered(
    // Keyed on the months themselves: "last 3 months" and the same months picked by hand are one answer.
    // "links": news visitors count link and news-portal visits only; answers kept before counted social posts too.
    cacheKey("seoGrowth", { from: period.from, to: period.to, news: "links" }),
    () => computeGrowthReport(period),
    (d) => d.sources.every((s) => s.state === "ok"),
    opts,
  );
  // The period as asked for now, never the one an answer was kept under: the same months kept for
  // "Year to date" came back labelled so when picked by hand, and the picker snapped back to it.
  return { ...answer, period };
}

async function computeGrowthReport(period: GrowthPeriod): Promise<GrowthReport> {
  const months = period.months;
  const windows = months.map(monthBounds);
  const tracked = months.filter((m) => m >= FIRST_MONTH);
  const gscFirst = addMonths(gscMonth(), -(GSC_KEEPS_MONTHS - 1));
  const sitesAsk = getCoverageSites();

  const [sites, traffic, search, kw] = await Promise.all([
    sitesAsk,
    sitesAsk.then((s) => getGrowthTraffic(tracked, s ?? [])),
    getSearchMonthly(windows),
    // The period's top searches, then the same searches in the months before it, where Search Console still keeps them.
    (async () => {
      const now = await getGscMetrics(monthBounds(period.from).from, monthBounds(period.to).to, [], { top: TOP_SEARCHES });
      const before = now.keywords.length && period.compareFrom >= gscFirst
        ? await getGscMetrics(monthBounds(period.compareFrom).from, monthBounds(period.compareTo).to, now.keywords.map((k) => k.keyword))
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
  const missing = trafficRows.filter((t) => t.month >= FIRST_MONTH && (t.seo == null || t.byAssistant == null));
  sources.push(
    !traffic.connected
      ? { name: "PostHog", state: "off", detail: "no API key configured" }
      : missing.length === tracked.length
        ? { name: "PostHog", state: "down", detail: "did not answer for any month; visitor figures are blank, not zero" }
        : missing.length
          ? { name: "PostHog", state: "partial", detail: `did not answer for ${missing.map((t) => t.month).join(", ")}; reload to try again` }
          : { name: "PostHog", state: "ok", detail: "answered" },
  );
  // Months Search Console no longer keeps read as unknown, not as a month of no searches.
  const searchRows = search.months.map((m, i) => (months[i] < gscFirst ? null : m));
  const searchGap = searchRows.filter((m, i) => m == null && months[i] >= gscFirst).length;
  const searchName = search.source === "direct" ? "Search Console" : "Search Console · Supermetrics";
  sources.push(
    !search.connected
      ? { name: searchName, state: "off", detail: search.error ?? "not connected" }
      : searchGap && searchGap === months.filter((m) => m >= gscFirst).length
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
  if (sites && traffic.connected && trafficRows.some((t) => t.month >= FIRST_MONTH && t.seo != null && t.news == null)) {
    sources.push({ name: "PostHog · news sites", state: "partial", detail: "did not answer for every month; news-site visitors are blank, not zero" });
  }

  return {
    period,
    months,
    traffic: trafficRows,
    assistantNames: traffic.assistantNames,
    search: searchRows,
    searchSource: search.source,
    keywords,
    newsSites: sites?.length ?? null,
    sources,
    generatedAt: new Date().toISOString(),
  };
}

export interface GrowthCrmReport {
  cachedAt?: string | null;
  /** The same months as the visitors half: period.months. */
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

/** The CRM half for a period: leads by service line and what they led to, remembered and kept only when the CRM answered. */
export async function getGrowthCrmReport(q: PeriodQuery = {}, opts: RememberOptions = {}): Promise<GrowthCrmReport> {
  const { months } = resolvePeriod(q, latestMonth());
  return remembered(
    cacheKey("seoGrowthCrm", { first: months[0], last: months[months.length - 1] }),
    async () => {
      // Never asked before the Engage cutover: those months read as unknown.
      const asked = months.filter((m) => m >= CRM_FIRST_MONTH);
      const crm = asked.length ? await getGrowthCrm(monthBounds(asked[0]).from, monthBounds(asked[asked.length - 1]).to) : { connected: true, months: [] };
      const byMonth = new Map(crm.months.map((m) => [m.month, m]));
      const ok = crm.connected && !("error" in crm && crm.error);
      return {
        months,
        crm: months.map((m) => (ok && m >= CRM_FIRST_MONTH ? (byMonth.get(m) ?? zeroMonth(m)) : null)),
        connected: crm.connected,
        error: "error" in crm ? crm.error : undefined,
        generatedAt: new Date().toISOString(),
      };
    },
    (d) => d.connected && !d.error,
    opts,
  );
}
