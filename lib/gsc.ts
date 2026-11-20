// Google Search Console (Search Analytics) — organic clicks, impressions, CTR,
// average position, and per-keyword rankings. Server-only.
//
// Auth is a Google service account (no user OAuth): sign a JWT with the account's
// private key, exchange it for an access token, then call the Search Analytics
// API. Set three env vars (all optional — missing → a graceful "not connected"):
//   GSC_SITE_URL     e.g. "sc-domain:bhomes.com"  (defaults to that)
//   GSC_CLIENT_EMAIL the service account email
//   GSC_PRIVATE_KEY  the service account private key ("\n" escapes are handled)
// The service account must be added as a user on the GSC property.
import crypto from "node:crypto";
import { getAppSettings } from "@/lib/appSettings";
import { clearNotification, notify } from "@/lib/notify";

const SITE = process.env.GSC_SITE_URL || "sc-domain:bhomes.com";

export interface GscTotals {
  clicks: number;
  impressions: number;
  ctr: number; // 0..1
  position: number; // avg position (lower = better)
}
export interface GscKeyword {
  keyword: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null; // null = not ranking / no data in range
}
export interface GscData {
  connected: boolean;
  totals: GscTotals | null;
  keywords: GscKeyword[];
  label: string;
  /** Which backend produced these figures, so the page can say so. */
  source?: "supermetrics" | "direct";
  error?: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// Cache the access token in-process for its lifetime (~1h) to avoid re-signing.
let tokenCache: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string | null> {
  const email = process.env.GSC_CLIENT_EMAIL;
  let key = process.env.GSC_PRIVATE_KEY;
  if (!email || !key) return null;
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp - 60 > now) return tokenCache.token;
  key = key.replace(/\\n/g, "\n");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: email,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    }),
  );
  const signingInput = `${header}.${claim}`;
  let signature: string;
  try {
    signature = b64url(crypto.createSign("RSA-SHA256").update(signingInput).sign(key));
  } catch {
    return null; // malformed private key
  }
  const jwt = `${signingInput}.${signature}`;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`[gsc] token HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    const j = await res.json();
    if (!j?.access_token) return null;
    tokenCache = { token: j.access_token as string, exp: now + Number(j.expires_in || 3600) };
    return tokenCache.token;
  } catch (e) {
    console.error(`[gsc] token error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function gscQuery(body: Record<string, unknown>): Promise<any | null> {
  const token = await accessToken();
  if (!token) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: ctrl.signal,
      },
    );
    if (!res.ok) {
      console.error(`[gsc] searchAnalytics HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error(`[gsc] searchAnalytics error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Organic totals + per-keyword rankings. Two interchangeable backends:
 *   • Supermetrics Data Fetching API — used when SUPERMETRICS_API_KEY is set
 *     (no Google Cloud setup; GSC is already authorized inside Supermetrics).
 *   • Google service account — used otherwise (GSC_CLIENT_EMAIL/PRIVATE_KEY).
 */
/**
 * Ask with `top` (and no keywords) for the period's top non-brand searches by
 * clicks, live; with keywords for those searches' figures (the period before).
 */
export interface GscOptions {
  top?: number;
}

/**
 * A search for the brand: "betterhomes", "better homes", "bhomes". Search
 * Console lower-cases every query, so "better homes" counts here too, while
 * Better Homes & Gardens, another company, does not. Written for RE2, which
 * is what the API's query filter takes, so the brand split Google adds up and
 * the top searches this leaves out follow one rule.
 */
export const BRAND_QUERY = "betterhomes?|better homes|bhomes";
const NOT_BRAND_QUERY = "gardens?";
const brandRe = new RegExp(BRAND_QUERY), notBrandRe = new RegExp(NOT_BRAND_QUERY);
/** A search for the brand itself: it would fill the top searches at position 1, telling nothing. */
export const isBrandSearch = (q: string) => brandRe.test(q.toLowerCase()) && !notBrandRe.test(q.toLowerCase());

/** The top non-brand searches by clicks among `rows`, as keywords. */
function topSearches<R>(rows: R[], query: (r: R) => string, clicks: (r: R) => number, n: number): R[] {
  return rows
    .filter((r) => query(r) && !isBrandSearch(query(r)))
    .sort((a, b) => clicks(b) - clicks(a) || query(a).localeCompare(query(b)))
    .slice(0, n);
}

export async function getGscMetrics(from: string, to: string, targetKeywords: string[] = [], opts: GscOptions = {}): Promise<GscData> {
  const settings = await getAppSettings();

  /**
   * "direct" chosen in Settings: use Google's API, and only Google's API.
   *
   * No fallback to Supermetrics when the credentials are missing. The reason to
   * choose direct is to stop spending the shared row quota, so quietly routing
   * back through Supermetrics would spend it anyway while the setting claimed
   * otherwise. An honest "not connected" is the right failure here.
   */
  if (settings.seoSource === "direct") {
    const direct = await getGscViaServiceAccount(from, to, targetKeywords, opts);
    if (!direct.connected) {
      return {
        ...direct,
        error:
          "Settings is set to read Search Console directly, but GSC_CLIENT_EMAIL / GSC_PRIVATE_KEY " +
          "are not set. Add them in Vercel, or switch the SEO source back to Supermetrics.",
      };
    }
    return { ...direct, source: "direct" };
  }

  // "supermetrics": as before. When an admin switches Supermetrics off
  // globally, take the branch this function always had for deployments with no
  // Supermetrics key — the direct client — so the kill switch still spends
  // nothing.
  if (process.env.SUPERMETRICS_API_KEY && settings.supermetricsEnabled) {
    return { ...(await getGscViaSupermetrics(from, to, targetKeywords, opts)), source: "supermetrics" };
  }
  return { ...(await getGscViaServiceAccount(from, to, targetKeywords, opts)), source: "direct" };
}

async function getGscViaServiceAccount(from: string, to: string, targetKeywords: string[] = [], opts: GscOptions = {}): Promise<GscData> {
  const connected = !!(process.env.GSC_CLIENT_EMAIL && process.env.GSC_PRIVATE_KEY);
  const base: GscData = { connected, totals: null, keywords: [], label: `${from} → ${to}` };
  if (!connected) return base;
  // An empty window, `to` before `from`: days Search Console has not published
  // yet (searchConsoleRange). Nothing to ask; totals stay null, not zero.
  if (from > to) return base;

  /**
   * Web search only, stated rather than inherited.
   *
   * The API defaults to web, but this figure is compared against the monthly
   * SEO report and against Search Console's own Performance screen — both web —
   * so it should not depend on a default Google could change. For August 2026
   * web gives 15,036 clicks and a 13.4 average position, the report's method
   * exactly. Supermetrics adds image, video, news and Discover on top, which is
   * why it read 15,471.
   */
  const web = { type: "web", dataState: "all" };

  /**
   * The tracked keywords in ONE filtered request, not 5,000 rows to find them.
   *
   * RE2 regex, anchored, so each keyword matches only itself. Verified against
   * the live property: all 14 returned in a single call. Keywords are
   * lowercased because Search Console stores queries that way, and a failed
   * filtered call falls back to the old unfiltered pull rather than blanking
   * the rankings table.
   */
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const kwRegex = `^(${targetKeywords.map((k) => esc(k.trim().toLowerCase())).join("|")})$`;

  const top = !targetKeywords.length && opts.top ? opts.top : 0;
  const [totalsRes, kwFiltered, topRes] = await Promise.all([
    gscQuery({ startDate: from, endDate: to, dimensions: [], ...web }),
    targetKeywords.length
      ? gscQuery({
          startDate: from,
          endDate: to,
          dimensions: ["query"],
          rowLimit: 1000,
          ...web,
          dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "includingRegex", expression: kwRegex }] }],
        })
      : Promise.resolve(null),
    // The top searches: Search Console returns them by clicks; enough rows to leave the brand ones out.
    top ? gscQuery({ startDate: from, endDate: to, dimensions: ["query"], rowLimit: 250, ...web }) : Promise.resolve(null),
  ]);
  const kwRes =
    targetKeywords.length && !kwFiltered
      ? await gscQuery({ startDate: from, endDate: to, dimensions: ["query"], rowLimit: 5000, ...web })
      : kwFiltered;

  const row = totalsRes?.rows?.[0];
  if (!totalsRes) base.error = `GSC auth or query failed — check GSC_CLIENT_EMAIL / GSC_PRIVATE_KEY and that the service account is a user on ${SITE}.`;
  // A failed call leaves totals null: zeros read as "0 clicks, −100%" beside the failure banner.
  base.totals = !totalsRes
    ? null
    : row
      ? { clicks: row.clicks || 0, impressions: row.impressions || 0, ctr: row.ctr || 0, position: row.position || 0 }
      : { clicks: 0, impressions: 0, ctr: 0, position: 0 };

  if (top) {
    base.keywords = topSearches(topRes?.rows ?? [], (r: any) => String(r.keys?.[0] || "").toLowerCase(), (r: any) => r.clicks || 0, top).map((r: any) => ({
      keyword: String(r.keys?.[0] || "").toLowerCase(),
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: r.ctr || 0,
      position: Math.round((r.position || 0) * 10) / 10,
    }));
  }

  if (targetKeywords.length) {
    const byQ = new Map<string, any>();
    for (const r of kwRes?.rows ?? []) byQ.set(String(r.keys?.[0] || "").toLowerCase(), r);
    base.keywords = targetKeywords.map((k) => {
      const r = byQ.get(k.trim().toLowerCase());
      return {
        keyword: k,
        clicks: r?.clicks || 0,
        impressions: r?.impressions || 0,
        ctr: r?.ctr || 0,
        position: r ? Math.round((r.position || 0) * 10) / 10 : null,
      };
    });
  }
  return base;
}

