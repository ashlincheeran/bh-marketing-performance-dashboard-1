// SEO & AI Channel report — the aggregator behind the SEO tab.
//
// The tab used to show a handful of traffic and keyword cards. This assembles
// the full report: the AI channel funnel measured in people, assistant by
// assistant, the month-by-month trend of organic falling while AI climbs, what
// AI visitors actually do on the site, and the lead and pipeline picture behind
// it.
//
// SHAPE OF THE PAGE. Almost everything is live — PostHog for traffic and
// behaviour, Metabase for leads and deals, Google Search Console for rankings.
// Two sections cannot be: Semrush AI Visibility has no report in the Semrush
// connector this app holds, and ClickUp has no connector at all. Those are
// stored and editable rather than hardcoded, and carry an `asOf` stamp so a
// stale figure cannot pass as a live one (see lib/seoManual.ts).
//
// SPLIT BY SPEED, not by topic. PostHog and GSC are quick and load with the
// page; the Metabase `leads` view has no indexes and is re-derived per query,
// so it is fetched separately by the client. That separation already exists on
// this tab and is why a slow CRM query cannot stall the traffic figures.
import { getAiChannel, getAiMonthly, type AiChannel, type AiMonthRow } from "@/lib/posthog";
import { getGscMetrics, type GscData } from "@/lib/gsc";
import { getChannelDeals, getLeadsData, getLeadsMonthly, type LeadsData, type LeadsMonthly } from "@/lib/metabase";
import { getSeoConfig } from "@/lib/data";
import { getSeoManual, type SeoManual } from "@/lib/seoManual";
import { isPresetKey, rangeFor, todayIn, type RangeKey } from "@/lib/dateRanges";

// ── date ranges ────────────────────────────────────────────────────────────
//
// Plain YYYY-MM-DD strings throughout, with arithmetic done in UTC so that no
// server offset can move a date by a day.

/** Whose calendar "today" is. The server runs in UTC; the business does not. */
const TZ = "Asia/Dubai";
/** Longest range served. Two years keeps the PostHog scans inside their time limit. */
const MAX_DAYS = 731;
/** Most months the month-by-month tables reach back. */
const MAX_TREND_MONTHS = 24;

// Where each source's records begin. A comparison period that starts earlier
// is not compared at all: set against a period the source half-holds, growth
// reads in the thousands of percent.
/** PostHog began recording bhomes.com on 10 Oct 2025; January to September 2025 holds 108 stray pageviews. */
const POSTHOG_SINCE = "2025-10-10";
/**
 * The Engage cutover (ENGAGE_START in lib/metabase). LEAD_SCOPE leaves GoYzer
 * out, so 2024 holds 319 AI and organic leads, all from Nov–Dec, against
 * 11,983 before scoping; deals before it cannot be credited at all.
 */
const CRM_SINCE = "2024-12-01";
/** Search Console reports Pacific-time days, publishes them about three days late, and keeps 16 months. */
const GSC_TZ = "America/Los_Angeles";
const GSC_LAG_DAYS = 3;
const GSC_KEEPS_MONTHS = 16;

const pad = (n: number) => String(n).padStart(2, "0");
const isMonth = (s?: string | null): s is string => !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const isDate = (s?: string | null): s is string =>
  !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

const utc = (s: string) => new Date(`${s}T00:00:00Z`);
/** A local-midnight Date, as todayIn returns one, as YYYY-MM-DD. */
const ymdOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s: string, n: number) => {
  const d = utc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((utc(b).getTime() - utc(a).getTime()) / 86_400_000);
const monthEnd = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const monthIndex = (s: string) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1;
/** Starts on a 1st and ends on a month's last day: one or more whole calendar months. */
const wholeMonths = (from: string, to: string) =>
  from.endsWith("-01") && Number(to.slice(8)) === monthEnd(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1);

/** The same calendar day k months earlier, clamped to that month's length (31 Mar → 28 Feb). */
function monthsBack(s: string, k: number): string {
  const first = new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1 - k, 1));
  const y = first.getUTCFullYear(), m0 = first.getUTCMonth();
  return `${y}-${pad(m0 + 1)}-${pad(Math.min(Number(s.slice(8)), monthEnd(y, m0)))}`;
}

