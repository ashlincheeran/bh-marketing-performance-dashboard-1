// Reading a value whose shape isn't known: a database column, a server
// action's argument, a field of parsed JSON, or whatever was thrown. Pure and
// with no imports, so the browser can use it as well as the server
// (lib/news/companyChange.ts runs in both).

/** Its fields when the value is an object other than an array, else {}. */
export const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Text as one line with single spaces, or "" for anything that isn't text. */
export const oneLine = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** What was thrown, as text: an Error's message, or the thrown value written out. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