// ── Supermetrics Data Fetching API backend ──────────────────────
// Uses your Supermetrics API key so GSC is pulled through Supermetrics (which
// already has the property authorized) instead of a Google service account.
//   SUPERMETRICS_API_KEY   the Data Fetching API key (hub.supermetrics.com)
//   SUPERMETRICS_DS_USER   the Supermetrics login that authorized GSC
//                          (defaults to zahra.firouzi@bhomes.com)
//   GSC_SITE_URL           the GSC account/site (defaults to sc-domain:bhomes.com)
//   SUPERMETRICS_API_URL   override the endpoint if your plan differs
const SM_ENDPOINT = process.env.SUPERMETRICS_API_URL || "https://api.supermetrics.com/enterprise/v2/query/data/json";

function smNum(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : 0;
}
const smCtr = (v: number) => (v > 1 ? v / 100 : v); // normalize % → fraction

// Supermetrics /data/json returns a 2-D array with a header row first.
function smSplit(rows: any[][] | null): { header: string[]; data: any[][] } {
  if (!rows || !rows.length) return { header: [], data: [] };
  const first = rows[0].map((x) => String(x).toLowerCase());
  const isHeader = first.some((s) => s.includes("click") || s.includes("impress") || s.includes("query") || s.includes("search") || s.includes("position") || s.includes("ctr"));
  return isHeader ? { header: rows[0].map(String), data: rows.slice(1) } : { header: [], data: rows };
}
function smIdx(header: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  header.forEach((h, i) => {
    const s = String(h).toLowerCase();
    if (idx.query === undefined && (s.includes("query") || s.includes("search"))) idx.query = i;
    if (idx.clicks === undefined && s.includes("click")) idx.clicks = i;
    if (idx.impressions === undefined && s.includes("impress")) idx.impressions = i;
    if (idx.ctr === undefined && s.includes("ctr")) idx.ctr = i;
    if (idx.position === undefined && s.includes("position")) idx.position = i;
  });
  return idx;
}

