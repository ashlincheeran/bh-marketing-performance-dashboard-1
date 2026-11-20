// How live the figures are. Pure and with no imports, so the server (lib/cache.ts,
// the API routes) and the screens (components/useLiveRefresh.ts) share one
// definition.
//
// A tab shows its remembered answer at once, then asks the source again for an
// answer at most LIVE_MS old ("?live=1") and swaps it in, and keeps asking every
// POLL_MS while it is open in front of someone.

/** The oldest a live answer may be. Older, the source is asked again before answering. */
export const LIVE_MS = 60_000;

/** How often an open tab asks for the latest figures. */
export const POLL_MS = 5 * 60_000;

/** True when an answer worked out at `cachedAt` is older than a live one may be. No time (worked out just now, not kept) is never old. */
export function isOld(cachedAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!cachedAt) return false;
  const at = Date.parse(cachedAt);
  return Number.isFinite(at) && !(now - at < LIVE_MS);
}

/** `url` asking for a live answer. */
export function liveUrl(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}live=1`;
}

/** Whether a request asked for a live answer. */
export function wantsLive(searchParams: URLSearchParams): boolean {
  return searchParams.get("live") === "1";
}