/** First and last day of a YYYY-MM. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  return { from: `${month}-01`, to: `${month}-${pad(monthEnd(y, m - 1))}` };
}

/** What the page asks for: a preset by name, two dates, or — from older links — a month. */
export interface RangeQuery {
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  month?: string | null;
}

/** The range on screen and the one it is compared with, both inclusive. */
export interface SeoRange {
  preset: RangeKey;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
}

/**
 * A request's range, resolved.
 *
 * Presets are resolved HERE, on Dubai's calendar, rather than in the browser:
 * the server then renders exactly the range it fetched, and a bookmarked
 * "last 30 days" stays rolling instead of freezing on the day it was saved.
 * Custom ranges longer than two years keep their end and lose their start.
 */
export function resolveSeoRange(q: RangeQuery): SeoRange {
  let preset: RangeKey = "custom";
  let from: string, to: string;
  if (isPresetKey(q.preset)) {
    preset = q.preset;
    ({ from, to } = rangeFor(q.preset, todayIn(TZ)));
  } else if (isDate(q.from) && isDate(q.to)) {
    [from, to] = q.from <= q.to ? [q.from, q.to] : [q.to, q.from];
    if (daysBetween(from, to) >= MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1));
  } else if (isMonth(q.month)) {
    ({ from, to } = monthRange(q.month));
  } else {
    preset = "this_month";
    ({ from, to } = rangeFor(preset, todayIn(TZ)));
  }
  const prev = compareRange(from, to, preset);
  return { preset, from, to, prevFrom: prev.from, prevTo: prev.to };
}

/**
 * The period a range is set against — the one a reader expects.
 *
 * Whole calendar months against the months before: August against July, a
 * quarter against the quarter before, a year against the year before. The
 * to-date presets against the same days of the period before: 1–25 September
 * against 1–25 August, this year so far against the same days last year, this
 * week so far against the same weekdays last week. Anything else against the
 * same number of days immediately before.
 *
 * The to-date presets are tested first. On a month's last day they are also
 * whole months, which used to win: "this year" on 31 October was set against
 * March–December 2025 rather than January–October, and "this quarter" on 30
 * November against August–September rather than 1 July–30 August. "This
 * month" keeps to the same days too: 1–30 November against 1–30 October.
 */
export function compareRange(from: string, to: string, preset: RangeKey = "custom"): { from: string; to: string } {
  const back = preset === "this_month" ? 1 : preset === "this_quarter" ? 3 : preset === "this_year" ? 12 : 0;
  if (back) return { from: monthsBack(from, back), to: monthsBack(to, back) };
  if (wholeMonths(from, to)) {
    const n = monthIndex(to) - monthIndex(from) + 1;
    return { from: monthsBack(from, n), to: addDays(from, -1) };
  }
  if (preset === "this_week") return { from: addDays(from, -7), to: addDays(to, -7) };
  const n = daysBetween(from, to) + 1;
  return { from: addDays(from, -n), to: addDays(from, -1) };
}

/**
 * The month-by-month tables' window: from January of the range's final year —
 * the report's year-to-date view — or from the range's own first month when
 * that is earlier, so a range spanning New Year shows all of itself. Capped at
 * two years, and ending where the range ends.
 */
export function trendRange(from: string, to: string): { from: string; to: string } {
  const yearStart = `${to.slice(0, 4)}-01-01`;
  const rangeStart = `${from.slice(0, 7)}-01`;
  const cap = monthsBack(`${to.slice(0, 7)}-01`, MAX_TREND_MONTHS - 1);
  const start = rangeStart < yearStart ? rangeStart : yearStart;
  return { from: start < cap ? cap : start, to };
}

/** A range and the period it is compared with, both inclusive. */
export interface RangePair {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
}

/** Today on Search Console's calendar. */
const gscToday = (now = new Date()) => ymdOf(todayIn(GSC_TZ, now));

