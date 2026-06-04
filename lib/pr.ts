// Pure data helpers for the PR & Media view. No React / framework imports so
// these can run on the server (page load) and the client (filter changes).
import type { Mention, Outlet, RawMention, Tier } from "./types";
import { TIERS } from "./theme";

export const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Join raw clips with the outlet reference table to fill missing EAV/reach. */
export function enrichMentions(raw: RawMention[], outlets: Outlet[]): Mention[] {
  const byOutlet = new Map(outlets.map((o) => [o.outlet, o]));
  return raw.map((m) => {
    const o = m.outlet ? byOutlet.get(m.outlet) : undefined;
    const eavEff = m.eav ?? o?.default_eav ?? 0;
    const reachEff = m.reach ?? o?.default_reach ?? 0;
    return {
      id: m.id,
      date: m.date,
      year: m.year,
      month: m.month,
      tier: m.tier,
      outlet: m.outlet,
      title: m.title,
      url: m.url,
      eav: m.eav,
      reach: m.reach,
      eavEff,
      reachEff,
      modeled: m.eav == null && eavEff > 0,
      brand: m.brand,
      sentiment: m.sentiment,
      source: m.source ?? "historical_import",
    };
  });
}

/** "YYYY-MM" of a clip, or "" when undated. */
function ym(m: Mention): string {
  return m.date ? m.date.slice(0, 7) : "";
}

export function inRange(m: Mention, from: string, to: string): boolean {
  const d = ym(m);
  return d !== "" && d >= from && d <= to;
}

export function filterRange(mentions: Mention[], from: string, to: string): Mention[] {
  return mentions.filter((m) => inRange(m, from, to));
}

// ── formatting ──────────────────────────────────────────────
export function fmtEAV(v: number): string {
  if (!v) return "$0";
  if (v >= 1_000_000) return "$" + (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000) return "$" + Math.round(v / 1_000) + "K";
  return "$" + v;
}
export function fmtReach(v: number): string {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000) return Math.round(v / 1_000) + "K";
  return String(v);
}
export function fmtReachFull(v: number): string {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return Math.round(v / 1_000) + "K";
  return String(v);
}

// ── iterate the months spanning a range ─────────────────────
function* eachMonth(from: string, to: string) {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  for (let y = fy; y <= ty; y++) {
    const ms = y === fy ? fm : 1;
    const me = y === ty ? tm : 12;
    for (let m = ms; m <= me; m++) yield { y, m };
  }
}

export interface MonthlySeries {
  labels: string[];
  eav: number[];
  reach: number[];
  count: number[];
}

export function monthlySeries(mentions: Mention[], from: string, to: string): MonthlySeries {
  const months = [...eachMonth(from, to)];
  const multiYear = months.length > 0 && months[0].y !== months[months.length - 1].y;
  const idx = new Map<string, number>();
  const labels: string[] = [];
  months.forEach(({ y, m }, i) => {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    idx.set(key, i);
    labels.push(multiYear ? `${MONTHS[m - 1]} ${String(y).slice(2)}` : MONTHS[m - 1]);
  });
  const eav = new Array(months.length).fill(0);
  const reach = new Array(months.length).fill(0);
  const count = new Array(months.length).fill(0);
  for (const m of mentions) {
    const i = idx.get(ym(m));
    if (i === undefined) continue;
    eav[i] += m.eavEff;
    reach[i] += m.reachEff;
    count[i] += 1;
  }
  return { labels, eav, reach, count };
}

export interface Kpis {
  count: number;
  tier1: number;
  reach: number;
  eav: number;
  posPct: number | null;
  sentimentCoverage: number;
}

export function kpis(mentions: Mention[]): Kpis {
  const tier1 = mentions.filter((m) => m.tier === "T1-Global" || m.tier === "T1-Local").length;
  const reach = mentions.reduce((a, m) => a + m.reachEff, 0);
  const eav = mentions.reduce((a, m) => a + m.eavEff, 0);
  const withSent = mentions.filter((m) => m.sentiment != null);
  const pos = withSent.filter((m) => m.sentiment === "positive").length;
  return {
    count: mentions.length,
    tier1,
    reach,
    eav,
    posPct: withSent.length ? Math.round((pos / withSent.length) * 100) : null,
    sentimentCoverage: withSent.length,
  };
}

