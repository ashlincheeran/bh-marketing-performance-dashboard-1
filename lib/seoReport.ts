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
import { getLeadsData, getLeadsMonthly, type LeadsData, type LeadsMonthly } from "@/lib/metabase";
import { getSeoConfig } from "@/lib/data";
import { getSeoManual, type SeoManual } from "@/lib/seoManual";

const pad = (n: number) => String(n).padStart(2, "0");
const isMonth = (s?: string) => !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** First and last day of a YYYY-MM. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${pad(last)}` };
}

export function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

/** The month the report defaults to: the current one. */
export function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`;
}

/** How far back the trend tables reach. Twelve months keeps one scan cheap. */
const TREND_MONTHS = Number(process.env.SEO_TREND_MONTHS || 12);

function trendStart(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - (TREND_MONTHS - 1), 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
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
  /** ok = answered with data · empty = answered with nothing · down = did not answer. */
  state: "ok" | "empty" | "down" | "off";
  detail: string;
}

export interface SeoReport {
  month: string;
  previous: string;
  label: string;
  /** This month and last, so every card can show its own delta. */
  ai: AiChannel;
  aiPrev: AiChannel;
  gsc: GscData;
  gscPrev: GscData;
  months: MonthPoint[];
  sources: SourceStatus[];
  manual: SeoManual;
  keywords: string[];
  generatedAt: string;
}

/** Fast half — PostHog + GSC + the stored manual figures. Loads with the page. */
export async function getSeoReport(monthRaw?: string): Promise<SeoReport> {
  const month = isMonth(monthRaw) ? monthRaw! : currentMonth();
  const previous = prevMonth(month);
  const cur = monthRange(month);
  const prev = monthRange(previous);
  const cfg = await getSeoConfig();

  const [ai, aiPrev, gsc, gscPrev, monthly, leadsMonthly, manual] = await Promise.all([
    getAiChannel(cur.from, cur.to),
    getAiChannel(prev.from, prev.to),
    getGscMetrics(cur.from, cur.to, cfg.keywords),
    getGscMetrics(prev.from, prev.to, cfg.keywords),
    getAiMonthly(trendStart(month), cur.to),
    getLeadsMonthly(trendStart(month), cur.to),
    getSeoManual(),
  ]);

  return {
    month,
    previous,
    label: month,
    ai,
    aiPrev,
    gsc,
    gscPrev,
    months: mergeMonths(monthly, leadsMonthly),
    sources: [
      status("PostHog", ai.connected, !!ai.error, ai.visitors + ai.allPageviews, ai.error),
      status("Search Console", gsc.connected, !!gsc.error, gsc.totals?.impressions ?? 0, gsc.error),
      status(
        "Metabase",
        leadsMonthly.connected,
        !!leadsMonthly.error,
        leadsMonthly.rows.reduce((n, r) => n + r.aiLeads + r.organicLeads, 0),
        leadsMonthly.error,
      ),
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
): SourceStatus {
  if (!connected) return { name, state: "off", detail: detail ?? "no credentials configured" };
  if (failed) return { name, state: "down", detail: detail ?? "query failed" };
  if (volume <= 0) return { name, state: "empty", detail: "connected, but returned no rows for this month" };
  return { name, state: "ok", detail: "answered" };
}

/** Slow half — the Metabase leads detail, fetched client-side. */
export async function getSeoReportLeads(monthRaw?: string): Promise<{ current: LeadsData; previous: LeadsData }> {
  const month = isMonth(monthRaw) ? monthRaw! : currentMonth();
  const cur = monthRange(month);
  const prev = monthRange(prevMonth(month));
  const [current, previous] = await Promise.all([
    getLeadsData(cur.from, cur.to),
    getLeadsData(prev.from, prev.to),
  ]);
  return { current, previous };
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
