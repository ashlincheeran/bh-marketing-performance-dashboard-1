// Pure data helpers for the PR & Media view. No React / framework imports so
// these can run on the server (page load) and the client (filter changes).
import type { Mention, Outlet, RawMention, Tier } from "./types";
import { TIERS } from "./theme";
import { outletKey } from "./match";

export const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * The publication a clip's web address names, or "" when it names none: no
 * address, the news feed's own wrapper link, or a one-letter site such as
 * x.com or t.co, which hosts posts rather than publishing them.
 */
function siteKey(url: string | null | undefined): string {
  const key = url ? outletKey(null, url) : "";
  return key.length > 1 ? key : "";
}

/**
 * Join raw clips with the outlet reference table to fill missing EAV/reach.
 *
 * The card is read by the clip's exact outlet name first, then by the
 * publication's key from lib/match.ts: its web address, then its name. The
 * news feed names an outlet by its title one day and its address the next,
 * and the card holds typo rows with no figures ("Khaleej TImes"), so by exact
 * name alone "khaleejtimes.com" and "Khaleej TImes" were worth nothing,
 * although the card gives Khaleej Times $2,200 EAV and 500K reach.
 */
export function enrichMentions(raw: RawMention[], outlets: Outlet[]): Mention[] {
  const byOutlet = new Map(outlets.map((o) => [o.outlet, o]));
  // Of the card rows that share a key, the one with the most figures, so a
  // typo row never hides the publication's real one.
  const figures = (o: Outlet) => Number(o.default_eav != null) + Number(o.default_reach != null);
  const byKey = new Map<string, Outlet>();
  for (const o of outlets) {
    const key = outletKey(o.outlet);
    const held = byKey.get(key);
    if (key && (!held || figures(o) > figures(held))) byKey.set(key, o);
  }
  return raw.map((m) => {
    const cards = [
      m.outlet ? byOutlet.get(m.outlet) : undefined,
      byKey.get(siteKey(m.url)),
      m.outlet ? byKey.get(outletKey(m.outlet)) : undefined,
    ];
    const eavEff = m.eav ?? cards.find((o) => o?.default_eav != null)?.default_eav ?? 0;
    const reachEff = m.reach ?? cards.find((o) => o?.default_reach != null)?.default_reach ?? 0;
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
      // What getMentions knows of the news bot, left out when it knows nothing.
      ...(m.foundByBot ? { foundByBot: true } : {}),
      ...(m.articleId ? { articleId: m.articleId } : {}),
      ...(m.botRowIds?.length ? { botRowIds: m.botRowIds } : {}),
    };
  });
}

/** "YYYY-MM" of a clip, or "" when undated. */
function ym(m: Mention): string {
  return m.date ? m.date.slice(0, 7) : "";
}

/**
 * True when a clip falls in the months from `from` to `to`. An undated clip is
 * in no range of months; `undated` lets it in where the range stands for every
 * record on file (the All time preset).
 */
export function inRange(m: Mention, from: string, to: string, undated = false): boolean {
  const d = ym(m);
  return d === "" ? undated : d >= from && d <= to;
}

export function filterRange(mentions: Mention[], from: string, to: string, undated = false): Mention[] {
  return mentions.filter((m) => inRange(m, from, to, undated));
}

// ── months ──────────────────────────────────────────────────
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** True for a real "YYYY-MM" month from `min` to `max`, both included. */
export function isMonthIn(v: string, min: string, max: string): boolean {
  return MONTH.test(v) && v >= min && v <= max;
}

