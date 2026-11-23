// The SEO tab's period: which whole months its figures cover, which months they
// are set against, and which months its charts draw. Pure, so the page's
// picker and the server work it out the same way.
//
// Rolling periods (the last 3 months, the year to date) are worked out on the
// day from the latest whole month Search Console has published, so the tab,
// and a link to it, moves on by itself: on 3 January 2027 "Last 3 months"
// becomes October to December 2026, set against July to September.
import { daysInMonth, todayIn } from "@/lib/dateRanges";

/** Months the charts draw at least. */
export const TREND_MONTHS = 12;
/** Longest period the picker allows. */
export const MAX_PERIOD_MONTHS = 24;
/** PostHog began recording bhomes.com on 10 Oct 2025: the first whole month every source holds. */
export const FIRST_MONTH = "2025-11";
/** Search Console publishes each Pacific-time day about three days late. */
const GSC_TZ = "America/Los_Angeles";
const GSC_LAG_DAYS = 3;

export const PERIOD_PRESETS = [
  { key: "last1", label: "Last month", months: 1 },
  { key: "last3", label: "Last 3 months", months: 3 },
  { key: "last6", label: "Last 6 months", months: 6 },
  { key: "last12", label: "Last 12 months", months: 12 },
  { key: "ytd", label: "Year to date", months: 0 },
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number]["key"] | "custom";
export const DEFAULT_PRESET: PeriodPreset = "last3";

const pad = (n: number) => String(n).padStart(2, "0");
const isMonth = (s?: string | null): s is string => !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** The YYYY-MM `k` months after `m`, or before it when `k` is negative. */
export function addMonths(m: string, k: number): string {
  const i = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + k;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}

/** Every month from `from` to `to`, both included. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** A month's first and last day. */
export const monthBounds = (m: string) => ({ month: m, from: `${m}-01`, to: `${m}-${pad(daysInMonth(m))}` });

/** Today's month on Search Console's calendar. */
export const gscMonth = (now = new Date()) => {
  const t = todayIn(GSC_TZ, now);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}`;
};

/**
 * The latest month that has ended on Dubai's calendar: the Website tab's
 * newest whole month, as PostHog and the CRM hold all of it from the 1st.
 */
export function endedMonth(now = new Date()): string {
  const t = todayIn("Asia/Dubai", now);
  return addMonths(`${t.getFullYear()}-${pad(t.getMonth() + 1)}`, -1);
}

/**
 * The latest month Search Console has published in full: on 2 November the
 * last days of October are not published yet, so it is still September; on
 * 3 November it is October.
 */
export function latestMonth(now = new Date()): string {
  const t = todayIn(GSC_TZ, now);
  const published = new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate() - GSC_LAG_DAYS));
  const month = `${published.getUTCFullYear()}-${pad(published.getUTCMonth() + 1)}`;
  return published.getUTCDate() === daysInMonth(month) ? month : addMonths(month, -1);
}

/** What the page asks for: a preset by name, or a first and last month. */
export interface PeriodQuery {
  preset?: string | null;
  from?: string | null;
  to?: string | null;
}

export interface GrowthPeriod {
  preset: PeriodPreset;
  /** The months the figures cover, first and last included. */
  from: string;
  to: string;
  /** The same number of months just before: what every change is against. */
  compareFrom: string;
  compareTo: string;
  /** The months the charts draw: the period's last twelve months at least, ending with it. */
  trend: string[];
  /** Every month the figures need, oldest first: the comparison, the period and the charts' months. */
  months: string[];
  /** The months the picker offers. */
  first: string;
  latest: string;
}

/**
 * A request's period, resolved. A preset is worked out from `latest`; two
 * months are kept within FIRST_MONTH and `latest`, put in order, and cut to
 * MAX_PERIOD_MONTHS from the end. Anything else is the default, the last 3
 * months.
 */
export function resolvePeriod(q: PeriodQuery, latest: string): GrowthPeriod {
  const first = FIRST_MONTH < latest ? FIRST_MONTH : latest;
  const clamp = (m: string) => (m < first ? first : m > latest ? latest : m);
  let preset: PeriodPreset = DEFAULT_PRESET;
  let from: string, to: string;
  const named = PERIOD_PRESETS.find((p) => p.key === q.preset);
  if (named) preset = named.key;
  else if (q.preset === "custom" || (isMonth(q.from) && isMonth(q.to))) preset = isMonth(q.from) && isMonth(q.to) ? "custom" : DEFAULT_PRESET;
  if (preset === "custom") {
    [from, to] = [clamp(q.from as string), clamp(q.to as string)];
    if (from > to) [from, to] = [to, from];
    if (monthsBetween(from, to).length > MAX_PERIOD_MONTHS) from = addMonths(to, -(MAX_PERIOD_MONTHS - 1));
  } else {
    const p = PERIOD_PRESETS.find((x) => x.key === preset) ?? PERIOD_PRESETS[1];
    to = latest;
    from = p.months ? addMonths(latest, -(p.months - 1)) : `${latest.slice(0, 4)}-01`;
    if (from < first) from = first;
  }
  const n = monthsBetween(from, to).length;
  const compareTo = addMonths(from, -1);
  const compareFrom = addMonths(from, -n);
  const trend = monthsBetween(addMonths(to, -(Math.max(TREND_MONTHS, n) - 1)), to);
  const start = compareFrom < trend[0] ? compareFrom : trend[0];
  return { preset, from, to, compareFrom, compareTo, trend, months: monthsBetween(start, to), first, latest };
}

/** A period as its query string, which is also the tab's own address. Rolling presets stay rolling. */
export function periodQuery(p: { preset: PeriodPreset; from: string; to: string }): string {
  return p.preset === "custom" ? `from=${p.from}&to=${p.to}` : `preset=${p.preset}`;
}
