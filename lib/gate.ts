// Shared PIN-gate helpers for the two access levels.
//
// Kept tiny and dependency free, on Web Crypto alone, so the same code runs in
// proxy.ts and in every route and server action that checks the cookies,
// whichever runtime Next gives each of them.

/** Which door is being opened. */
export type Scope = "app" | "settings";

/**
 * The PINs. Overridable per deployment.
 *
 * Two levels on purpose: the app PIN stops idle tabs spending API quota, while
 * the settings PIN protects values that change everyone's numbers — portal
 * spend feeds cost per deal, and the ad-account list drives how much quota a
 * single page load consumes.
 */
export const PINS: Record<Scope, string> = {
  app: process.env.DASHBOARD_PIN || "1986",
  settings: process.env.SETTINGS_PIN || "2000",
};

export const COOKIES: Record<Scope, string> = {
  app: "bh_gate",
  settings: "bh_gate_settings",
};

export const isScope = (v: unknown): v is Scope => v === "app" || v === "settings";

/**
 * How long a gate cookie is good for, in seconds: 12 hours for the app, 1 hour
 * for settings.
 *
 * Checked on the server, against the time signed into the cookie. The
 * cookie's maxAge only tells the browser when to drop its own copy, so without
 * this a copy taken from an unlocked browser would work for as long as the PIN
 * stayed the same. Settings is shorter because it is an occasional
 * administrative act, and a long lived cookie on a shared machine is the
 * likelier way it leaks.
 */
export const MAX_AGE: Record<Scope, number> = { app: 12 * 3600, settings: 3600 };

/** A cookie signed up to a minute "in the future" still counts, in case two servers' clocks differ a little. */
const CLOCK_SKEW_S = 60;

/**
 * The key both cookies are signed with: SESSION_SECRET, or CRON_SECRET where
 * SESSION_SECRET is not set yet, so a deployment set up before it existed
 * keeps its logins.
 *
 * The fixed key is for local development only. Anyone who can read this file
 * knows it, and with a known key every PIN can be tried against the proxy,
 * which counts no attempts. So in production with neither secret set there is
 * no key at all, and no cookie is issued or accepted.
 */
function signingKey(): string | null {
  const key = process.env.SESSION_SECRET || process.env.CRON_SECRET;
  if (key) return key;
  return process.env.NODE_ENV === "production" ? null : "bh-gate-fallback";
}

/** Whether this server has a key to sign the gate cookies with. */
export const canSignCookies = (): boolean => signingKey() !== null;

const toHex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

async function hmac(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

/** What a cookie's signature covers. The issue time is signed exactly as it is written in the cookie. */
const signed = (scope: Scope, issued: string) => `${scope}|${PINS[scope]}|${issued}`;

/**
 * A new cookie value for this scope: the time it was issued, in whole
 * seconds, then an HMAC of the scope, its PIN and that time, as
 * "1762340000.<64 hex>".
 *
 * Deliberately NOT the PIN itself: a cookie holding "1986" could be set by hand
 * by anyone who guessed the scheme, making the gate decorative. The scope is
 * signed in so an app cookie cannot be replayed as a settings cookie, the PIN
 * so that changing a PIN signs everyone out of that door, and the time so a
 * copied cookie stops working once its scope's MAX_AGE has passed.
 */
export async function issueToken(scope: Scope, now = Date.now()): Promise<string> {
  const key = signingKey();
  if (!key) throw new Error("There is no key to sign the PIN cookies with: set SESSION_SECRET");
  const issued = String(Math.floor(now / 1000));
  return `${issued}.${await hmac(key, signed(scope, issued))}`;
}

/** Whether `token` is a cookie this server issued for `scope`, and is still inside that scope's MAX_AGE. */
export async function tokenValid(scope: Scope, token: string | null | undefined, now = Date.now()): Promise<boolean> {
  const key = signingKey();
  const parts = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(token ?? "");
  if (!key || !parts) return false;
  const age = Math.floor(now / 1000) - Number(parts[1]);
  if (age > MAX_AGE[scope] || age < -CLOCK_SKEW_S) return false;
  return safeEqual(parts[2], await hmac(key, signed(scope, parts[1])));
}

/** The part of a cookie store these helpers read. NextRequest's cookies and next/headers' cookies() both have it. */
export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/** Whether the request's cookies hold a valid gate cookie for this scope. */
export function hasGateCookie(cookies: CookieReader, scope: Scope, now = Date.now()): Promise<boolean> {
  return tokenValid(scope, cookies.get(COOKIES[scope])?.value, now);
}

/**
 * Whether a request may start paid work run by hand: with "Authorization:
 * Bearer $CRON_SECRET" from a script, or with both PIN cookies from a browser.
 *
 * Spending money is a settings-level act, and a browser sends the app cookie
 * (SameSite=Lax) on a link followed from another site, so the app PIN alone is
 * never enough. Routes using this check it themselves, because proxy.ts only
 * knows the cookies.
 */
export async function cronOrBothPins(
  req: { headers: { get(name: string): string | null }; cookies: CookieReader },
  now = Date.now(),
): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret && safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return true;
  return (await hasGateCookie(req.cookies, "app", now)) && (await hasGateCookie(req.cookies, "settings", now));
}

/** Constant-time-ish compare, so a token can't be probed byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
