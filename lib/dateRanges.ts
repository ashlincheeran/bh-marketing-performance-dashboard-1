// Named date ranges — the one list every tab's date control offers.
//
// A plain module rather than part of the picker component, because it runs on
// both sides: the Website, Digital and Portals tabs resolve a preset in the
// browser at the moment it is picked, while the SEO tab sends the preset's NAME
// and resolves it on the server. That way a bookmarked "last 30 days" stays
// rolling, and the page renders the very range it fetched. Both call rangeFor,
// so a name means the same days either way.
//
// Weeks start on Monday. "Last N days" ends yesterday, as Google Ads counts it:
// today is still filling in, so including it would make every rolling window
// read low.

export type RangeKey =
  | "this_year" | "last_year"
  | "this_quarter" | "last_quarter"
  | "this_month" | "last_month"
  | "last_90_days" | "last_30_days" | "last_7_days"
  | "this_week" | "last_week"
  | "today" | "yesterday"
  | "custom";

export type PresetKey = Exclude<RangeKey, "custom">;

export const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "this_year", label: "This year" },
  { key: "last_year", label: "Last year" },
  { key: "this_quarter", label: "This quarter" },
  { key: "last_quarter", label: "Last quarter" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_90_days", label: "Last 90 days" },
  { key: "last_30_days", label: "Last 30 days" },
  { key: "last_7_days", label: "Last 7 days" },
  { key: "this_week", label: "This week" },
  { key: "last_week", label: "Last week" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "custom", label: "Custom date range" },
];

export const isPresetKey = (k: unknown): k is PresetKey =>
  typeof k === "string" && k !== "custom" && RANGE_OPTIONS.some((o) => o.key === k);

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * A preset as concrete YYYY-MM-DD dates, from `now`'s local calendar day.
 *
 * In the browser that is the viewer's own day. On the server, pass todayIn()
 * so "today" is Dubai's, not UTC's — the two disagree for the first four hours
 * of every Dubai day.
 */
export function rangeFor(key: PresetKey, now = new Date()): { from: string; to: string } {
  // Normalised to local midnight so day arithmetic can't drift across DST.
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = (t.getDay() + 6) % 7; // Monday = 0
  const q = Math.floor(t.getMonth() / 3) * 3; // first month of this quarter
  const shift = (base: Date, days: number) => {
    const d = new Date(base);
    d.setDate(base.getDate() + days);
    return d;
  };
  switch (key) {
    case "today":
      return { from: ymd(t), to: ymd(t) };
    case "yesterday": {
      const y = shift(t, -1);
      return { from: ymd(y), to: ymd(y) };
    }
    case "this_week":
      return { from: ymd(shift(t, -dow)), to: ymd(t) };
    case "last_week": {
      const mon = shift(t, -dow - 7);
      return { from: ymd(mon), to: ymd(shift(mon, 6)) };
    }
    case "last_7_days":
      return { from: ymd(shift(t, -7)), to: ymd(shift(t, -1)) };
    case "last_30_days":
      return { from: ymd(shift(t, -30)), to: ymd(shift(t, -1)) };
    case "last_90_days":
      return { from: ymd(shift(t, -90)), to: ymd(shift(t, -1)) };
    case "this_month":
      return { from: ymd(new Date(t.getFullYear(), t.getMonth(), 1)), to: ymd(t) };
    case "last_month":
      // Day 0 of this month = the last day of the previous month.
      return { from: ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: ymd(new Date(t.getFullYear(), t.getMonth(), 0)) };
    case "this_quarter":
      return { from: ymd(new Date(t.getFullYear(), q, 1)), to: ymd(t) };
    case "last_quarter":
      return { from: ymd(new Date(t.getFullYear(), q - 3, 1)), to: ymd(new Date(t.getFullYear(), q, 0)) };
    case "this_year":
      return { from: `${t.getFullYear()}-01-01`, to: ymd(t) };
    case "last_year":
      return { from: `${t.getFullYear() - 1}-01-01`, to: `${t.getFullYear() - 1}-12-31` };
  }
}

/** Today's calendar day in a time zone, as a local-midnight Date for rangeFor. */
export function todayIn(timeZone: string, now = new Date()): Date {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now)
    .split("-")
    .map(Number);
  return new Date(y, m - 1, d);
}
