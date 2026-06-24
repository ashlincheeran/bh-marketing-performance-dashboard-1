// PostHog Web/SEO analytics, read via the HogQL Query API. Server-only.
//
// Needs a PostHog *personal* API key (phx_…) with Query:Read scope in
// POSTHOG_API_KEY. Project id + host default to the betterhomes project so the
// key alone is enough. No key / blocked egress / error → returns a graceful
// "not connected" shape so the page still renders.
//
// Bot handling: PostHog tags obvious bots via $virt_is_bot, but sophisticated
// headless-Chrome crawlers (e.g. the AWS us-east-1 / "Ashburn" traffic that
// dominated this site) spoof normal user agents and slip past it. So we treat a
// hit as automated if $virt_is_bot is true OR it comes from a known cloud
// datacenter city. "Humans only" (the default) excludes those.
const HOST = process.env.POSTHOG_HOST || "https://us.posthog.com";
const PROJECT = process.env.POSTHOG_PROJECT_ID || "198002";

// High-confidence pure-datacenter cities (AWS/GCP regions). Kept tight to avoid
// dropping real users — Ashburn (AWS us-east-1) alone was ~92% of bogus US hits.
const DATACENTER_CITIES = ["Ashburn", "Boardman", "Council Bluffs", "The Dalles"];

const SEARCH_ENGINES = ["google.", "bing.", "yahoo.", "duckduckgo.", "ecosia.", "yandex.", "baidu.", "brave."];

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

export interface FlowNode { id: string; label: string; col: number; value: number; kind: string }
export interface FlowLink { source: string; target: string; value: number }
export interface FlowData { nodes: FlowNode[]; links: FlowLink[]; sessions: number }

export interface WebMetrics {
  connected: boolean; // is a PostHog key configured
  hasData: boolean; // did we get any $pageview rows (incl. bots)
  humansOnly: boolean; // is the bot filter applied
  days: number;
  label: string; // human range label
  overview: { pageviews: number; visitors: number; sessions: number; organic: number } | null;
  bots: { pageviews: number; pct: number }; // automated traffic detected in range
  trend: { day: string; pageviews: number; visitors: number }[];
  topPages: { path: string; views: number }[];
  sources: { source: string; sessions: number }[];
  countries: { country: string; visitors: number }[];
  flow: FlowData; // Channel → Landing → outcome touchpoint flow
}

