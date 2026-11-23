// What the business pays the portals (Property Finder, Bayut, Dubizzle), in
// the figures it gave on 23 Nov 2026: thousands of AED a month. The CRM holds
// no spend, so these are typed in, at the business's request, and kept going
// by the rule in monthSpend rather than by anyone updating them.
//
// Two of the business's cost lines count: BH DXB and BH ELITE, added together.
// It asked for its other lines (the Abu Dhabi and Sharjah offices among them)
// to be left out. In the CRM the two lines match the Betterhomes and BH Elite
// divisions, on Dubai property: SPEND_DIVISIONS and SPEND_EMIRATE, which
// lib/portals.ts sets the spend against.

/** Thousands of AED a month, January first, for each year as given. */
const GIVEN_K: Record<number, { dxb: number[]; elite: number[] }> = {
  2025: {
    dxb: [588, 588, 588, 952, 809, 834, 810, 869, 919, 868, 914, 866],
    elite: [153, 153, 153, 135, 129, 211, 205, 112, 101, 132, 81, 128],
  },
  2026: {
    dxb: [918, 888, 747, 416, 391, 451, 471, 453, 497, 653],
    elite: [69, 82, 88, 62, 108, 114, 91, 112, 61, 90],
  },
};

/** The CRM divisions the spend pays for: BH DXB is the Betterhomes division's, BH ELITE the BH Elite division's. */
export const SPEND_DIVISIONS = ["Betterhomes", "BH Elite"] as const;
/** The emirate (CRM city) they cover: the Abu Dhabi and Sharjah offices have their own lines, left out. */
export const SPEND_EMIRATE = "Dubai";
/** The first month with a figure. */
export const SPEND_FROM = "2025-01";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The month whose figure a month takes: its own where given, otherwise the
 * same month of the latest year given, so November and December 2026 take
 * 2025's and 2027 takes 2026's, month by month, for good. Null before the
 * figures begin.
 */
export function spendSource(month: string): string | null {
  if (!/^\d{4}-\d{2}$/.test(month) || month < SPEND_FROM) return null;
  const y = Number(month.slice(0, 4)), m0 = Number(month.slice(5, 7)) - 1;
  const year = Object.keys(GIVEN_K)
    .map(Number)
    .filter((yr) => yr <= y && GIVEN_K[yr].dxb[m0] != null && GIVEN_K[yr].elite[m0] != null)
    .sort((a, b) => b - a)[0];
  return year == null ? null : `${year}-${pad(m0 + 1)}`;
}

/** A month's spend in AED, BH DXB and BH ELITE together, by spendSource's rule. */
export function monthSpend(month: string): number | null {
  const src = spendSource(month);
  if (!src) return null;
  const g = GIVEN_K[Number(src.slice(0, 4))], m0 = Number(src.slice(5, 7)) - 1;
  return (g.dxb[m0] + g.elite[m0]) * 1000;
}

/**
 * A month's spend within from → to (YYYY-MM-DD, both days in): the whole
 * month's, or its share by days where the range starts or ends inside it.
 */
export function spendWithin(month: string, from: string, to: string): number | null {
  const full = monthSpend(month);
  if (full == null) return null;
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const first = `${month}-01`, last = `${month}-${pad(days)}`;
  const a = from > first ? from : first, b = to < last ? to : last;
  if (a > b) return 0;
  const covered = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000 + 1;
  return (full * covered) / days;
}

/** Spend over from → to, each month whole or by its days; null when a month in it has no figure. */
export function spendBetween(from: string, to: string): number | null {
  let total = 0;
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); ) {
    const s = spendWithin(m, from, to);
    if (s == null) return null;
    total += s;
    const [y, mm] = m.split("-").map(Number);
    m = mm === 12 ? `${y + 1}-01` : `${y}-${pad(mm + 1)}`;
  }
  return total;
}