/**
 * The part of a range Search Console has published, and its comparison.
 *
 * Search Console publishes each Pacific-time day about three days late, so a
 * range running to today asks for days it does not have yet while its
 * comparison is complete: on 20 Oct 2026 "this month" set about 17 days of
 * October against all of 1–20 September, a fall of some 15% that never
 * happened. The range is cut at the last published day and the comparison to
 * the same number of days from its own start. With nothing published yet
 * both come back empty, `to` before `from`, and Search Console is not asked.
 */
export function searchConsoleRange(r: RangePair, now = new Date()): RangePair {
  const published = addDays(gscToday(now), -GSC_LAG_DAYS);
  if (r.to <= published) return { from: r.from, to: r.to, prevFrom: r.prevFrom, prevTo: r.prevTo };
  const prevTo = addDays(r.prevFrom, daysBetween(r.from, published));
  return { from: r.from, to: published, prevFrom: r.prevFrom, prevTo: prevTo < r.prevTo ? prevTo : r.prevTo };
}

export interface MonthPoint {
  month: string;
  organicVisitors: number;
  organicPageviews: number;
  allPageviews: number;
  aiVisitors: number;
  /** AI visitors as a fraction of organic visitors, 0..1. */
  aiShareOfOrganic: number;
  byAssistant: Record<string, number>;
  aiLeads: number;
  /** The month's AI leads by raw CRM source, for each assistant's year so far. */
  aiLeadsBySource: { source: string; n: number }[];
  organicLeads: number;
  deals: number;
}

/**
 * Per-source health, surfaced on the page.
 *
 * Three services sit behind one screen, and a zero from a dead source looks
 * exactly like a zero from a quiet month. That ambiguity is what let the press
 * bot report "no coverage" for a quarter while it was really reading nothing,
 * so each source states its own condition rather than dissolving into the
 * numbers.
 */
export interface SourceStatus {
  name: string;
  /** ok = answered with data · partial = some parts did not load · empty = answered with nothing · down = did not answer. */
  state: "ok" | "partial" | "empty" | "down" | "off";
  detail: string;
}

export interface SeoReport {
  range: SeoRange;
  /** The range and its comparison period, so every card can show its own delta. */
  ai: AiChannel;
  aiPrev: AiChannel;
  gsc: GscData;
  gscPrev: GscData;
  /** The days gsc and gscPrev cover: the range cut to what Search Console has published (searchConsoleRange). */
  gscRange: RangePair;
  /**
   * Whether each source's comparison period can be compared with at all. False
   * when it starts before the source's records do, so the page shows no change
   * rather than growth against nothing.
   */
  comparable: { posthog: boolean; gsc: boolean; crm: boolean };
  /** Month by month over trendRange — January of the range's year to its end. */
  months: MonthPoint[];
  /** PostHog did not answer for the month-by-month series: the tables say so rather than read as empty. */
  monthsMissing: boolean;
  sources: SourceStatus[];
  manual: SeoManual;
  keywords: string[];
  generatedAt: string;
}

