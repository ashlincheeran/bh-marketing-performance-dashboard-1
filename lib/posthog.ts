// PostHog Web/SEO analytics, read via the HogQL Query API. Server-only.
//
// Needs a PostHog *personal* API key (phx_…) with Query:Read scope in
// POSTHOG_API_KEY. Project id + host default to the betterhomes project so the
// key alone is enough. No key / blocked egress / error → returns a graceful
// "not connected" shape so the page still renders.
const HOST = process.env.POSTHOG_HOST || "https://us.posthog.com";
const PROJECT = process.env.POSTHOG_PROJECT_ID || "198002";

async function hogql(sql: string): Promise<any[][] | null> {
  const key = process.env.POSTHOG_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${HOST.replace(/\/$/, "")}/api/projects/${PROJECT}/query/`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql } }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.results) ? data.results : [];
  } catch {
    return null;
  }
}

export interface WebMetrics {
  connected: boolean; // is a PostHog key configured
  hasData: boolean; // did we get any $pageview rows
  days: number;
  overview: { pageviews: number; visitors: number; sessions: number; organic: number } | null;
  trend: { day: string; pageviews: number; visitors: number }[];
  topPages: { path: string; views: number }[];
  sources: { source: string; sessions: number }[];
  countries: { country: string; visitors: number }[];
}

const SEARCH_ENGINES = ["google.", "bing.", "yahoo.", "duckduckgo.", "ecosia.", "yandex.", "baidu.", "brave."];

export async function getWebMetrics(daysRaw = 30): Promise<WebMetrics> {
  const days = Math.max(1, Math.min(365, Math.round(daysRaw || 30)));
  const key = process.env.POSTHOG_API_KEY;
  const base: WebMetrics = { connected: !!key, hasData: false, days, overview: null, trend: [], topPages: [], sources: [], countries: [] };
  if (!key) return base;

  const since = `timestamp >= now() - INTERVAL ${days} DAY`;
  const pv = `event = '$pageview'`;
  const organicWhen = SEARCH_ENGINES.map((e) => `properties.$referring_domain LIKE '%${e}%'`).join(" OR ");

  const [ov, tr, tp, sr, co] = await Promise.all([
    hogql(
      `SELECT count() AS pageviews, count(DISTINCT person_id) AS visitors, ` +
        `count(DISTINCT properties.$session_id) AS sessions, ` +
        `count(DISTINCT if(${organicWhen}, properties.$session_id, NULL)) AS organic ` +
        `FROM events WHERE ${pv} AND ${since}`,
    ),
    hogql(
      `SELECT toDate(timestamp) AS day, count() AS pageviews, count(DISTINCT person_id) AS visitors ` +
        `FROM events WHERE ${pv} AND ${since} GROUP BY day ORDER BY day`,
    ),
    hogql(
      `SELECT properties.$pathname AS path, count() AS views ` +
        `FROM events WHERE ${pv} AND ${since} AND properties.$pathname != '' GROUP BY path ORDER BY views DESC LIMIT 12`,
    ),
    hogql(
      `SELECT coalesce(nullif(properties.$referring_domain, ''), 'Direct / none') AS source, ` +
        `count(DISTINCT properties.$session_id) AS sessions ` +
        `FROM events WHERE ${pv} AND ${since} GROUP BY source ORDER BY sessions DESC LIMIT 10`,
    ),
    hogql(
      `SELECT properties.$geoip_country_name AS country, count(DISTINCT person_id) AS visitors ` +
        `FROM events WHERE ${pv} AND ${since} AND properties.$geoip_country_name != '' GROUP BY country ORDER BY visitors DESC LIMIT 10`,
    ),
  ]);

  const overview = ov && ov[0]
    ? { pageviews: Number(ov[0][0] || 0), visitors: Number(ov[0][1] || 0), sessions: Number(ov[0][2] || 0), organic: Number(ov[0][3] || 0) }
    : null;

  const out: WebMetrics = {
    connected: true,
    hasData: !!(overview && overview.pageviews > 0),
    days,
    overview,
    trend: (tr ?? []).map((r) => ({ day: String(r[0]), pageviews: Number(r[1] || 0), visitors: Number(r[2] || 0) })),
    topPages: (tp ?? []).map((r) => ({ path: String(r[0] || "/"), views: Number(r[1] || 0) })),
    sources: (sr ?? []).map((r) => ({ source: String(r[0] || "Direct / none"), sessions: Number(r[1] || 0) })),
    countries: (co ?? []).map((r) => ({ country: String(r[0] || "—"), visitors: Number(r[1] || 0) })),
  };
  return out;
}