/** Last failure from smQuery, so the card can show the reason instead of a guess. */
let smLastError: string | null = null;

async function smQuery(fields: string[], from: string, to: string, maxRows: number): Promise<any[][] | null> {
  const key = process.env.SUPERMETRICS_API_KEY;
  if (!key) return null;
  // Documented v2 method: POST JSON with `Authorization: Bearer <key>`, fields as
  // a comma-separated string. (The api_key is NOT put in the body.)
  const payload: Record<string, unknown> = {
    ds_id: "GW",
    ds_accounts: [process.env.GSC_SITE_URL || "sc-domain:bhomes.com"],
    ds_user: process.env.SUPERMETRICS_DS_USER || "zahra.firouzi@bhomes.com",
    date_range_type: "custom",
    start_date: from,
    end_date: to,
    fields: fields.join(","),
    max_rows: maxRows,
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(SM_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      // 500 chars: Supermetrics states the actual row-quota numbers in the
      // description, and a shorter slice cuts the message off just before them.
      smLastError = `HTTP ${res.status}: ${text.slice(0, 500)}`;
      console.error(`[gsc/supermetrics] ${smLastError}`);
      return null;
    }
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      smLastError = `non-JSON response: ${text.slice(0, 160)}`;
      console.error(`[gsc/supermetrics] ${smLastError}`);
      return null;
    }
    if (j?.error) {
      const m = typeof j.error === "string" ? j.error : j.error?.message || JSON.stringify(j.error);
      smLastError = String(m).slice(0, 400);
      console.error(`[gsc/supermetrics] API error: ${smLastError}`);
      return null;
    }
    // Envelope is usually { data: [[header],[row]…] }; tolerate { data: { data: [...] } }.
    let rows: any = j?.data;
    if (rows && !Array.isArray(rows) && Array.isArray(rows.data)) rows = rows.data;
    return Array.isArray(rows) ? rows : null;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    smLastError = m;
    console.error(`[gsc/supermetrics] error: ${smLastError}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function getGscViaSupermetrics(from: string, to: string, targetKeywords: string[] = [], opts: GscOptions = {}): Promise<GscData> {
  const base: GscData = { connected: true, totals: null, keywords: [], label: `${from} → ${to}` };
  // Days not published yet (see getGscViaServiceAccount): no call, no rows spent.
  if (from > to) return base;
  const top = !targetKeywords.length && opts.top ? opts.top : 0;
  const [totRows, kwRows] = await Promise.all([
    smQuery(["clicks", "impressions", "ctr", "position"], from, to, 1),
    targetKeywords.length || top ? smQuery(["query", "clicks", "impressions", "ctr", "position"], from, to, 5000) : Promise.resolve(null),
  ]);

  // Report what actually failed. The previous text guessed at three causes and
  // led with the API key, which sent readers to check a key that was fine — the
  // real answer was a row quota, and only the raw message said so.
  if (!totRows) {
    base.error = smLastError ? `GSC via Supermetrics failed: ${smLastError}` : "Supermetrics returned no GSC data.";
    const quota = /quota|429/i.test(smLastError ?? "");
    void notify(
      quota ? "error" : "warning",
      "search console",
      quota ? "Supermetrics row quota exhausted" : "Search Console data unavailable",
      base.error,
      // Shares the quota key with the ad platforms: it is one limit, so it
      // should read as one problem rather than two unrelated ones.
      quota ? "supermetrics:quota" : "gsc:failed",
    );
  } else {
    void clearNotification("gsc:failed");
  }
  const tot = smSplit(totRows);
  if (tot.data.length) {
    const i = tot.header.length ? smIdx(tot.header) : { clicks: 0, impressions: 1, ctr: 2, position: 3 };
    const r = tot.data[tot.data.length - 1];
    base.totals = {
      clicks: smNum(r[i.clicks ?? 0]),
      impressions: smNum(r[i.impressions ?? 1]),
      ctr: smCtr(smNum(r[i.ctr ?? 2])),
      position: smNum(r[i.position ?? 3]),
    };
  } else {
    // Answered with no rows is zero; not answered at all is unknown.
    base.totals = totRows ? { clicks: 0, impressions: 0, ctr: 0, position: 0 } : null;
  }

  if (top) {
    const kw = smSplit(kwRows);
    const i = kw.header.length ? smIdx(kw.header) : { query: 0, clicks: 1, impressions: 2, ctr: 3, position: 4 };
    base.keywords = topSearches(kw.data, (r) => String(r[i.query ?? 0] ?? "").toLowerCase(), (r) => smNum(r[i.clicks ?? 1]), top).map((r) => ({
      keyword: String(r[i.query ?? 0] ?? "").toLowerCase(),
      clicks: smNum(r[i.clicks ?? 1]),
      impressions: smNum(r[i.impressions ?? 2]),
      ctr: smCtr(smNum(r[i.ctr ?? 3])),
      position: Math.round(smNum(r[i.position ?? 4]) * 10) / 10,
    }));
  }

  if (targetKeywords.length) {
    const kw = smSplit(kwRows);
    const i = kw.header.length ? smIdx(kw.header) : { query: 0, clicks: 1, impressions: 2, ctr: 3, position: 4 };
    const byQ = new Map<string, { clicks: number; impressions: number; ctr: number; position: number }>();
    for (const r of kw.data) {
      const q = String(r[i.query ?? 0] ?? "").toLowerCase();
      if (!q) continue;
      byQ.set(q, {
        clicks: smNum(r[i.clicks ?? 1]),
        impressions: smNum(r[i.impressions ?? 2]),
        ctr: smCtr(smNum(r[i.ctr ?? 3])),
        position: smNum(r[i.position ?? 4]),
      });
    }
    base.keywords = targetKeywords.map((k) => {
      const r = byQ.get(k.trim().toLowerCase());
      return {
        keyword: k,
        clicks: r?.clicks || 0,
        impressions: r?.impressions || 0,
        ctr: r?.ctr || 0,
        position: r ? Math.round((r.position || 0) * 10) / 10 : null,
      };
    });
  }
  return base;
}

// ── Month by month: the SEO tab's year ──────────────────────────────────────

/** One month of Google search for bhomes.com. */
export interface SearchMonth {
  month: string; // YYYY-MM
  clicks: number;
  impressions: number;
  /** Average position, weighted by impressions as Search Console weights it; null with no impressions. */
  position: number | null;
  /** The part of it from searches for the brand (isBrandSearch); null where only the totals could be read. */
  brandClicks: number | null;
  brandImpressions: number | null;
}

export interface SearchMonthly {
  connected: boolean;
  source: "direct" | "supermetrics";
  /** One per month asked, in order; null where Search Console did not answer for it. */
  months: (SearchMonth | null)[];
  error?: string;
}

/**
 * Days as Search Console reports them, added up by month. A day's average
 * position times its impressions is that day's positions summed, so weighting
 * by impressions gives exactly the month's own average position.
 */
export function addUpDays(
  rows: { date: string; clicks: number; impressions: number; position: number }[],
): Map<string, { clicks: number; impressions: number; position: number | null }> {
  const acc = new Map<string, { clicks: number; impressions: number; weighted: number }>();
  for (const r of rows) {
    const m = r.date.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) continue;
    const a = acc.get(m) ?? { clicks: 0, impressions: 0, weighted: 0 };
    a.clicks += r.clicks;
    a.impressions += r.impressions;
    a.weighted += r.position * r.impressions;
    acc.set(m, a);
  }
  return new Map(
    [...acc].map(([m, a]) => [m, { clicks: a.clicks, impressions: a.impressions, position: a.impressions ? Math.round((a.weighted / a.impressions) * 10) / 10 : null }]),
  );
}

/**
 * Clicks, impressions and position month by month, with the part from brand
 * searches. Read straight from Google: two calls for the whole year, every
 * day and then every day's brand searches, added up here.
 *
 * With Settings on Supermetrics, each month's totals come through the same
 * one-row question this site has always asked it, and the brand split, which
 * would mean pulling every search, is left out.
 */
export async function getSearchMonthly(months: { month: string; from: string; to: string }[]): Promise<SearchMonthly> {
  const settings = await getAppSettings();
  if (settings.seoSource !== "direct" && process.env.SUPERMETRICS_API_KEY && settings.supermetricsEnabled) {
    const got = await Promise.all(months.map((m) => getGscViaSupermetrics(m.from, m.to)));
    return {
      connected: true,
      source: "supermetrics",
      months: got.map((g, i) =>
        g.totals
          ? {
              month: months[i].month,
              clicks: g.totals.clicks,
              impressions: g.totals.impressions,
              position: g.totals.impressions ? g.totals.position : null,
              brandClicks: null,
              brandImpressions: null,
            }
          : null,
      ),
      error: got.find((g) => g.error)?.error,
    };
  }

  const connected = !!(process.env.GSC_CLIENT_EMAIL && process.env.GSC_PRIVATE_KEY);
  const none = months.map(() => null);
  if (!connected) {
    return {
      connected,
      source: "direct",
      months: none,
      error: settings.seoSource === "direct" ? "Settings reads Search Console directly, but GSC_CLIENT_EMAIL / GSC_PRIVATE_KEY are not set." : undefined,
    };
  }
  if (!months.length) return { connected, source: "direct", months: [] };

  const days = {
    startDate: months[0].from,
    endDate: months[months.length - 1].to,
    dimensions: ["date"],
    rowLimit: 1000,
    type: "web",
    dataState: "all",
  };
  const [all, brand] = await Promise.all([
    gscQuery(days),
    gscQuery({
      ...days,
      dimensionFilterGroups: [
        {
          groupType: "and",
          filters: [
            { dimension: "query", operator: "includingRegex", expression: BRAND_QUERY },
            { dimension: "query", operator: "excludingRegex", expression: NOT_BRAND_QUERY },
          ],
        },
      ],
    }),
  ]);
  if (!all) {
    return { connected, source: "direct", months: none, error: `GSC auth or query failed — check GSC_CLIENT_EMAIL / GSC_PRIVATE_KEY and that the service account is a user on ${SITE}.` };
  }
  const rowsOf = (res: any) =>
    (res?.rows ?? []).map((r: any) => ({
      date: String(r.keys?.[0] ?? ""),
      clicks: Number(r.clicks) || 0,
      impressions: Number(r.impressions) || 0,
      position: Number(r.position) || 0,
    }));
  const totals = addUpDays(rowsOf(all));
  const branded = brand ? addUpDays(rowsOf(brand)) : null;
  return {
    connected,
    source: "direct",
    months: months.map((m) => {
      const t = totals.get(m.month) ?? { clicks: 0, impressions: 0, position: null };
      const b = branded?.get(m.month);
      return {
        month: m.month,
        ...t,
        brandClicks: branded ? (b?.clicks ?? 0) : null,
        brandImpressions: branded ? (b?.impressions ?? 0) : null,
      };
    }),
    error: brand ? undefined : "Search Console did not answer for the brand searches",
  };
}
