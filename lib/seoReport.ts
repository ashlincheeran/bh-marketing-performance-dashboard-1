// The Dashboard's SEO card, and the date ranges it is asked for.
//
// The card (getSeoTile) adds up the SEO tab's own months, through the tab's own
// requests: Search Console's clicks month by month (lib/gsc.ts,
// getSearchMonthly), and the people organic search and AI assistants sent
// (lib/posthog.ts, getOrganicVisitors). So the card and the tab it links to
// can't disagree. The tab itself is lib/organicGrowth.ts.
import { cacheKey, remembered, type RememberOptions } from "@/lib/cache";
import { getOrganicVisitors } from "@/lib/posthog";
import { getSearchMonthly } from "@/lib/gsc";
import { isPresetKey, rangeFor, todayIn, type RangeKey } from "@/lib/dateRanges";

// ── date ranges ────────────────────────────────────────────────────────────
//
// Plain YYYY-MM-DD strings throughout, with arithmetic done in UTC so that no
// server offset can move a date by a day.

/** Whose calendar "today" is. The server runs in UTC; the business does not. */
const TZ = "Asia/Dubai";
/** Longest range served. Two years keeps the PostHog scans inside their time limit. */
const MAX_DAYS = 731;
/** Search Console reports Pacific-time days and publishes them about three days late. */
const GSC_TZ = "America/Los_Angeles";
const GSC_LAG_DAYS = 3;

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
    // By default the year to date.
    preset = "this_year";
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

/**
 * The Dashboard's SEO card for a range, by the SEO tab's own rules and through
 * its own requests, so the card and the tab it links to can't disagree.
 *
 * Until Nov 2026 the card read the SEO & AI Channel report (since removed):
 * Search Console asked for one total over the whole range, and PostHog's AI
 * visitors counted with careers pages in, once across the range, against
 * organic search alone. Same sources, different questions: for the year to 22
 * Nov the card read 196,593 clicks where Search Console's own days add up to
 * about 183,800 (by the month the two requests agree to the click), and 9,575
 * AI visitors, 6.4% of organic, where the tab read 7,941 and 5.1%.
 */
export interface SeoTile {
  /** When this answer was worked out (lib/cache.ts), for "Updated … ago". */
  cachedAt?: string | null;
  range: SeoRange;
  /** The days the clicks cover: the range cut to what Search Console has published (searchConsoleRange). */
  gscRange: RangePair;
  /** Search Console's days added up, as the SEO tab adds up its months; null when it did not answer for all of them. */
  search: { clicks: number; impressions: number } | null;
  searchError?: string;
  /** People from organic search (careers pages left out) and from AI assistants, per month added up (getOrganicVisitors). */
  visitors: { seo: number; ai: number } | null;
  visitorsError?: string;
}

/** Calendar months covering from → to, the first and last clipped to the range, as getSearchMonthly takes them. */
export function monthPieces(from: string, to: string): { month: string; from: string; to: string }[] {
  const out: { month: string; from: string; to: string }[] = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); ) {
    const { from: first, to: last } = monthRange(m);
    out.push({ month: m, from: first < from ? from : first, to: last > to ? to : last });
    const [y, mo] = m.split("-").map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${pad(mo + 1)}`;
  }
  return out;
}

/** The Dashboard's SEO card, remembered (lib/cache.ts) and kept only when both sources answered. */
export async function getSeoTile(q: RangeQuery = {}, opts: RememberOptions = {}): Promise<SeoTile> {
  const r = resolveSeoRange(q);
  return remembered(
    cacheKey("seoTile", { preset: r.preset, from: r.from, to: r.to }),
    () => computeSeoTile(r),
    (d) => !!d.search && !!d.visitors,
    opts,
  );
}

async function computeSeoTile(range: SeoRange): Promise<SeoTile> {
  const gscRange = searchConsoleRange(range);
  const published = gscRange.to >= gscRange.from;
  const [searched, people] = await Promise.all([
    published ? getSearchMonthly(monthPieces(gscRange.from, gscRange.to)) : null,
    getOrganicVisitors(range.from, range.to),
  ]);
  const months = searched?.months ?? [];
  const search =
    months.length && months.every((m) => m)
      ? months.reduce((t, m) => ({ clicks: t.clicks + m!.clicks, impressions: t.impressions + m!.impressions }), { clicks: 0, impressions: 0 })
      : null;
  const searchError = !published
    ? `Search Console publishes about ${GSC_LAG_DAYS} days late, so nothing for these days yet`
    : searched?.connected === false
      ? (searched.error ?? "Search Console is not connected")
      : (searched?.error ?? "Search Console did not answer for every month");
  return {
    range,
    gscRange,
    search,
    ...(search ? {} : { searchError }),
    visitors: people.seo != null && people.ai != null ? { seo: people.seo, ai: people.ai } : null,
    ...(people.seo != null && people.ai != null ? {} : { visitorsError: people.error ?? (people.connected ? "PostHog did not answer" : "PostHog is not connected") }),
  };
}
