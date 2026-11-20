// Arithmetic and wording for the SEO tab (components/SeoDashboard.tsx). Pure,
// so it can be tested, and so every figure and sentence on the tab is worked
// out from the live series rather than typed in.

export type Num = number | null | undefined;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Aug" for 2026-08. */
export const monShort = (m: string) => MON[Number(m.slice(5, 7)) - 1] ?? m;
/** "August" for 2026-08. */
export const monLong = (m: string) => MONTH[Number(m.slice(5, 7)) - 1] ?? m;

/** A run of months as the report writes it: "Aug–Oct 2026", "Nov 2025 – Jan 2026", "October 2026". */
export function monthSpan(first: string, last: string): string {
  if (first === last) return `${monLong(first)} ${first.slice(0, 4)}`;
  if (first.slice(0, 4) === last.slice(0, 4)) return `${monShort(first)}–${monShort(last)} ${last.slice(0, 4)}`;
  return `${monShort(first)} ${first.slice(0, 4)} – ${monShort(last)} ${last.slice(0, 4)}`;
}

/** The total of `xs`, or null when any is missing: a sum short of a month must not pass for a whole one. */
export function total(xs: Num[]): number | null {
  let t = 0;
  for (const x of xs) {
    if (x == null || !Number.isFinite(x)) return null;
    t += x;
  }
  return t;
}

/** Fractional change from `before` to `now`; null when either is missing or `before` is zero. */
export function change(now: Num, before: Num): number | null {
  if (now == null || before == null || !Number.isFinite(now) || !Number.isFinite(before) || before === 0) return null;
  return (now - before) / before;
}

/** The last three of twelve months (the quarter) and the three before them (its comparison). */
export function quarterPair<T>(xs: T[]): { now: T[]; before: T[] } {
  return { now: xs.slice(-3), before: xs.slice(-6, -3) };
}

/** A running total; null from the first missing month on. */
export function cumulative(xs: Num[]): (number | null)[] {
  let t: number | null = 0;
  return xs.map((x) => (t = t == null || x == null ? null : t + x));
}

/** Several months' average position, weighted by impressions as Search Console weights it. */
export function weightedPosition(rows: ({ position: number | null; impressions: number } | null | undefined)[]): number | null {
  let weighted = 0, impressions = 0;
  for (const r of rows) {
    if (!r || r.position == null || !r.impressions) continue;
    weighted += r.position * r.impressions;
    impressions += r.impressions;
  }
  return impressions ? weighted / impressions : null;
}

/** "▲ 3.5%" or "▼ 16%": one decimal under 10%, whole numbers above. */
export function pctText(c: number | null): string {
  if (c == null) return "—";
  const p = Math.abs(c * 100);
  return `${c > 0 ? "▲" : c < 0 ? "▼" : "■"} ${p < 10 ? p.toFixed(1).replace(/\.0$/, "") : Math.round(p)}%`;
}

/** "up 33%", "down 8%", "level". */
export function moved(c: number | null): string {
  if (c == null) return "with nothing to compare";
  const p = Math.abs(c * 100);
  if (p < 0.5) return "level";
  return `${c > 0 ? "up" : "down"} ${p < 10 ? p.toFixed(1).replace(/\.0$/, "") : Math.round(p)}%`;
}

/** Whole numbers with thousands separators. */
export const num = (n: Num) => (n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("en-GB"));

/** Compact for axes and tight spaces: 1.2M, 15K, 940. */
export function compact(n: Num): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (a >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

/** Dirhams the way the report writes them: AED 1.16M, AED 146K, AED 900. */
export function aed(n: Num): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return `AED ${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `AED ${Math.round(n / 1e3)}K`;
  return `AED ${Math.round(n)}`;
}

/** A share as a percentage: 0.062 → "6.2%". */
export function share(n: Num, dp = 1): string {
  return n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(dp).replace(/\.0$/, "")}%`;
}

/** A site section's folder (lib/posthog sectionSql) in words: "home" is the Home page, "area-guides" Area guides. */
export function sectionName(key: string): string {
  if (key === "home") return "Home page";
  const words = key.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Other";
}

/** The spellings people know for the assistants that have sent visitors; any other is named as it arrived. */
const ASSISTANT_NAMES: Record<string, string> = {
  chatgpt: "ChatGPT", openai: "OpenAI", gemini: "Gemini", perplexity: "Perplexity", claude: "Claude",
  copilot: "Copilot", meta: "Meta AI", deepseek: "DeepSeek", grok: "Grok", mistral: "Mistral",
};

/** An assistant's name from its key (lib/aiSource.ts) and the names it arrived under, most used first. */
export function assistantName(key: string, arrivedAs: string[] = []): string {
  if (ASSISTANT_NAMES[key]) return ASSISTANT_NAMES[key];
  const seen = arrivedAs[0] || key;
  return seen ? seen[0].toUpperCase() + seen.slice(1) : "Other";
}

/** Keys of a set of counts, largest first, with the total of each across months. */
export function ranked(perMonth: (Record<string, number> | null | undefined)[]): { key: string; total: number }[] {
  const acc = new Map<string, number>();
  for (const m of perMonth) for (const [k, v] of Object.entries(m ?? {})) acc.set(k, (acc.get(k) ?? 0) + v);
  return [...acc].map(([key, t]) => ({ key, total: t })).sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

/** Counts added up across months: the quarter's landing sections, its news sites. */
export function addCounts(perMonth: (Record<string, number> | null | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of perMonth) for (const [k, v] of Object.entries(m ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
}
