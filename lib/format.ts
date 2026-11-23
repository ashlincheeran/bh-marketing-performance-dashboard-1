// How the dashboards write figures, days and times, where every tab writes them
// the same way. Pure and with no imports, so client components and server code
// can share it.

const nf = new Intl.NumberFormat("en-US");

/** A whole number with thousands separators; NaN reads 0, and a figure that is missing (null) a dash. */
export const fmtInt = (n: number | null | undefined) => (n == null ? "—" : nf.format(Math.round(n || 0)));

/** A whole number with thousands separators, or a dash when there is none. */
export const fmt = (n: number | null | undefined) => (n == null ? "—" : nf.format(Math.round(n)));

/** A fraction as a percentage to dp places (0.123 is "12.3%"), or a dash when there is none or it isn't finite. */
export const fmtPct = (n: number | null, dp = 1) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(dp)}%`);

/** One decimal place, "5.0", or a dash when there is none: the Portals tab's "per 100 leads". */
export const fmt1 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(1));

/** A share in whole percent, and "<1%" for a sliver rather than a "0%" that is not nothing. */
export const sharePct = (x: number) => (x > 0 && x < 0.005 ? "<1%" : fmtPct(x, 0));

/**
 * Dirhams scaled for a figure: "AED 1.20B", "AED 111.5M", "AED 4.24M", "AED 603K",
 * "AED 495"; a dash when there is none. Millions keep two decimals under ten,
 * one from ten up.
 */
export function fmtAED(n: number | null | undefined): string {
  if (n == null) return "—";
  const a = Math.abs(n || 0);
  if (a >= 1e9) return `AED ${((n || 0) / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `AED ${((n || 0) / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `AED ${Math.round((n || 0) / 1e3)}K`;
  return `AED ${Math.round(n || 0)}`;
}

/** Dirhams scaled for a chart's axis or a tight cell: whole millions from ten ("AED 24M"), one decimal under ("AED 4.2M"). */
export function fmtAEDShort(n: number): string {
  const a = Math.abs(n || 0);
  if (a >= 1e6) return `AED ${((n || 0) / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `AED ${Math.round((n || 0) / 1e3)}K`;
  return `AED ${Math.round(n || 0)}`;
}

/** Exact dirhams, for a per-unit figure where "K" would hide the number: "AED 3,651"; a dash when there is none. */
export const fmtAEDExact = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `AED ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n)}`;

/** fmtAED's scaling in whichever currency an account bills in: "USD 12K". */
export const fmtMoney = (n: number, currency: string) => fmtAED(n).replace(/^AED/, currency);

/** The sum, or null when any part is missing: a failed figure stays "—" in a total, never a smaller number. */
export const sumOrNull = (xs: (number | null | undefined)[]): number | null =>
  xs.some((x) => x == null) ? null : xs.reduce<number>((s, x) => s + (x as number), 0);

/** Month names as the dashboards shorten them, January first. */
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06" as "Jun 2026". */
export const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

/** "2026-06" as "Jun 26", for a chart's axis. */
export const monthShort = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym.slice(5, 7)} ${ym.slice(2, 4)}`;

/** "2026-06-22", or an ISO time on that day, as "22 Jun": the day without its year. */
export const dayMonth = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

/** "2026-06-22", or an ISO time on that day, as "22 Jun 2026". */
export const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

/** How long ago an ISO time was: "just now", "5m ago", "3h ago" or "2d ago". */
export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