/** Stacked tier counts per month (within a filtered set). */
export function tierByMonth(mentions: Mention[]) {
  const months = Array.from(new Set(mentions.map(ym).filter(Boolean))).sort();
  const series: Record<Tier, number[]> = {
    "T1-Global": [], "T1-Local": [], T2: [], T3: [], Other: [],
  };
  for (const t of TIERS) series[t] = new Array(months.length).fill(0);
  const mIdx = new Map(months.map((m, i) => [m, i]));
  for (const m of mentions) {
    const i = mIdx.get(ym(m));
    if (i === undefined) continue;
    series[m.tier][i] += 1;
  }
  return { months, series };
}

/** Annual totals split by tier — full history, ignores the date filter. */
export function annualByTier(mentions: Mention[]) {
  const years = Array.from(new Set(mentions.map((m) => m.year).filter((y): y is number => y != null))).sort();
  const series: Record<Tier, number[]> = {
    "T1-Global": [], "T1-Local": [], T2: [], T3: [], Other: [],
  };
  for (const t of TIERS) series[t] = new Array(years.length).fill(0);
  const yIdx = new Map(years.map((y, i) => [y, i]));
  for (const m of mentions) {
    if (m.year == null) continue;
    series[m.tier][yIdx.get(m.year)!] += 1;
  }
  return { years, series };
}

export function sentimentBreakdown(mentions: Mention[]) {
  const counts = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
  let total = 0;
  for (const m of mentions) {
    if (m.sentiment) {
      counts[m.sentiment] += 1;
      total += 1;
    }
  }
  return { counts, total };
}

export interface OutletRollup {
  outlet: string;
  count: number;
  eav: number;
  reach: number;
  tier: Tier;
}

export function topOutlets(mentions: Mention[], n = 10): OutletRollup[] {
  const map = new Map<string, OutletRollup>();
  for (const m of mentions) {
    if (!m.outlet) continue;
    const cur = map.get(m.outlet) ?? { outlet: m.outlet, count: 0, eav: 0, reach: 0, tier: m.tier };
    cur.count += 1;
    cur.eav += m.eavEff;
    cur.reach += m.reachEff;
    map.set(m.outlet, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, n);
}

export interface Insight {
  kind: "win" | "high" | "medium" | "test";
  label: string;
  text: string;
}

/** Honest, data-derived insights (no fabricated metrics). */
export function buildInsights(all: Mention[], filtered: Mention[]): Insight[] {
  const out: Insight[] = [];
  const k = kpis(filtered);

  const top = topOutlets(filtered, 1)[0];
  if (top) {
    out.push({
      kind: "win",
      label: "Top outlet",
      text: `${top.outlet} is your most frequent placement in range — ${top.count} clips. Keep that relationship warm and pitch it first on big stories.`,
    });
  }

  const annual = annualByTier(all);
  if (annual.years.length >= 2) {
    const totals = annual.years.map((_, i) =>
      TIERS.reduce((a, t) => a + annual.series[t][i], 0)
    );
    let bestI = 0;
    totals.forEach((v, i) => { if (v > totals[bestI]) bestI = i; });
    out.push({
      kind: "medium",
      label: "Biggest year",
      text: `${annual.years[bestI]} was your strongest year on record with ${totals[bestI]} total clips across all tiers.`,
    });
  }

  if (k.count) {
    const t1Share = Math.round((k.tier1 / k.count) * 100);
    out.push({
      kind: t1Share < 25 ? "high" : "win",
      label: "Tier-1 share",
      text: `${k.tier1} of ${k.count} clips in range (${t1Share}%) are Tier-1 (Global + Local). ${
        t1Share < 25 ? "Push more macro data stories toward Reuters/Bloomberg/Arabian Business to lift this." : "Strong premium-tier mix — protect it."
      }`,
    });
  }

  out.push({
    kind: "test",
    label: "Next: sentiment",
    text: `Sentiment isn't in the source spreadsheet, so it's blank today. The ingestion step will auto-classify each clip (positive / neutral / negative) with Claude — turning this panel into live tone tracking.`,
  });

  return out;
}