/** Fast half — PostHog + GSC + the stored manual figures. Loads with the page. */
export async function getSeoReport(q: RangeQuery = {}): Promise<SeoReport> {
  const range = resolveSeoRange(q);
  const trend = trendRange(range.from, range.to);
  const gscRange = searchConsoleRange(range);
  const gscNone = gscRange.to < gscRange.from;
  const cfg = await getSeoConfig();

  const [ai, aiPrev, gsc, gscPrev, monthly, leadsMonthly, manual] = await Promise.all([
    getAiChannel(range.from, range.to),
    // Not asked at all when it starts before PostHog's records: those figures are never shown.
    getAiChannel(range.prevFrom, range.prevTo, { detail: false, skip: range.prevFrom < POSTHOG_SINCE }),
    getGscMetrics(gscRange.from, gscRange.to, cfg.keywords),
    getGscMetrics(gscRange.prevFrom, gscRange.prevTo, cfg.keywords),
    getAiMonthly(trend.from, trend.to),
    getLeadsMonthly(trend.from, trend.to),
    getSeoManual(),
  ]);

  // Compared only from the day each source's records begin. This replaces a
  // rule that took a comparison under 5% of the range's daily volume to predate
  // the records: it caught January–September 2025 (108 pageviews against
  // 710,000), but not a period that is mostly untracked. "This year" now starts
  // its comparison on 1 Jan 2025 with PostHog recording from 10 Oct, and the
  // rule would pass once those days held 5% of 2026's pageviews, about 25 Oct
  // at January's traffic: a 2025 95% unrecorded, read as growth of 1,000%+.
  const gscKeptFrom = monthsBack(gscToday(), GSC_KEEPS_MONTHS);
  const comparable = {
    posthog: !aiPrev.error && range.prevFrom >= POSTHOG_SINCE,
    gsc: !gscPrev.error && !gscNone && gscRange.prevFrom >= gscKeptFrom,
    crm: range.prevFrom >= CRM_SINCE,
  };

  return {
    range,
    comparable,
    ai,
    aiPrev,
    gsc,
    gscPrev,
    gscRange,
    months: mergeMonths(monthly ?? [], leadsMonthly),
    monthsMissing: !monthly,
    sources: [
      status("PostHog", ai.connected, !!ai.error, ai.visitors + ai.allPageviews, ai.error, [
        ...ai.missing,
        ...(aiPrev.error ? ["the comparison period"] : aiPrev.missing.map((m) => `${m} (comparison)`)),
        ...(monthly ? [] : ["month by month"]),
      ]),
      gscNone && gsc.connected && !gsc.error
        ? {
            name: gsc.source === "direct" ? "Search Console · direct" : "Search Console · Supermetrics",
            state: "empty" as const,
            detail: `publishes Pacific-time days about ${GSC_LAG_DAYS} days late, so nothing for ${range.from} → ${range.to} yet`,
          }
        : status(
            gsc.source === "direct" ? "Search Console · direct" : "Search Console · Supermetrics",
            gsc.connected,
            !!gsc.error,
            gsc.totals?.impressions ?? 0,
            gsc.error,
          ),
      status(
        "Metabase",
        leadsMonthly.connected,
        !!leadsMonthly.error,
        leadsMonthly.rows.reduce((n, r) => n + r.aiLeads + r.organicLeads, 0),
        leadsMonthly.error,
      ),
      // Said once here, rather than left as a column of "new" or +320,000%.
      ...(ai.connected && !aiPrev.error && !comparable.posthog
        ? [{
            name: "PostHog · comparison period",
            state: "empty" as const,
            detail: `PostHog began recording the site on ${POSTHOG_SINCE}, after ${range.prevFrom} → ${range.prevTo} begins, so traffic changes against it are not shown`,
          }]
        : []),
      ...(gscPrev.connected && !gscPrev.error && !gscNone && !comparable.gsc
        ? [{
            name: "Search Console · comparison period",
            state: "empty" as const,
            detail: `Search Console keeps ${GSC_KEEPS_MONTHS} months, back to ${gscKeptFrom}, so search changes against ${gscRange.prevFrom} → ${gscRange.prevTo} are not shown`,
          }]
        : []),
      ...(leadsMonthly.connected && !comparable.crm
        ? [{
            name: "Metabase · comparison period",
            state: "empty" as const,
            detail: `the CRM's lead records start at the Engage cutover on ${CRM_SINCE}, so lead and deal changes against ${range.prevFrom} → ${range.prevTo} are not shown`,
          }]
        : []),
    ],
    manual,
    keywords: cfg.keywords,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * One source's condition.
 *
 * "answered with nothing" is deliberately its own state rather than being
 * folded into ok: an empty month and a source that is up but returning nothing
 * need different actions, and only one of them is normal.
 */
function status(
  name: string,
  connected: boolean,
  failed: boolean,
  volume: number,
  detail?: string,
  missing: string[] = [],
): SourceStatus {
  if (!connected) return { name, state: "off", detail: detail ?? "no credentials configured" };
  if (failed) return { name, state: "down", detail: detail ?? "query failed" };
  if (missing.length) {
    return { name, state: "partial", detail: `did not answer for ${missing.join(", ")}, even after waiting its turn. Those parts are blank rather than zero; reload to try again.` };
  }
  if (volume <= 0) return { name, state: "empty", detail: "connected, but returned no rows for this range" };
  return { name, state: "ok", detail: "answered" };
}

export interface SeoReportLeads {
  current: LeadsData;
  previous: LeadsData;
  /** Deals from 1 January of the range's final year to its end, by channel; null if that query failed. */
  ytdDeals: { ai: number; organic: number } | null;
  /**
   * Why the deals query failed, when it did. `deals` on both periods is then
   * left at zero by getLeadsData, so the page must read this rather than them.
   */
  dealsError?: string;
}

/**
 * Slow half — the Metabase leads detail, fetched client-side.
 *
 * The page sends the comparison period it is already showing, so the CRM half
 * cannot compare different days from the traffic half above it.
 */
export async function getSeoReportLeads(q: RangeQuery & { prevFrom?: string | null; prevTo?: string | null }): Promise<SeoReportLeads> {
  const r = resolveSeoRange(q);
  const [prevFrom, prevTo] = isDate(q.prevFrom) && isDate(q.prevTo) && q.prevFrom <= q.prevTo ? [q.prevFrom, q.prevTo] : [r.prevFrom, r.prevTo];
  const yearStart = `${r.to.slice(0, 4)}-01-01`;
  // Deals for the range, its comparison and the year so far come from ONE
  // query: crediting a deal to the person a channel brought in means scanning
  // every enquiry since the Engage cutover, and once is enough.
  const [current, previous, deals] = await Promise.all([
    getLeadsData(r.from, r.to, { deals: false }),
    getLeadsData(prevFrom, prevTo, { deals: false }),
    getChannelDeals([
      { from: r.from, to: r.to },
      { from: prevFrom, to: prevTo },
      { from: yearStart, to: r.to },
    ]),
  ]);
  if ("error" in deals) return { current, previous, ytdDeals: null, dealsError: deals.error };
  return { current: { ...current, deals: deals[0] }, previous: { ...previous, deals: deals[1] }, ytdDeals: deals[2] };
}

/**
 * The range's own lead counts and nothing else, for the Website tab's pop-up
 * card (`/api/seo/leads?lite=1`). The full read adds a comparison scan and the
 * deals query, about 16 s on 20 Oct 2026 against 6.5 s for this alone, and
 * the card reads neither.
 */
export async function getSeoLeadsCurrent(q: RangeQuery): Promise<{ current: LeadsData }> {
  const r = resolveSeoRange(q);
  return { current: await getLeadsData(r.from, r.to, { deals: false }) };
}

/**
 * Join the traffic series to the lead series on month.
 *
 * Driven by the TRAFFIC months rather than by the union: a month with leads but
 * no PostHog data would otherwise appear with zero visitors and read as a
 * collapse in traffic, when it is really a gap in one source.
 */
function mergeMonths(traffic: AiMonthRow[], leads: LeadsMonthly): MonthPoint[] {
  const byMonth = new Map(leads.rows.map((r) => [r.month, r]));
  return traffic.map((t) => {
    const l = byMonth.get(t.month);
    return {
      month: t.month,
      organicVisitors: t.organicVisitors,
      organicPageviews: t.organicPageviews,
      allPageviews: t.allPageviews,
      aiVisitors: t.aiVisitors,
      aiShareOfOrganic: t.organicVisitors > 0 ? t.aiVisitors / t.organicVisitors : 0,
      byAssistant: t.byAssistant,
      aiLeads: l?.aiLeads ?? 0,
      aiLeadsBySource: l?.aiBySource ?? [],
      organicLeads: l?.organicLeads ?? 0,
      deals: l?.deals ?? 0,
    } satisfies MonthPoint;
  });
}

/** Percentage change, or null when the base is zero and a ratio would be a lie. */
export function pctChange(now: number, before: number): number | null {
  if (!before) return null;
  return (now - before) / before;
}
