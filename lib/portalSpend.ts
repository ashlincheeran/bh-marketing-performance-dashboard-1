// Real portal spend, from the PPA workbook (Portal Performance Analysis).
//
// PROVENANCE — the `expense` sheet of PPA.xlsx, a monthly spend schedule in AED
// covering Jan 2025 → Mar 2026. Only SPEND is taken from that workbook: deal
// counts, commission and applicants all come from the CRM, so the two can't
// drift apart and the workbook's own derived columns are never trusted.
//
// The figures reconcile against the workbook's own Pivot totals to the dirham,
// which is why they're used rather than an assumption:
//   Property Finder  sum = 10,632,602  (Pivot "Portal Spent" = 10,632,602) ✓
//   Bayut            sum =  2,854,076  (Pivot "Portal Spent" =  2,854,076) ✓
//
// Dubizzle has NO monthly column in that sheet — only a Pivot total of 300,019
// for the same period. It's carried as a total and averaged over the same 15
// months, which is an assumption about its shape, not its size. Flagged in the
// UI so it isn't read as a measured monthly series.
//
// Note on the workbook: its Pivot reports two different cost-per-deal figures
// for Dubizzle (13,647.22 and 1,666.77) from one spend and one deal count —
// 300,019 / 180 = 1,666.77, so the larger one is a formula error. Another reason
// to recompute cost per deal here from live CRM deals rather than import it.

/** Monthly spend in AED, indexed by "YYYY-MM". */
export type SpendSeries = Record<string, number>;

const MONTHS = [
  "2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08",
  "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03",
];

const series = (vals: number[]): SpendSeries =>
  Object.fromEntries(MONTHS.map((m, i) => [m, vals[i] ?? 0]));

/** Property Finder — three months at the old rate, an April spike, then flat. */
const PROPERTY_FINDER = series([
  429342, 429342, 429342, 898248, 767848, 767848, 767848, 767848,
  767848, 767848, 767848, 767848, 767848, 767848, 767848,
]);

/** Bayut — two rate changes, then flat from June 2025. */
const BAYUT = series([
  134663, 134663, 128250, 128250, 128250, 220000, 220000, 220000,
  220000, 220000, 220000, 220000, 220000, 220000, 220000,
]);

/** Dubizzle — period total only, spread evenly. See the header note. */
const DUBIZZLE = series(new Array(MONTHS.length).fill(300019 / MONTHS.length));

export const PORTAL_SPEND: Record<string, SpendSeries> = {
  "Property Finder": PROPERTY_FINDER,
  Bayut: BAYUT,
  Dubizzle: DUBIZZLE,
};

/** Portals whose spend is a real monthly schedule rather than a spread total. */
export const SPEND_IS_MONTHLY: Record<string, boolean> = {
  "Property Finder": true,
  Bayut: true,
  Dubizzle: false,
};

export const SPEND_SOURCE_LABEL = "PPA.xlsx · expense sheet · Jan 2025 – Mar 2026";
export const SPEND_MONTHS = MONTHS.length;

