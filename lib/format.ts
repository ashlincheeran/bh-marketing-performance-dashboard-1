// How the dashboards write figures, days and times, where every tab writes them
// the same way. Pure and with no imports, so client components and server code
// can share it.

const nf = new Intl.NumberFormat("en-US");

/** A whole number with thousands separators; NaN reads 0. */
export const fmtInt = (n: number) => nf.format(Math.round(n || 0));

/** A whole number with thousands separators, or a dash when there is none. */
export const fmt = (n: number | null | undefined) => (n == null ? "—" : nf.format(Math.round(n)));

/** A fraction as a percentage to dp places (0.123 is "12.3%"), or a dash when there is none or it isn't finite. */
export const fmtPct = (n: number | null, dp = 1) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(dp)}%`);

/** Month names as the dashboards shorten them, January first. */
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