/** "YYYY-MM" moved by `delta` months: shiftMonth("2026-01", -1) is "2025-12". */
export function shiftMonth(month: string, delta: number): string {
  let [y, m] = month.split("-").map(Number);
  m += delta;
  while (m <= 0) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** How many months from `from` to `to`, both included. */
export function monthSpan(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

/**
 * Period B for "Period before A": the months right before A, as many as A
 * has, cut short where the records start. Null when A starts in the first
 * month on file, as there is nothing before it to compare.
 */
export function periodBefore(from: string, to: string, first: string): { from: string; to: string } | null {
  const end = shiftMonth(from, -1);
  if (end < first) return null;
  const start = shiftMonth(from, -monthSpan(from, to));
  return { from: start < first ? first : start, to: end };
}

/** "3 months", "1 month". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What the compare controls say when Period B is unlike Period A, or "" when
 * the two are alike: an overlap counts the clips they share on both sides, and
 * a different length compares unlike periods. Said however B was chosen.
 */
export function comparisonNote(a: { from: string; to: string }, b: { from: string; to: string }, first: string): string {
  const lenA = monthSpan(a.from, a.to);
  const lenB = monthSpan(b.from, b.to);
  const [fy, fm] = first.split("-").map(Number);
  return [
    b.from <= a.to && b.to >= a.from ? "Period B overlaps Period A, so the clips they share count on both sides." : "",
    lenB !== lenA
      ? `Period B is ${plural(lenB, "month")} and Period A ${plural(lenA, "month")}, so the changes compare periods of different lengths${
          b.from === first && lenB < lenA ? `: the records start in ${MONTHS[fm - 1]} ${fy}` : ""
        }.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
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
  // Anything but two real months gives no months: a blank "from" counted from
  // year 0, 24,304 chart months.
  if (!MONTH.test(from) || !MONTH.test(to)) return;
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  for (let y = fy; y <= ty; y++) {
    const ms = y === fy ? fm : 1;
    const me = y === ty ? tm : 12;
    for (let m = ms; m <= me; m++) yield { y, m };
  }
}

const monthKey = ({ y, m }: { y: number; m: number }) => `${y}-${String(m).padStart(2, "0")}`;

/** Axis labels for a run of months: "Jan", or "Jan 25" when the run spans years. */
function monthLabels(months: { y: number; m: number }[]): string[] {
  const multiYear = months.length > 0 && months[0].y !== months[months.length - 1].y;
  return months.map(({ y, m }) => (multiYear ? `${MONTHS[m - 1]} ${String(y).slice(2)}` : MONTHS[m - 1]));
}

export interface MonthlySeries {
  labels: string[];
  eav: number[];
  reach: number[];
  count: number[];
}

export function monthlySeries(mentions: Mention[], from: string, to: string): MonthlySeries {
  const months = [...eachMonth(from, to)];
  const idx = new Map(months.map((mo, i) => [monthKey(mo), i]));
  const labels = monthLabels(months);
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

/**
 * Stacked tier counts per month (within a filtered set).
 *
 * Given the range, every month in it gets a column, an empty month too, so a
 * gap in coverage shows as a gap and the axis matches the EAV & Reach chart
 * beside it. Without one, only the months that have clips.
 */
export function tierByMonth(mentions: Mention[], from?: string, to?: string) {
  const range = from && to ? [...eachMonth(from, to)] : null;
  const months = range ? range.map(monthKey) : Array.from(new Set(mentions.map(ym).filter(Boolean))).sort();
  const labels = range ? monthLabels(range) : months;
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
  return { months, labels, series };
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

/** An outlet name's key; a name outletKey() can't spell (no Latin letters) stands for itself. */
const nameKey = (outlet: string) => outletKey(outlet) || outlet.trim().toLowerCase();

/**
 * Which publication each clip belongs to, as one key per publication.
 *
 * Clips are grouped by their outlet's name through outletKey(), so every
 * spelling of a name shares a key ("MENAFN" and "MenaFN", "Press Reader" and
 * "PressReader.com", "khaleejtimes.com" and "Khaleej Times"). A name at least
 * half of whose clips link to a publication known in the set by another name
 * joins it: "The National" links to thenationalnews.com, so it shares a key
 * with "The National News". One syndicated link can't move a name with many
 * clips, and an address that is no outlet's name moves nothing, as it is as
 * often a host as the publisher (a LinkedIn post, the Indiatimes site that
 * carries both The Economic Times and The Times of India).
 */
function publicationOf(mentions: Mention[]): (m: Mention) => string {
  const clips = new Map<string, number>(); // name key → clips
  const sites = new Map<string, Map<string, number>>(); // name key → address key → clips
  for (const m of mentions) {
    if (!m.outlet) continue;
    const name = nameKey(m.outlet);
    clips.set(name, (clips.get(name) ?? 0) + 1);
    const site = siteKey(m.url);
    if (!site) continue;
    const votes = sites.get(name) ?? new Map<string, number>();
    votes.set(site, (votes.get(site) ?? 0) + 1);
    sites.set(name, votes);
  }
  const moveTo = new Map<string, string>();
  for (const [name, votes] of sites) {
    // A tie keeps the name where it is.
    let best = name;
    for (const [site, n] of votes) if (n > (votes.get(best) ?? 0)) best = site;
    if (best !== name && clips.has(best) && 2 * votes.get(best)! >= clips.get(name)!) moveTo.set(name, best);
  }
  return (m) => {
    let key = nameKey(m.outlet ?? "");
    // Along a chain of moves, never round a loop.
    for (const seen = new Set<string>(); moveTo.has(key) && !seen.has(key); key = moveTo.get(key)!) seen.add(key);
    return key;
  };
}

/** The value counted most often; on a tie, the one counted first. */
function mostCommon<T>(counts: Map<T, number>): T {
  let best: T | undefined;
  let top = 0;
  for (const [v, n] of counts) if (n > top) { best = v; top = n; }
  return best as T;
}

/**
 * The most frequent publications. One bar per publication however many names
 * it came under, labelled with its most common name and coloured by its most
 * common tier. Grouped by the raw name, The National's 16 clips from May 2024
 * to Apr 2026 showed as "The National News: 11" and two smaller bars, each
 * coloured by whichever clip came first.
 */
export function topOutlets(mentions: Mention[], n = 10): OutletRollup[] {
  const keyOf = publicationOf(mentions);
  const groups = new Map<string, { names: Map<string, number>; tiers: Map<Tier, number>; count: number; eav: number; reach: number }>();
  for (const m of mentions) {
    if (!m.outlet) continue;
    const key = keyOf(m);
    const g = groups.get(key) ?? { names: new Map(), tiers: new Map(), count: 0, eav: 0, reach: 0 };
    g.names.set(m.outlet, (g.names.get(m.outlet) ?? 0) + 1);
    g.tiers.set(m.tier, (g.tiers.get(m.tier) ?? 0) + 1);
    g.count += 1;
    g.eav += m.eavEff;
    g.reach += m.reachEff;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ outlet: mostCommon(g.names), count: g.count, eav: g.eav, reach: g.reach, tier: mostCommon(g.tiers) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
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