// Touchpoint flow: per session, classify the entry channel + landing page, and
// whether they browsed on or bounced. Aggregated into Sankey nodes + links.
async function getUserFlow(since: string, human: string): Promise<FlowData> {
  const rows = await hogql(
    `SELECT channel, landing, outcome, count() AS sessions FROM (` +
      `SELECT multiIf(ref = '', 'Direct', ` +
      `ref LIKE '%google.%' OR ref LIKE '%bing.%' OR ref LIKE '%yahoo.%' OR ref LIKE '%duckduckgo.%' OR ref LIKE '%ecosia.%', 'Organic Search', ` +
      `ref LIKE '%facebook.%' OR ref LIKE '%instagram.%' OR ref LIKE '%linkedin.%' OR ref LIKE '%t.co%' OR ref LIKE '%youtube.%' OR ref LIKE '%tiktok.%', 'Social', ` +
      `'Referral') AS channel, landing, if(pv > 1, 'Browsed 2+ pages', 'Bounced') AS outcome FROM (` +
      `SELECT properties.$session_id AS sid, argMin(coalesce(properties.$referring_domain, ''), timestamp) AS ref, ` +
      `argMin(coalesce(nullif(properties.$pathname, ''), '/'), timestamp) AS landing, count() AS pv ` +
      `FROM events WHERE event = '$pageview' AND ${since}${human} AND properties.$session_id != '' GROUP BY sid)` +
      `) GROUP BY channel, landing, outcome ORDER BY sessions DESC LIMIT 300`,
  );
  if (!rows || !rows.length) return { nodes: [], links: [], sessions: 0 };

  const data = rows.map((r) => ({ channel: String(r[0] || "Referral"), landing: String(r[1] || "/"), outcome: String(r[2] || "Bounced"), sessions: Number(r[3] || 0) }));
  const sessions = data.reduce((a, b) => a + b.sessions, 0);

  // keep the top 6 landing pages, bucket the rest as "Other pages"
  const landingTotals = new Map<string, number>();
  for (const d of data) landingTotals.set(d.landing, (landingTotals.get(d.landing) ?? 0) + d.sessions);
  const top = new Set([...landingTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map((e) => e[0]));
  const landOf = (l: string) => (top.has(l) ? l : "Other pages");

  const cl = new Map<string, number>(), lo = new Map<string, number>();
  const chanV = new Map<string, number>(), landV = new Map<string, number>(), outV = new Map<string, number>();
  for (const d of data) {
    const land = landOf(d.landing);
    cl.set(`${d.channel}|||${land}`, (cl.get(`${d.channel}|||${land}`) ?? 0) + d.sessions);
    lo.set(`${land}|||${d.outcome}`, (lo.get(`${land}|||${d.outcome}`) ?? 0) + d.sessions);
    chanV.set(d.channel, (chanV.get(d.channel) ?? 0) + d.sessions);
    landV.set(land, (landV.get(land) ?? 0) + d.sessions);
    outV.set(d.outcome, (outV.get(d.outcome) ?? 0) + d.sessions);
  }

  const nodes: FlowNode[] = [];
  for (const [c, v] of [...chanV].sort((a, b) => b[1] - a[1])) nodes.push({ id: `c:${c}`, label: c, col: 0, value: v, kind: `channel:${c}` });
  for (const [l, v] of [...landV].sort((a, b) => b[1] - a[1])) nodes.push({ id: `l:${l}`, label: l, col: 1, value: v, kind: "landing" });
  for (const [o, v] of [...outV].sort((a, b) => b[1] - a[1])) nodes.push({ id: `o:${o}`, label: o, col: 2, value: v, kind: `outcome:${o}` });

  const links: FlowLink[] = [];
  for (const [k, v] of cl) { const [c, l] = k.split("|||"); links.push({ source: `c:${c}`, target: `l:${l}`, value: v }); }
  for (const [k, v] of lo) { const [l, o] = k.split("|||"); links.push({ source: `l:${l}`, target: `o:${o}`, value: v }); }

  return { nodes, links, sessions };
}

const isDate = (s?: string): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

export async function getWebMetrics(daysRaw = 30, fromRaw?: string, toRaw?: string, humansOnly = true): Promise<WebMetrics> {
  const from = isDate(fromRaw);
  const to = isDate(toRaw);
  let days = Math.max(1, Math.min(365, Math.round(daysRaw || 30)));
  let since: string;
  let label: string;
  if (from && to && from <= to) {
    since = `timestamp >= toDateTime('${from} 00:00:00') AND timestamp <= toDateTime('${to} 23:59:59')`;
    label = `${from} → ${to}`;
    days = Math.max(1, Math.min(366, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1));
  } else {
    since = `timestamp >= now() - INTERVAL ${days} DAY`;
    label = `last ${days} days`;
  }

  const key = process.env.POSTHOG_API_KEY;
  const base: WebMetrics = { connected: !!key, hasData: false, humansOnly, days, label, overview: null, bots: { pageviews: 0, pct: 0 }, trend: [], topPages: [], sources: [], countries: [], flow: { nodes: [], links: [], sessions: 0 } };
  if (!key) return base;

  const pv = `event = '$pageview'`;
  const dc = DATACENTER_CITIES.map((c) => `'${c}'`).join(", ");
  // A hit is "automated" if PostHog flagged it, OR it's from a cloud datacenter
  // city, OR it runs desktop Linux. Real consumers are ~98% Windows/Mac/iOS/
  // Android; near-100%-Linux traffic (the China / Singapore / Hong Kong /
  // Netherlands server traffic, each ~1.0 pageviews/session) is bots/crawlers.
  const botExpr = `(coalesce(properties.$virt_is_bot, false) = true OR properties.$geoip_city_name IN (${dc}) OR properties.$os = 'Linux')`;
  const human = humansOnly ? ` AND NOT ${botExpr}` : "";
  const organic = SEARCH_ENGINES.map((e) => `properties.$referring_domain LIKE '%${e}%'`).join(" OR ");

  const [ov, tr, tp, sr, co, fl] = await Promise.all([
    hogql(
      `SELECT count() AS all_pv, count(DISTINCT person_id) AS all_vis, count(DISTINCT properties.$session_id) AS all_sess, ` +
        `count(DISTINCT if(${organic}, properties.$session_id, NULL)) AS all_org, ` +
        `countIf(NOT ${botExpr}) AS h_pv, count(DISTINCT if(NOT ${botExpr}, person_id, NULL)) AS h_vis, ` +
        `count(DISTINCT if(NOT ${botExpr}, properties.$session_id, NULL)) AS h_sess, ` +
        `count(DISTINCT if(NOT ${botExpr} AND (${organic}), properties.$session_id, NULL)) AS h_org, ` +
        `countIf(${botExpr}) AS bot_pv ` +
        `FROM events WHERE ${pv} AND ${since}`,
    ),
    hogql(`SELECT toDate(timestamp) AS day, count() AS pageviews, count(DISTINCT person_id) AS visitors FROM events WHERE ${pv} AND ${since}${human} GROUP BY day ORDER BY day`),
    hogql(`SELECT properties.$pathname AS path, count() AS views FROM events WHERE ${pv} AND ${since}${human} AND properties.$pathname != '' GROUP BY path ORDER BY views DESC LIMIT 12`),
    hogql(`SELECT coalesce(nullif(properties.$referring_domain, ''), 'Direct / none') AS source, count(DISTINCT properties.$session_id) AS sessions FROM events WHERE ${pv} AND ${since}${human} GROUP BY source ORDER BY sessions DESC LIMIT 10`),
    hogql(`SELECT properties.$geoip_country_name AS country, count(DISTINCT person_id) AS visitors FROM events WHERE ${pv} AND ${since}${human} AND properties.$geoip_country_name != '' GROUP BY country ORDER BY visitors DESC LIMIT 10`),
    getUserFlow(since, human),
  ]);

  const row = ov && ov[0];
  const all = row ? { pageviews: Number(row[0] || 0), visitors: Number(row[1] || 0), sessions: Number(row[2] || 0), organic: Number(row[3] || 0) } : null;
  const humans = row ? { pageviews: Number(row[4] || 0), visitors: Number(row[5] || 0), sessions: Number(row[6] || 0), organic: Number(row[7] || 0) } : null;
  const botPv = row ? Number(row[8] || 0) : 0;
  const overview = humansOnly ? humans : all;
  const botPct = all && all.pageviews ? Math.round((botPv / all.pageviews) * 100) : 0;

  return {
    connected: true,
    hasData: !!(all && all.pageviews > 0),
    humansOnly,
    days,
    label,
    overview,
    bots: { pageviews: botPv, pct: botPct },
    trend: (tr ?? []).map((r) => ({ day: String(r[0]), pageviews: Number(r[1] || 0), visitors: Number(r[2] || 0) })),
    topPages: (tp ?? []).map((r) => ({ path: String(r[0] || "/"), views: Number(r[1] || 0) })),
    sources: (sr ?? []).map((r) => ({ source: String(r[0] || "Direct / none"), sessions: Number(r[1] || 0) })),
    countries: (co ?? []).map((r) => ({ country: String(r[0] || "—"), visitors: Number(r[1] || 0) })),
    flow: fl ?? { nodes: [], links: [], sessions: 0 },
  };
}