const MONTH_NAME = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (m: string) => `${MONTH_NAME[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;
const span = (ms: string[]) =>
  ms.length ? `${monthName(ms[0])}${ms.length > 1 ? ` – ${monthName(ms[ms.length - 1])}` : ""}` : "";

/** The months the workbook records, for labels: "Jan 2025 – Mar 2026". */
export const SPEND_SPAN = span(MONTHS);

/**
 * Average monthly spend per portal across the whole schedule — the Settings
 * summary's figure. Not used to cost a period: portalEconomics does that from
 * the recorded months themselves.
 */
export function avgMonthlySpend(portal: string): number {
  const s = PORTAL_SPEND[portal];
  if (!s) return 0;
  const vals = Object.values(s);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

/** Average monthly spend summed over every portal. */
export function avgMonthlySpendTotal(): number {
  return Object.keys(PORTAL_SPEND).reduce((s, p) => s + avgMonthlySpend(p), 0);
}

const daysIn = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();

/**
 * The fraction of month `m` ("YYYY-MM") inside [from, to], both inclusive
 * YYYY-MM-DD. Spend used to be charged per calendar month TOUCHED, so "Last 30
 * days" (20 Sep – 19 Oct) paid for two whole months — twice the spend — and
 * "Today" for a whole month, thirty times a day's.
 */
export function monthShare(m: string, from: string, to: string): number {
  const first = `${m}-01`;
  const last = `${m}-${String(daysIn(m)).padStart(2, "0")}`;
  const a = from > first ? from : first;
  const b = to < last ? to : last;
  return a > b ? 0 : (Date.parse(b) - Date.parse(a) + 864e5) / 864e5 / daysIn(m);
}

/** A total that is unknown when any part is: a failed query reads "—", not a smaller number. */
export const sumOrNull = (xs: (number | null | undefined)[]): number | null =>
  xs.some((x) => x == null) ? null : xs.reduce<number>((s, x) => s + (x as number), 0);

/** The part of a portals payload the economics read. Structural, so this file stays free of server imports. */
export interface PortalSeries {
  from: string;
  to: string;
  months: string[];
  portals: string[];
  side: string;
  brand: string;
  leadsByMonth: Record<string, (number | null)[]>;
  dealsByMonth: Record<string, (number | null)[]>;
  commByMonth: Record<string, (number | null)[]>;
}

export interface CostLine {
  portal: string;
  /** Spend per month of cover: the override, else the recorded figures over the days covered. */
  rate: number | null;
  /** Recorded spend inside the range, each month pro-rated by day. */
  spend: number | null;
  /** Leads, deals and commission in the months with recorded spend — the other side of every ratio. */
  leads: number | null;
  deals: number | null;
  commission: number | null;
  cpl: number | null;
  cpd: number | null;
  net: number | null;
  roas: number | null;
}

export interface PortalEconomics {
  rows: CostLine[];
  total: CostLine;
  /** Months in view with recorded spend: what every cost figure covers. */
  covered: string[];
  /** Those months as a label, "Jan 2025 – Mar 2026"; "" when there are none. */
  span: string;
  /** Why the cost figures are blank, or null when they show. */
  blank: string | null;
  /** One line saying what the cost figures cover, to sit beside them. */
  note: string;
}

const ratios = (x: Omit<CostLine, "cpl" | "cpd" | "net" | "roas">): CostLine => ({
  ...x,
  cpl: x.spend != null && x.leads ? x.spend / x.leads : null,
  cpd: x.spend != null && x.deals ? x.spend / x.deals : null,
  net: x.spend != null && x.commission != null ? x.commission - x.spend : null,
  roas: x.spend && x.commission != null ? x.commission / x.spend : null,
});

/**
 * Spend, cost per lead, cost per deal, net and return on spend for a range.
 *
 * Spend is each month's RECORDED figure, pro-rated by the days of that month in
 * the range. A month the workbook doesn't cover adds nothing: filling it with
 * the average put AED 6.4M of spend nobody recorded on Apr–Oct 2026, labelled
 * actual. So every ratio divides that spend by the leads, deals and commission
 * of the SAME months, never the whole range.
 *
 * The workbook doesn't split spend by sale/leasing or brand, so under either
 * filter the spend side is blank rather than charging all of it to a slice
 * (Sale alone read AED 21,511 a deal; Prime AED 10.1M). `overrides` replaces a
 * portal's monthly figure in the recorded months.
 */
export function portalEconomics(d: PortalSeries, overrides: Record<string, number> = {}): PortalEconomics {
  const covered = d.months.filter((m) => d.portals.some((p) => PORTAL_SPEND[p]?.[m] !== undefined));
  const blank =
    d.side !== "all" || d.brand
      ? "Spend isn't split by sale/leasing or brand, so spend and cost figures show only for All, all brands."
      : covered.length
        ? null
        : "No portal spend recorded for this period.";
  const rows = d.portals.map((p) => {
    const rec = PORTAL_SPEND[p] ?? {};
    const idx = d.months.flatMap((m, i) => (rec[m] === undefined ? [] : [i]));
    const share = idx.map((i) => monthShare(d.months[i], d.from, d.to));
    const cover = share.reduce((a, b) => a + b, 0);
    const spend = blank || !cover ? null : idx.reduce((s, i, k) => s + (overrides[p] ?? rec[d.months[i]]) * share[k], 0);
    const pick = (s: Record<string, (number | null)[]>) => (idx.length ? sumOrNull(idx.map((i) => s[p]?.[i])) : null);
    return ratios({
      portal: p,
      rate: spend == null ? null : spend / cover,
      spend,
      leads: pick(d.leadsByMonth),
      deals: pick(d.dealsByMonth),
      commission: pick(d.commByMonth),
    });
  });
  const total = ratios({
    portal: "Total",
    rate: sumOrNull(rows.map((r) => r.rate)),
    spend: sumOrNull(rows.map((r) => r.spend)),
    leads: sumOrNull(rows.map((r) => r.leads)),
    deals: sumOrNull(rows.map((r) => r.deals)),
    commission: sumOrNull(rows.map((r) => r.commission)),
  });
  const part = covered.some((m) => monthShare(m, d.from, d.to) < 1) ? " Part months are pro-rated by day." : "";
  return {
    rows,
    total,
    covered,
    span: span(covered),
    blank,
    note: blank ?? `Spend recorded for ${span(covered)}; cost figures cover those months.${part}`,
  };
}
