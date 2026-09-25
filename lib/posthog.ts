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

/**
 * A hit is "automated" if PostHog flagged it, OR it came from a cloud datacenter
 * city, OR it runs desktop Linux. Real consumers are ~98% Windows/Mac/iOS/
 * Android, so near-100%-Linux traffic (the China / Singapore / Hong Kong /
 * Netherlands server traffic, each ~1.0 pageviews/session) is crawlers.
 *
 * Defined once and shared by the Website and SEO tabs. It used to be written out
 * twice, which is how the two would eventually disagree about what a bot is
 * while both claiming to filter them.
 */
const BOT_EXPR = `(coalesce(properties.$virt_is_bot, false) = true OR properties.$geoip_city_name IN (${DATACENTER_CITIES.map((c) => `'${c}'`).join(", ")}) OR properties.$os = 'Linux')`;

const SEARCH_ENGINES = ["google.", "bing.", "yahoo.", "duckduckgo.", "ecosia.", "yandex.", "baidu.", "brave."];

/**
 * PostHog's query API runs at most THREE queries at a time per project, and
 * answers a fourth with 429 "Too many queries are running right now" (its docs:
 * also 240 a minute, and 10 s of execution each). The SEO tab asks about twenty
 * questions per load. Fired all at once, PostHog refused most of them, and each
 * refusal came back as an empty card that read exactly like a quiet month.
 *
 * So every query queues here and runs three at a time. A refusal — the
 * allowance is shared with every other tab and server instance — waits and
 * asks again rather than giving up. Slower when PostHog is busy, but complete.
 */
const MAX_CONCURRENT = Math.max(1, Number(process.env.POSTHOG_MAX_CONCURRENCY || 3));
/** Longest one question may take, queueing and retries included, before it is reported as not loaded. */
const QUERY_BUDGET_MS = Number(process.env.POSTHOG_BUDGET_MS || 240_000);
let inFlight = 0;
const waiting: (() => void)[] = [];
/** A slot is handed straight to the next in line on release, so the queue stays first come, first served. */
function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}
const release = () => {
  const next = waiting.shift();
  if (next) next();
  else inFlight--;
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hogql(sql: string, timeoutMs = Number(process.env.POSTHOG_TIMEOUT_MS || 15000)): Promise<any[][] | null> {
  const key = process.env.POSTHOG_API_KEY;
  if (!key) return null;
  const deadline = Date.now() + QUERY_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    await acquire();
    let wait = 0;
    let why = "";
    // The timeout starts when the query does, not while it waits in line.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${HOST.replace(/\/$/, "")}/api/projects/${PROJECT}/query/`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql } }),
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (res.ok) {
        const data = await res.json();
        return Array.isArray(data?.results) ? data.results : [];
      }
      const body = (await res.text().catch(() => "")).slice(0, 200);
      // 429 is PostHog saying "not now": always worth waiting for. A 5xx is
      // worth a couple more tries. Anything else is a bad query, and asking
      // again would only get the same answer.
      if (res.status === 429 || (res.status >= 500 && attempt < 3)) {
        const after = Number(res.headers.get("retry-after"));
        wait = after > 0 ? after * 1000 : Math.min(10_000, 1000 * 2 ** (attempt - 1));
        why = `HTTP ${res.status}`;
      } else {
        console.error(`[posthog] query HTTP ${res.status}: ${body}`);
        return null;
      }
    } catch (e) {
      // A timeout or dropped connection: once more, in case it was contention.
      if (attempt < 2) {
        wait = 1000;
        why = e instanceof Error ? e.message : String(e);
      } else {
        console.error(`[posthog] query error: ${e instanceof Error ? e.message : String(e)} — ${sql.slice(0, 120)}`);
        return null;
      }
    } finally {
      clearTimeout(t);
      release();
    }
    // Jitter, so queries refused together don't all come back together.
    wait = Math.round(wait * (0.75 + Math.random() * 0.5));
    if (Date.now() + wait >= deadline) {
      console.error(`[posthog] gave up after ${attempt} tries (${why}) — ${sql.slice(0, 120)}`);
      return null;
    }
    await pause(wait);
  }
}

export interface FlowNode { id: string; label: string; col: number; value: number; kind: string; breakdown?: { label: string; value: number }[] }
export interface FlowLink { source: string; target: string; value: number }
export interface FlowData { nodes: FlowNode[]; links: FlowLink[]; sessions: number }

export interface WebMetrics {
  connected: boolean; // is a PostHog key configured
  hasData: boolean; // did we get any $pageview rows (incl. bots)
  humansOnly: boolean; // is the bot filter applied
  days: number;
  label: string; // human range label
  from: string; // resolved range start, YYYY-MM-DD — seeds the client date pickers
  to: string; // resolved range end, YYYY-MM-DD
  generatedAt: string; // when PostHog was queried, ISO — the "updated" stamp
  overview: { pageviews: number; visitors: number; sessions: number; organic: number } | null;
  bots: { pageviews: number; pct: number }; // automated traffic detected in range
  trend: { day: string; pageviews: number; visitors: number }[];
  topPages: { path: string; views: number }[];
  sources: { source: string; sessions: number }[];
  countries: { country: string; visitors: number }[];
  flow: FlowData; // Channel → Landing → outcome touchpoint flow
}

// Group a raw path into a page category, so the flow clubs the many individual
// URLs into a handful of meaningful buckets (Buy listings, Blog, etc.). '' means
// the session had no pageview at that step (they'd left) — we emit no node for it.
function pageBucket(e: string): string {
  return (
    `multiIf(${e} = '', '', ` +
    `${e} = '/' OR ${e} = '/en' OR ${e} = '/en/' OR ${e} = '/ar' OR ${e} = '/ar/', 'Home', ` +
    `${e} LIKE '%/buy%', 'Buy listings', ` +
    `${e} LIKE '%/rent%', 'Rent listings', ` +
    `${e} LIKE '%/commercial%', 'Commercial', ` +
    `${e} LIKE '%/blog%' AND (${e} LIKE '%market%' OR ${e} LIKE '%report%'), 'Blog: Market reports', ` +
    `${e} LIKE '%/blog%', 'Blog', ` +
    `${e} LIKE '%/area-guide%', 'Area guides', ` +
    `${e} LIKE '%/developer%', 'Developers', ` +
    `${e} LIKE '%/branch%', 'Branches', ` +
    `${e} LIKE '%/agent%' OR ${e} LIKE '%/team%', 'Agents', ` +
    `'Other')`
  );
}

// Page-journey flow: per session, the entry source (channel) then the first 3
// pages (bucketed), shown as Source → 1st → 2nd → 3rd page. Drop-off is implied
// — a session with fewer pages simply has no further link (no "Exit" node).
// Optional pageFilter keeps only sessions whose path sequence touches a substring.
async function getUserFlow(since: string, human: string, pageFilter?: string[], exact = false): Promise<FlowData> {
  let filterWhere = "";
  if (pageFilter && pageFilter.length) {
    // Accept a bare slug ("buy"), a path ("/en/buy"), or a full page URL pasted
    // from the breakdown ("https://www.bhomes.com/betterhomes-mobile-app"): drop
    // the protocol, keep host + path chars. Multiple entries are OR-ed together.
    //  • contains (default): substring match against the host+path array
    //  • exact: the visited path OR host+path equals the term
    const terms = pageFilter
      .map((t) => t.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9/_.-]/g, ""))
      .filter(Boolean);
    if (terms.length) {
      const clause = exact
        ? (t: string) => `(arrayExists(p -> p = '${t}', paths) OR arrayExists(p -> p = '${t}', fullpaths))`
        : (t: string) => `arrayExists(p -> p LIKE '%${t}%', fullpaths)`;
      filterWhere = ` WHERE ${terms.map(clause).join(" OR ")}`;
    }
  }
  // Entry-source classification. Order matters (first match wins):
  //  • Direct — no referrer ('' or PostHog's '$direct' sentinel) or a self-referral (bhomes.com)
  //  • AI Assistant — ChatGPT/Perplexity/Claude/Gemini/Copilot (checked before Organic so gemini.google → AI)
  //  • Organic Search — search engines
  //  • Social — checked with an EXACT t.co match (avoids '%t.co%' catching chatgpt.com / trustpilot.com)
  //  • Referral — anything else (a link on another site)
  const chan =
    `multiIf(` +
    `ref = '' OR ref = '$direct' OR ref LIKE '%bhomes.com%', 'Direct', ` +
    `ref LIKE '%chatgpt.%' OR ref LIKE '%openai.%' OR ref LIKE '%perplexity.%' OR ref LIKE '%claude.%' OR ref LIKE '%gemini.google%' OR ref LIKE '%copilot.%', 'AI Assistant', ` +
    `ref LIKE '%google.%' OR ref LIKE '%bing.%' OR ref LIKE '%yahoo.%' OR ref LIKE '%duckduckgo.%' OR ref LIKE '%ecosia.%' OR ref LIKE '%yandex.%' OR ref LIKE '%baidu.%' OR ref LIKE '%brave.%', 'Organic Search', ` +
    `ref LIKE '%facebook.%' OR ref LIKE '%instagram.%' OR ref LIKE '%linkedin.%' OR ref = 't.co' OR ref LIKE '%youtube.%' OR ref LIKE '%tiktok.%', 'Social', ` +
    `'Referral')`;
  // one row per session: entry referrer + ordered page paths. The heavier
  // host+path array (fullpaths) is built ONLY when a page filter needs it — on a
  // normal load we don't pay for it.
  const fullpathsSel = filterWhere
    ? `, arrayMap(x -> x.2, arraySort(x -> x.1, groupArray((timestamp, lower(concat(coalesce(properties.$host, ''), coalesce(nullif(properties.$pathname, ''), '/'))))))) AS fullpaths `
    : ` `;
  const innerSessions =
    `SELECT argMin(coalesce(properties.$referring_domain, ''), timestamp) AS ref, ` +
    `arrayMap(x -> x.2, arraySort(x -> x.1, groupArray((timestamp, lower(coalesce(nullif(properties.$pathname, ''), '/')))))) AS paths` +
    fullpathsSel +
    `FROM events WHERE event = '$pageview' AND ${since}${human} AND properties.$session_id != '' GROUP BY properties.$session_id`;
  const [rows, bdRows, pageBdRows] = await Promise.all([
    hogql(
      `SELECT ${chan} AS channel, ${pageBucket("arrayElement(paths, 1)")} AS b1, ${pageBucket("arrayElement(paths, 2)")} AS b2, ${pageBucket("arrayElement(paths, 3)")} AS b3, count() AS sessions ` +
        `FROM (${innerSessions})${filterWhere} GROUP BY channel, b1, b2, b3 ORDER BY sessions DESC LIMIT 500`,
    ),
    hogql(
      `SELECT ${chan} AS channel, if(ref = '' OR ref = '$direct', '(direct)', ref) AS domain, count() AS sessions ` +
        `FROM (${innerSessions})${filterWhere} GROUP BY channel, domain ORDER BY sessions DESC LIMIT 300`,
    ),
    // per-bucket page composition (host + path) so a page node can show exactly
    // which real pages — across subdomains like survey./promo. — make it up.
    hogql(
      `SELECT ${pageBucket("path")} AS bucket, concat(host, path) AS page, count() AS views ` +
        `FROM (SELECT lower(coalesce(nullif(properties.$pathname, ''), '/')) AS path, coalesce(properties.$host, '') AS host ` +
        `FROM events WHERE event = '$pageview' AND ${since}${human}) GROUP BY bucket, page ORDER BY views DESC LIMIT 2000`,
    ),
  ]);
  if (!rows || !rows.length) return { nodes: [], links: [], sessions: 0 };

  const data = rows.map((r) => ({ channel: String(r[0] || "Referral"), b1: String(r[1] || ""), b2: String(r[2] || ""), b3: String(r[3] || ""), sessions: Number(r[4] || 0) }));
  const sessions = data.reduce((a, b) => a + b.sessions, 0);

  // top 5 page categories across the page steps; the rest fold into "Other"
  const catTot = new Map<string, number>();
  for (const d of data) for (const c of [d.b1, d.b2, d.b3]) if (c) catTot.set(c, (catTot.get(c) ?? 0) + d.sessions);
  const top = new Set([...catTot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map((e) => e[0]));
  const cat = (c: string) => (!c ? "" : top.has(c) ? c : "Other");

  const l01 = new Map<string, number>(), l12 = new Map<string, number>(), l23 = new Map<string, number>();
  const v0 = new Map<string, number>(), v1 = new Map<string, number>(), v2 = new Map<string, number>(), v3 = new Map<string, number>();
  for (const d of data) {
    const ch = d.channel, p1 = cat(d.b1), p2 = cat(d.b2), p3 = cat(d.b3);
    if (!p1) continue;
    v0.set(ch, (v0.get(ch) ?? 0) + d.sessions);
    v1.set(p1, (v1.get(p1) ?? 0) + d.sessions);
    l01.set(`${ch}|||${p1}`, (l01.get(`${ch}|||${p1}`) ?? 0) + d.sessions);
    if (p2) {
      v2.set(p2, (v2.get(p2) ?? 0) + d.sessions);
      l12.set(`${p1}|||${p2}`, (l12.get(`${p1}|||${p2}`) ?? 0) + d.sessions);
      if (p3) {
        v3.set(p3, (v3.get(p3) ?? 0) + d.sessions);
        l23.set(`${p2}|||${p3}`, (l23.get(`${p2}|||${p3}`) ?? 0) + d.sessions);
      }
    }
  }

  const nodes: FlowNode[] = [];
  const mk = (m: Map<string, number>, col: number) => {
    for (const [label, value] of [...m].sort((a, b) => b[1] - a[1])) nodes.push({ id: `${col}:${label}`, label, col, value, kind: col === 0 ? "source" : "page" });
  };
  mk(v0, 0); mk(v1, 1); mk(v2, 2); mk(v3, 3);

  // per-source domain breakdown → attach to the entry-source (col 0) nodes so the
  // UI can show "how many from each domain" on hover and expand it on click.
  const byChannel = new Map<string, { label: string; value: number }[]>();
  for (const r of bdRows ?? []) {
    const ch = String(r[0] || "Referral");
    const arr = byChannel.get(ch) ?? [];
    arr.push({ label: String(r[1] || "(unknown)"), value: Number(r[2] || 0) });
    byChannel.set(ch, arr);
  }
  const foldTop = (arr: { label: string; value: number }[]) => {
    const sorted = [...arr].sort((a, b) => b.value - a.value);
    if (sorted.length <= 12) return sorted;
    const rest = sorted.slice(12).reduce((a, b) => a + b.value, 0);
    return rest > 0 ? [...sorted.slice(0, 12), { label: `+${sorted.length - 12} more`, value: rest }] : sorted.slice(0, 12);
  };
  for (const n of nodes) if (n.col === 0) n.breakdown = foldTop(byChannel.get(n.label) ?? []);

  // per-bucket PAGE breakdown (host + path) → attach to the page nodes (col ≥ 1).
  // Remap each raw page-type through the SAME top-5 fold the flow uses (cat), so a
  // node like "Other" lists the pages from every folded-away category too, and the
  // same page is merged when two categories fold together.
  const byBucket = new Map<string, Map<string, number>>();
  for (const r of pageBdRows ?? []) {
    const folded = cat(String(r[0] || "")); // '' → skip
    if (!folded) continue;
    const page = String(r[1] || "(unknown)");
    const m = byBucket.get(folded) ?? new Map<string, number>();
    m.set(page, (m.get(page) ?? 0) + Number(r[2] || 0));
    byBucket.set(folded, m);
  }
  const foldPages = (m?: Map<string, number>) => {
    if (!m) return [];
    const arr = [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
    if (arr.length <= 40) return arr;
    const rest = arr.slice(40).reduce((a, b) => a + b.value, 0);
    return [...arr.slice(0, 40), { label: `+${arr.length - 40} more pages`, value: rest }];
  };
  for (const n of nodes) if (n.col >= 1) n.breakdown = foldPages(byBucket.get(n.label));

  const links: FlowLink[] = [];
  for (const [k, v] of l01) { const [a, b] = k.split("|||"); links.push({ source: `0:${a}`, target: `1:${b}`, value: v }); }
  for (const [k, v] of l12) { const [a, b] = k.split("|||"); links.push({ source: `1:${a}`, target: `2:${b}`, value: v }); }
  for (const [k, v] of l23) { const [a, b] = k.split("|||"); links.push({ source: `2:${a}`, target: `3:${b}`, value: v }); }

  return { nodes, links, sessions };
}

const isDate = (s?: string): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

export async function getWebMetrics(daysRaw = 30, fromRaw?: string, toRaw?: string, humansOnly = true, flowPages?: string[], flowMatch?: string): Promise<WebMetrics> {
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
  // Production website only: real hosts are the apex bhomes.com or a *.bhomes.com
  // subdomain (www, eos…). This drops the ~99 Vercel preview/staging deploys
  // (*.vercel.app) and any other non-production host that reports into this
  // PostHog project. Applied to every query below (they all interpolate ${since}),
  // including the journey flow.
  since += ` AND (lower(properties.$host) = 'bhomes.com' OR lower(properties.$host) LIKE '%.bhomes.com')`;

  // Resolve the range on the server so the client never derives dates itself —
  // a `new Date()` in a useState initialiser renders differently on server and
  // client and trips hydration.
  const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
  const resolvedTo = from && to && from <= to ? to : ymdOf(new Date());
  const resolvedFrom = from && to && from <= to ? from : ymdOf(new Date(Date.now() - (days - 1) * 864e5));

  const key = process.env.POSTHOG_API_KEY;
  const base: WebMetrics = { connected: !!key, hasData: false, humansOnly, days, label, from: resolvedFrom, to: resolvedTo, generatedAt: new Date().toISOString(), overview: null, bots: { pageviews: 0, pct: 0 }, trend: [], topPages: [], sources: [], countries: [], flow: { nodes: [], links: [], sessions: 0 } };
  if (!key) return base;

  const pv = `event = '$pageview'`;
  const botExpr = BOT_EXPR;
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
    hogql(`SELECT coalesce(nullif(nullif(properties.$referring_domain, ''), '$direct'), 'Direct / none') AS source, count(DISTINCT properties.$session_id) AS sessions FROM events WHERE ${pv} AND ${since}${human} GROUP BY source ORDER BY sessions DESC LIMIT 10`),
    hogql(`SELECT properties.$geoip_country_name AS country, count(DISTINCT person_id) AS visitors FROM events WHERE ${pv} AND ${since}${human} AND properties.$geoip_country_name != '' GROUP BY country ORDER BY visitors DESC LIMIT 10`),
    getUserFlow(since, human, flowPages, flowMatch === "exact"),
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
    from: resolvedFrom,
    to: resolvedTo,
    generatedAt: new Date().toISOString(),
    overview,
    bots: { pageviews: botPv, pct: botPct },
    trend: (tr ?? []).map((r) => ({ day: String(r[0]), pageviews: Number(r[1] || 0), visitors: Number(r[2] || 0) })),
    topPages: (tp ?? []).map((r) => ({ path: String(r[0] || "/"), views: Number(r[1] || 0) })),
    sources: (sr ?? []).map((r) => ({ source: String(r[0] || "Direct / none"), sessions: Number(r[1] || 0) })),
    countries: (co ?? []).map((r) => ({ country: String(r[0] || "—"), visitors: Number(r[1] || 0) })),
    flow: fl ?? { nodes: [], links: [], sessions: 0 },
  };
}

// ── SEO tab: traffic by channel + AI sessions (by source) + organic pageviews ──
// Same entry-source classification as the journey Sankey, but aggregated as
// per-channel pageviews & sessions (production hosts + humans only).
function channelClassify(ref: string): string {
  return (
    `multiIf(` +
    `${ref} = '' OR ${ref} = '$direct' OR ${ref} LIKE '%bhomes.com%', 'Direct', ` +
    `${ref} LIKE '%chatgpt.%' OR ${ref} LIKE '%openai.%' OR ${ref} LIKE '%perplexity.%' OR ${ref} LIKE '%claude.%' OR ${ref} LIKE '%gemini.google%' OR ${ref} LIKE '%copilot.%', 'AI Assistant', ` +
    `${ref} LIKE '%google.%' OR ${ref} LIKE '%bing.%' OR ${ref} LIKE '%yahoo.%' OR ${ref} LIKE '%duckduckgo.%' OR ${ref} LIKE '%ecosia.%' OR ${ref} LIKE '%yandex.%' OR ${ref} LIKE '%baidu.%' OR ${ref} LIKE '%brave.%', 'Organic Search', ` +
    `${ref} LIKE '%facebook.%' OR ${ref} LIKE '%instagram.%' OR ${ref} LIKE '%linkedin.%' OR ${ref} = 't.co' OR ${ref} LIKE '%youtube.%' OR ${ref} LIKE '%tiktok.%', 'Social', ` +
    `'Referral')`
  );
}

export interface SeoTraffic {
  connected: boolean;
  label: string;
  totalPageviews: number;
  organicPageviews: number;
  aiSessions: number;
  totalSessions: number;
  byChannel: { channel: string; pageviews: number; sessions: number }[];
  aiBySource: { source: string; sessions: number }[];
  /** Individual property pages ranked by views. */
  propertyViews: PropertyView[];
  /**
   * Landing pages that organic search visitors arrived on, ranked by views.
   *
   * A pageview's own `$referring_domain` is a search engine only on the entry
   * hit — internal navigation carries a bhomes.com referrer — so filtering
   * pageviews that way yields entry pages by construction. That is exactly what
   * a landing page is, which is why this needs no per-session pass.
   */
  organicPages: OrganicPage[];
  /** byChannel came from entry-level attribution, not the per-session pass. */
  approxChannels?: boolean;
  error?: string;
}

export interface PropertyView {
  /** e.g. bh-s-289607 */
  slug: string;
  path: string;
  /** Read off the slug: bh-s-… is for sale, bh-r-… is to rent. */
  kind: "buy" | "rent" | "other";
  views: number;
  visitors: number;
}

export interface OrganicPage {
  path: string;
  /** Key from PAGE_SECTIONS below. */
  category: string;
  views: number;
  visitors: number;
}

/**
 * Landing-page sections, matched against the path in order — first hit wins.
 *
 * Derived from what bhomes.com actually serves, not guessed: the site uses
 * /en/sales/… and /en/rentals/… rather than /buy/ and /rent/, so those are the
 * primary rules and the /buy…, for-sale, off-plan variants are there to catch
 * URL shapes that may appear later. The two prefix rules (blog, area guides)
 * come first deliberately, so a blog post about property management is filed as
 * a blog post rather than by the topic word in its slug.
 */
/**
 * Site sections, matched against the path in order — first hit wins.
 *
 * Declared as data rather than as test functions so the SAME rules produce both
 * the JavaScript matcher and the HogQL expression. "By site section" used to be
 * summed in JS from the top 60 pages only, which covered 29,838 of 51,894
 * August pageviews — 42% of traffic missing, and property listings, being
 * long-tail, absent entirely. Classifying every pageview in the query fixes
 * that; generating both forms from one list is what keeps them from drifting.
 *
 * Home and Careers come first and are matched exactly: the SEO & AI Channel
 * report reads them as their own rows, and both used to fall through to
 * "Other". The two prefix rules (blog, area guides) come before the keyword
 * rules so a blog post about property management files as a blog post.
 */
interface SectionRule {
  key: string;
  label: string;
  exact?: string[];
  prefix?: string[];
  contains?: string[];
}
const SECTION_RULES: SectionRule[] = [
  { key: "home", label: "Home page", exact: ["/en", "/en/", "/"] },
  { key: "careers", label: "Careers", prefix: ["/en/join-our-team", "/en/careers"] },
  { key: "team", label: "Team pages", prefix: ["/en/meet-the-team"] },
  { key: "property", label: "Property listings", prefix: ["/en/property/"] },
  { key: "blog", label: "Blog", prefix: ["/en/blog/"] },
  { key: "area", label: "Area guides", prefix: ["/en/area-guides/"] },
  { key: "buildings", label: "Building guides", prefix: ["/en/buildings/"] },
  { key: "buy", label: "Buy", prefix: ["/en/sales/", "/en/buy"], contains: ["for-sale"] },
  { key: "rent", label: "Rent", prefix: ["/en/rentals/", "/en/rent"], contains: ["for-rent"] },
  { key: "list", label: "List your property", contains: ["list-your-property"] },
  { key: "valuation", label: "Valuation", contains: ["valuation"] },
  { key: "manage", label: "Property management", contains: ["property-management"] },
  { key: "newproj", label: "New projects", prefix: ["/en/developers/"], contains: ["new-project", "off-plan"] },
  { key: "commercial", label: "Commercial", contains: ["commercial", "development-sales"] },
];

const ruleMatches = (r: SectionRule, p: string) =>
  (r.exact ?? []).includes(p) ||
  (r.prefix ?? []).some((x) => p.startsWith(x)) ||
  (r.contains ?? []).some((x) => p.includes(x));

/** The same rules as a HogQL multiIf over a path expression. */
function sectionSql(pathExpr: string): string {
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const arms = SECTION_RULES.map((r) => {
    const conds = [
      ...(r.exact?.length ? [`${pathExpr} IN (${r.exact.map(q).join(", ")})`] : []),
      ...(r.prefix ?? []).map((x) => `startsWith(${pathExpr}, ${q(x)})`),
      ...(r.contains ?? []).map((x) => `position(${pathExpr}, ${q(x)}) > 0`),
    ];
    return `(${conds.join(" OR ")}), ${q(r.key)}`;
  });
  return `multiIf(${arms.join(", ")}, 'other')`;
}

export const PAGE_SECTION_LABELS: Record<string, string> = {
  ...Object.fromEntries(SECTION_RULES.map((r) => [r.key, r.label])),
  other: "Other",
};
const sectionOf = (path: string) => SECTION_RULES.find((r) => ruleMatches(r, path))?.key ?? "other";

/**
 * The KIND of page an AI visitor landed on, in the SEO & AI Channel report's
 * own groups, built over the section keys above.
 *
 * Coarser than the site sections, deliberately: for where AI answers send
 * people, a listing search is a listing search whether it is buy or rent, and
 * the one-off corporate pages (contact, our story, branches) only make sense
 * as a group. Anything without its own type is corporate.
 */
const PAGE_TYPE_OF: Record<string, string> = {
  home: "Home page",
  blog: "Blog",
  careers: "Careers",
  property: "Single property listings",
  buy: "Search & listing pages",
  rent: "Search & listing pages",
  area: "Area guides",
  newproj: "Off-plan & developers",
  manage: "Property management",
  team: "Team pages",
  buildings: "Building guides",
};
const pageTypeOf = (sectionKey: string) => PAGE_TYPE_OF[sectionKey] ?? "Other corporate";

export async function getSeoTraffic(fromRaw?: string, toRaw?: string, daysRaw = 30): Promise<SeoTraffic> {
  const key = process.env.POSTHOG_API_KEY;
  const from = isDate(fromRaw);
  const to = isDate(toRaw);
  const days = Math.max(1, Math.min(365, Math.round(daysRaw || 30)));
  let since: string;
  let label: string;
  if (from && to && from <= to) {
    since = `timestamp >= toDateTime('${from} 00:00:00') AND timestamp <= toDateTime('${to} 23:59:59')`;
    label = `${from} → ${to}`;
  } else {
    since = `timestamp >= now() - INTERVAL ${days} DAY`;
    label = `last ${days} days`;
  }
  since += ` AND (lower(properties.$host) = 'bhomes.com' OR lower(properties.$host) LIKE '%.bhomes.com')`;
  const base: SeoTraffic = { connected: !!key, label, totalPageviews: 0, organicPageviews: 0, aiSessions: 0, totalSessions: 0, byChannel: [], aiBySource: [], propertyViews: [], organicPages: [] };
  if (!key) return base;

  // Same bot definition as the Website tab — always on here (the SEO tab has no
  // humans-only toggle), so these figures are bot-filtered by construction.
  const human = ` AND NOT ${BOT_EXPR}`;
  const chan = channelClassify("ref");
  // HEAVY: one per-session pass (argMin first referrer) → channel pageviews &
  // sessions. Given extra time so a large range isn't cut off (this is the only
  // heavy scan, so it won't contend with the AI query below).
  const inner = `SELECT properties.$session_id AS sid, argMin(coalesce(properties.$referring_domain, ''), timestamp) AS ref, count() AS pv FROM events WHERE event = '$pageview' AND ${since}${human} AND properties.$session_id != '' GROUP BY sid`;
  // LIGHT: AI sessions by LLM referrer, filtered at the event level (no
  // per-session pass) — cheap and independent of the heavy query. LLM referrers
  // only appear on the entry pageview, so this ≈ first-referrer attribution.
  const aiRefEvent = `(properties.$referring_domain LIKE '%chatgpt.%' OR properties.$referring_domain LIKE '%openai.%' OR properties.$referring_domain LIKE '%perplexity.%' OR properties.$referring_domain LIKE '%claude.%' OR properties.$referring_domain LIKE '%gemini.google%' OR properties.$referring_domain LIKE '%copilot.%')`;

  const organicRef = SEARCH_ENGINES.map((e) => `properties.$referring_domain LIKE '%${e}%'`).join(" OR ");
  // Both page rankings report views alongside unique visitors. Views alone can
  // be one person reloading; the pair shows which it is, and the ratio is itself
  // informative on a property listing.
  const [chanRows, aiRows, totalRows, propRows, pageRows] = await Promise.all([
    // best-effort: per-session channel breakdown (powers the "by channel" chart)
    hogql(`SELECT ${chan} AS channel, sum(pv) AS pageviews, count() AS sessions FROM (${inner}) GROUP BY channel ORDER BY pageviews DESC`, 25000),
    // cheap: AI sessions by LLM referrer
    hogql(`SELECT properties.$referring_domain AS ref, count(DISTINCT properties.$session_id) AS sessions FROM events WHERE event = '$pageview' AND ${since}${human} AND ${aiRefEvent} GROUP BY ref ORDER BY sessions DESC LIMIT 20`),
    // cheap + GUARANTEED: headline totals in a single scan (no per-session pass),
    // so the KPIs are always populated even if the channel breakdown times out.
    hogql(`SELECT count() AS total, countIf(${organicRef}) AS organic, count(DISTINCT properties.$session_id) AS sessions FROM events WHERE event = '$pageview' AND ${since}${human}`),
    // cheap: views per individual property page. More than the five shown are
    // fetched so the buy/rent filter has rows to work with without a refetch.
    hogql(
      `SELECT properties.$pathname AS path, count() AS views, count(DISTINCT properties.$session_id) AS visitors ` +
        `FROM events WHERE event = '$pageview' AND properties.$pathname LIKE '/en/property/%' AND ${since}${human} ` +
        `GROUP BY path ORDER BY views DESC LIMIT 60`,
    ),
    // cheap: organic landing pages. The search-engine referrer restricts this to
    // entry hits on its own, so no per-session pass is needed.
    hogql(
      `SELECT properties.$pathname AS path, count() AS views, count(DISTINCT properties.$session_id) AS visitors ` +
        `FROM events WHERE event = '$pageview' AND (${organicRef}) AND ${since}${human} ` +
        `GROUP BY path ORDER BY views DESC LIMIT 80`,
    ),
  ]);

  for (const r of chanRows ?? []) {
    const ch = String(r[0] || "");
    base.byChannel.push({ channel: ch, pageviews: Number(r[1] || 0), sessions: Number(r[2] || 0) });
    if (ch === "Organic Search") base.organicPageviews = Number(r[1] || 0); // session-attributed (preferred)
  }
  base.aiBySource = (aiRows ?? []).map((r) => ({ source: String(r[0] || "(unknown)"), sessions: Number(r[1] || 0) }));

  base.propertyViews = (propRows ?? []).map((r) => {
    const path = String(r[0] || "");
    const slug = path.slice(path.lastIndexOf("/") + 1);
    return {
      slug,
      path,
      kind: slug.startsWith("bh-s-") ? "buy" : slug.startsWith("bh-r-") ? "rent" : "other",
      views: Number(r[1] || 0),
      visitors: Number(r[2] || 0),
    } satisfies PropertyView;
  });
  base.organicPages = (pageRows ?? []).map((r) => {
    const path = String(r[0] || "");
    return { path, category: sectionOf(path), views: Number(r[1] || 0), visitors: Number(r[2] || 0) } satisfies OrganicPage;
  });

  // Headline numbers come from the guaranteed cheap query (never 0 when data exists).
  const tr = totalRows?.[0];
  if (tr) {
    base.totalPageviews = Number(tr[0] || 0);
    base.totalSessions = Number(tr[2] || 0);
    if (!base.organicPageviews) base.organicPageviews = Number(tr[1] || 0); // fallback if the channel scan didn't return
  }
  const aiNode = base.byChannel.find((c) => c.channel === "AI Assistant");
  base.aiSessions = aiNode ? aiNode.sessions : base.aiBySource.reduce((a, s) => a + s.sessions, 0);

  if (!totalRows && !chanRows) {
    base.error = "PostHog traffic query failed or timed out.";
    return base;
  }

  // The per-session pass is the only heavy scan, so it times out on its own over
  // a long range while the cheap totals still succeed. That used to leave
  // byChannel empty with no error set, and the card rendered "No pageviews in
  // range" — reporting a dead query as an absence of traffic.
  //
  // Retry at entry level instead: internal navigation carries a bhomes.com
  // referrer, so excluding it leaves ≈ the entry pageview of each session. That
  // is first-touch attribution without the GROUP BY, which is the same
  // reasoning the AI-sessions query above already relies on. Counts are entries
  // rather than all pageviews, so the caller flags the chart as approximate.
  const contradiction = base.byChannel.length === 0 && base.totalPageviews > 0;
  if (!chanRows || contradiction) {
    const entryRef = `coalesce(properties.$referring_domain, '')`;
    const entryRows = await hogql(
      `SELECT ${channelClassify(entryRef)} AS channel, count() AS entries, count(DISTINCT properties.$session_id) AS sessions ` +
        `FROM events WHERE event = '$pageview' AND ${since}${human} AND NOT (${entryRef} LIKE '%bhomes.com%') ` +
        `GROUP BY channel ORDER BY entries DESC`,
    );
    if (entryRows?.length) {
      base.byChannel = entryRows.map((r) => ({ channel: String(r[0] || ""), pageviews: Number(r[1] || 0), sessions: Number(r[2] || 0) }));
      base.approxChannels = true;
      if (!base.organicPageviews) {
        base.organicPageviews = base.byChannel.find((c) => c.channel === "Organic Search")?.pageviews ?? 0;
      }
    } else {
      base.error = "Channel breakdown timed out — try a shorter range (7 or 30 days).";
    }
  }
  return base;
}

// ═══════════════════════════════════════════════════════════════════
// AI channel — the SEO & AI Channel report's data layer.
//
// The SEO tab previously measured the AI channel in SESSIONS, off the referrer
// alone. The report measures it in PEOPLE, and counts a visit as AI when the
// referrer is an assistant OR the URL carries an assistant in utm_source —
// which matters because the ChatGPT app on a phone frequently tags rather than
// referring, and phones are 65% of this channel. Sessions and people also
// diverge: 1,415 sessions came from 1,227 people in August.
//
// Everything below is per-person by default for that reason, with sessions and
// pageviews reported alongside so the ratios stay visible.
// ═══════════════════════════════════════════════════════════════════

/** The assistants, and how each is recognised in a referrer or a utm_source. */
export const ASSISTANTS: { key: string; label: string; refLike: string[]; utm: string[] }[] = [
  { key: "chatgpt", label: "ChatGPT", refLike: ["chatgpt.", "openai."], utm: ["chatgpt", "openai", "chatgpt.com"] },
  { key: "gemini", label: "Gemini", refLike: ["gemini.google"], utm: ["gemini"] },
  { key: "perplexity", label: "Perplexity", refLike: ["perplexity."], utm: ["perplexity"] },
  { key: "claude", label: "Claude", refLike: ["claude."], utm: ["claude"] },
  { key: "copilot", label: "Copilot", refLike: ["copilot."], utm: ["copilot"] },
];

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Match one assistant on either signal. */
function assistantExpr(a: (typeof ASSISTANTS)[number]): string {
  const ref = a.refLike.map((d) => `properties.$referring_domain LIKE '%${d}%'`).join(" OR ");
  const utm = `lower(coalesce(properties.utm_source, '')) IN (${a.utm.map(sqlStr).join(", ")})`;
  return `(${ref} OR ${utm})`;
}

/** Match any assistant. */
const AI_EXPR = `(${ASSISTANTS.map(assistantExpr).join(" OR ")})`;

/** Which assistant a hit belongs to, as a HogQL CASE returning the key. */
const AI_WHICH = `multiIf(${ASSISTANTS.map((a) => `${assistantExpr(a)}, ${sqlStr(a.key)}`).join(", ")}, 'other')`;

const ORGANIC_EXPR = `(${SEARCH_ENGINES.map((e) => `properties.$referring_domain LIKE '%${e}%'`).join(" OR ")})`;

export interface AssistantStat {
  key: string;
  label: string;
  visitors: number;
  sessions: number;
  pageviews: number;
  leads: number;
  topEntryPages: { path: string; visitors: number }[];
}

export interface LabelledCount {
  label: string;
  value: number;
}

export interface AiChannel {
  connected: boolean;
  label: string;
  /** Funnel, widest first. */
  pageviews: number;
  sessions: number;
  visitors: number;
  /** Context the share figures are computed against. */
  organicVisitors: number;
  /** Pageviews from search referrers — the same measure as the monthly series, for any range. */
  organicPageviews: number;
  allVisitors: number;
  allPageviews: number;
  assistants: AssistantStat[];
  entryPages: { path: string; visitors: number }[];
  distinctEntryPages: number;
  entryPagesSeenOnce: number;
  pageTypes: LabelledCount[];
  countries: LabelledCount[];
  devices: LabelledCount[];
  newVisitors: number;
  returningVisitors: number;
  /** People who fired each event, not event counts — a person can fire one twice. */
  actions: LabelledCount[];
  actionEvents: number;
  peopleActing: number;
  /**
   * Per form: people who SUBMITTED it (value) and people who OPENED it.
   *
   * Both, because the monthly report's "Forms submitted" counted opens — 145
   * for the careers form against 47 actual submissions — and the gap between
   * the two is itself the useful figure: about a third of people who open the
   * careers form send it.
   */
  forms: (LabelledCount & { opened: number })[];
  /** Whole-site context, all channels. */
  topPages: { path: string; visitors: number; views: number }[];
  /**
   * Individual property listings by views, split buy vs rent.
   *
   * Kept separate from `topPages` because listing pages are long-tailed — no
   * single one ranks highly, so they never surface in a top-pages table even
   * when the section as a whole is large. The buy/rent split is read off the
   * slug and is not derivable from anything else on the page.
   */
  propertyViews: PropertyView[];
  sections: { key: string; label: string; views: number; visitors: number }[];
  /**
   * The parts PostHog did not answer, even after queueing and retrying. Named
   * on the page, so a card left blank never passes for a quiet period.
   */
  missing: string[];
  error?: string;
}

export interface AiMonthRow {
  month: string; // YYYY-MM
  organicVisitors: number;
  organicPageviews: number;
  allPageviews: number;
  aiVisitors: number;
  byAssistant: Record<string, number>;
}

function hostFilter(): string {
  return `(lower(properties.$host) = 'bhomes.com' OR lower(properties.$host) LIKE '%.bhomes.com')`;
}

function rangeFilter(from: string, to: string): string {
  return `timestamp >= toDateTime('${from} 00:00:00') AND timestamp <= toDateTime('${to} 23:59:59')`;
}

/**
 * Everything the report needs for one month, in one call.
 *
 * Queries are issued together but each degrades on its own: a section that
 * times out comes back empty while the rest still render, rather than taking
 * the page down. The headline funnel is deliberately the cheapest query of the
 * set so it is the least likely to be the one that fails.
 */
export async function getAiChannel(from: string, to: string, opts: { detail?: boolean } = {}): Promise<AiChannel> {
  const key = process.env.POSTHOG_API_KEY;
  const label = `${from} → ${to}`;
  const base: AiChannel = {
    connected: !!key, label, pageviews: 0, sessions: 0, visitors: 0,
    organicVisitors: 0, organicPageviews: 0, allVisitors: 0, allPageviews: 0,
    assistants: [], entryPages: [], distinctEntryPages: 0, entryPagesSeenOnce: 0,
    pageTypes: [], countries: [], devices: [], newVisitors: 0, returningVisitors: 0,
    actions: [], actionEvents: 0, peopleActing: 0, forms: [], topPages: [], sections: [],
    propertyViews: [], missing: [],
  };
  if (!key) return base;

  /**
   * A comparison period needs only its headline counts — visitors, sessions,
   * pageviews, the per-assistant split and the site totals. The other eleven
   * questions would take their turn in PostHog's queue for figures no card
   * shows, so for it they are not asked.
   */
  const more = (sql: string, timeoutMs?: number) => (opts.detail === false ? Promise.resolve([] as any[][]) : hogql(sql, timeoutMs));

  const where = `${rangeFilter(from, to)} AND ${hostFilter()} AND NOT ${BOT_EXPR}`;
  const pv = `event = '$pageview' AND ${where}`;
  /** Sessions that arrived from an assistant — where "what AI visitors do" happens. */
  const aiSessions =
    `properties.$session_id IN (SELECT properties.$session_id FROM events ` +
    `WHERE ${pv} AND ${AI_EXPR} AND properties.$session_id != '')`;

  const [funnel, perAssistant, entry, geo, device, returning, actions, forms, top, all, props, secRows, acting, landing] = await Promise.all([
    // Funnel + context in one scan. Cheapest query here, and the one the KPIs need.
    hogql(
      `SELECT count() AS pageviews, count(DISTINCT properties.$session_id) AS sessions, ` +
        `count(DISTINCT person_id) AS visitors ` +
        `FROM events WHERE ${pv} AND ${AI_EXPR}`,
    ),
    hogql(
      `SELECT ${AI_WHICH} AS which, count(DISTINCT person_id) AS visitors, ` +
        `count(DISTINCT properties.$session_id) AS sessions, count() AS pageviews ` +
        `FROM events WHERE ${pv} AND ${AI_EXPR} GROUP BY which`,
    ),
    // Entry pages: the FIRST page of each AI session, one per session.
    //
    // This used to count every AI-matching pageview's path, on the reasoning
    // that an assistant referrer only appears on the arrival hit. That holds for
    // the referrer but not for utm_source, which the site carries across
    // internal links — so pages visitors moved ON to were counted as pages they
    // arrived on. Against the August report, /en/contact came out at 45 entries
    // where the true figure was 13. argMin by timestamp takes the arrival only.
    more(
      `SELECT path, which, count(DISTINCT pid) AS visitors FROM (` +
        `SELECT properties.$session_id AS sid, argMin(properties.$pathname, timestamp) AS path, ` +
        `argMin(${AI_WHICH}, timestamp) AS which, any(person_id) AS pid ` +
        `FROM events WHERE ${pv} AND ${AI_EXPR} AND properties.$session_id != '' GROUP BY sid` +
        `) GROUP BY path, which ORDER BY visitors DESC LIMIT 400`,
      25000,
    ),
    more(
      `SELECT properties.$geoip_country_name AS country, count(DISTINCT person_id) AS visitors ` +
        `FROM events WHERE ${pv} AND ${AI_EXPR} GROUP BY country ORDER BY visitors DESC LIMIT 15`,
    ),
    more(
      `SELECT properties.$device_type AS device, count(DISTINCT person_id) AS visitors ` +
        `FROM events WHERE ${pv} AND ${AI_EXPR} GROUP BY device ORDER BY visitors DESC LIMIT 6`,
    ),
    // First-time vs had-been-here-before.
    //
    // "Returning" means the person existed before this month, via any channel —
    // which is what the page's label says. It used to mean "more than one AI
    // session this month", a different question entirely, and came out at 108
    // where the report's figure is 52. person.created_at is when PostHog first
    // saw the person, so comparing it to the window start answers the right one
    // without scanning their whole history.
    more(
      `SELECT countIf(seen >= toDateTime('${from} 00:00:00')) AS fresh, ` +
        `countIf(seen < toDateTime('${from} 00:00:00')) AS repeat FROM (` +
        `SELECT person_id, min(person.created_at) AS seen ` +
        `FROM events WHERE ${pv} AND ${AI_EXPR} GROUP BY person_id)`,
      25000,
    ),
    // PEOPLE per event, within the sessions that arrived from an assistant.
    //
    // Two things were wrong before. PostHog's own `$` events — feature flag
    // checks, web vitals, page-leave — were counted as actions, so "people who
    // took an action" read 1,138 where the report has 171. And actions were
    // matched on the event's own referrer, which only holds on the landing
    // page. Scoping to AI sessions and excluding `$` events brings August to
    // click_open_form 143 / careers applications 44 / contact 12, against the
    // report's 149 / 48 / 13.
    more(
      `SELECT event, count(DISTINCT person_id) AS people, count() AS fires ` +
        `FROM events WHERE ${where} AND NOT startsWith(event, '$') AND ${aiSessions} ` +
        `GROUP BY event ORDER BY people DESC LIMIT 25`,
      25000,
    ),
    more(
      `SELECT properties.form_name AS form, ` +
        `uniqIf(person_id, event = 'click_open_form') AS opened, ` +
        `uniqIf(person_id, startsWith(event, 'lead')) AS submitted ` +
        `FROM events WHERE ${where} AND NOT startsWith(event, '$') AND properties.form_name IS NOT NULL ` +
        `AND properties.form_name != '' AND ${aiSessions} ` +
        `GROUP BY form ORDER BY opened DESC LIMIT 20`,
      25000,
    ),
    // Whole-site context, all channels.
    more(
      `SELECT properties.$pathname AS path, count(DISTINCT person_id) AS visitors, count() AS views ` +
        `FROM events WHERE ${pv} GROUP BY path ORDER BY views DESC LIMIT 60`,
    ),
    hogql(
      `SELECT count() AS pageviews, count(DISTINCT person_id) AS visitors, ` +
        `countIf(${ORGANIC_EXPR}) AS organicPv, uniqIf(person_id, ${ORGANIC_EXPR}) AS organicVisitors ` +
        `FROM events WHERE ${pv}`,
    ),
    more(
      `SELECT properties.$pathname AS path, count() AS views, count(DISTINCT person_id) AS visitors ` +
        `FROM events WHERE ${pv} AND properties.$pathname LIKE '/en/property/%' ` +
        `GROUP BY path ORDER BY views DESC LIMIT 80`,
    ),
    // Every pageview classified, not the top 60 summed.
    more(
      `SELECT ${sectionSql("properties.$pathname")} AS section, count() AS views, count(DISTINCT person_id) AS visitors ` +
        `FROM events WHERE ${pv} GROUP BY section ORDER BY views DESC`,
      25000,
    ),
    more(
      `SELECT count(DISTINCT person_id) AS people, count() AS fires ` +
        `FROM events WHERE ${where} AND NOT startsWith(event, '$') AND ${aiSessions}`,
      25000,
    ),
    // Each AI visitor once, by the section of the first page they landed on.
    more(
      `SELECT ${sectionSql("path")} AS section, count() AS people FROM (` +
        `SELECT person_id, argMin(properties.$pathname, timestamp) AS path ` +
        `FROM events WHERE ${pv} AND ${AI_EXPR} GROUP BY person_id` +
        `) GROUP BY section`,
      25000,
    ),
  ]);

  base.missing = (
    [
      ["AI totals", funnel], ["assistants", perAssistant], ["landing pages", entry], ["countries", geo],
      ["devices", device], ["first-time visitors", returning], ["actions", actions], ["forms", forms],
      ["top pages", top], ["site totals", all], ["property listings", props], ["site sections", secRows],
      ["people acting", acting], ["page types", landing],
    ] as const
  )
    .filter(([, rows]) => rows === null)
    .map(([name]) => name);

  if (!funnel && !all) {
    base.error = "PostHog AI channel query failed or timed out.";
    return base;
  }

  const f = funnel?.[0];
  if (f) {
    base.pageviews = Number(f[0] || 0);
    base.sessions = Number(f[1] || 0);
    base.visitors = Number(f[2] || 0);
  }
  const a = all?.[0];
  if (a) {
    base.allPageviews = Number(a[0] || 0);
    base.allVisitors = Number(a[1] || 0);
    base.organicPageviews = Number(a[2] || 0);
    base.organicVisitors = Number(a[3] || 0);
  }

  // Entry pages, both overall and per assistant, from one result set.
  const byPath = new Map<string, number>();
  const perAssistantPages = new Map<string, { path: string; visitors: number }[]>();
  for (const r of entry ?? []) {
    const path = String(r[0] || "");
    const which = String(r[1] || "other");
    const visitors = Number(r[2] || 0);
    if (!path) continue;
    byPath.set(path, (byPath.get(path) ?? 0) + visitors);
    const list = perAssistantPages.get(which) ?? [];
    list.push({ path, visitors });
    perAssistantPages.set(which, list);
  }
  base.entryPages = [...byPath.entries()]
    .map(([path, visitors]) => ({ path, visitors }))
    .sort((x, y) => y.visitors - x.visitors)
    .slice(0, 20);
  base.distinctEntryPages = byPath.size;
  base.entryPagesSeenOnce = [...byPath.values()].filter((v) => v === 1).length;

  // The same visitors, each ONCE, by the kind of page they first landed on.
  //
  // This used to be summed from the entry-page table, which counts a person
  // once per page they arrived on — someone who came in twice, on two pages,
  // was two people — so the groups did not add up to the visitor total the
  // card sets them against. One first landing per person does: August adds up
  // to its 1,221 visitors, with careers 219 and blog 249 — both the report's.
  const typeTotals = new Map<string, number>();
  for (const r of landing ?? []) {
    const type = pageTypeOf(String(r[0] || "other"));
    typeTotals.set(type, (typeTotals.get(type) ?? 0) + Number(r[1] || 0));
  }
  base.pageTypes = [...typeTotals.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((x, y) => y.value - x.value);

  const statFor = new Map<string, { visitors: number; sessions: number; pageviews: number }>();
  for (const r of perAssistant ?? []) {
    statFor.set(String(r[0] || "other"), {
      visitors: Number(r[1] || 0),
      sessions: Number(r[2] || 0),
      pageviews: Number(r[3] || 0),
    });
  }
  base.assistants = ASSISTANTS.map((asst) => {
    const s = statFor.get(asst.key) ?? { visitors: 0, sessions: 0, pageviews: 0 };
    return {
      key: asst.key,
      label: asst.label,
      visitors: s.visitors,
      sessions: s.sessions,
      pageviews: s.pageviews,
      leads: 0, // filled from Metabase by the caller — PostHog does not hold leads
      topEntryPages: (perAssistantPages.get(asst.key) ?? [])
        .sort((x, y) => y.visitors - x.visitors)
        .slice(0, 4),
    } satisfies AssistantStat;
  }).sort((x, y) => y.visitors - x.visitors);

  base.countries = (geo ?? [])
    .map((r) => ({ label: String(r[0] || "(unknown)"), value: Number(r[1] || 0) }))
    .filter((c) => c.value > 0);
  base.devices = (device ?? [])
    .map((r) => ({ label: String(r[0] || "(unknown)"), value: Number(r[1] || 0) }))
    .filter((c) => c.value > 0);

  const ret = returning?.[0];
  if (ret) {
    base.newVisitors = Number(ret[0] || 0);
    base.returningVisitors = Number(ret[1] || 0);
  }

  base.actions = (actions ?? []).map((r) => ({ label: String(r[0] || ""), value: Number(r[1] || 0) }));
  // Distinct people across every action, not the busiest single event — a
  // person who opened a form and then applied is one person, not two.
  base.actionEvents = Number(acting?.[0]?.[1] ?? 0);
  base.peopleActing = Number(acting?.[0]?.[0] ?? 0);
  base.forms = (forms ?? [])
    .map((r) => ({ label: String(r[0] || ""), opened: Number(r[1] || 0), value: Number(r[2] || 0) }))
    .filter((f) => f.label);

  base.topPages = (top ?? []).map((r) => ({
    path: String(r[0] || ""),
    visitors: Number(r[1] || 0),
    views: Number(r[2] || 0),
  }));

  base.propertyViews = (props ?? []).map((r) => {
    const path = String(r[0] || "");
    const slug = path.slice(path.lastIndexOf("/") + 1);
    return {
      slug,
      path,
      // bh-s-… is for sale, bh-r-… is to rent — read off the slug, as the old
      // tab did, rather than inferred from the section.
      kind: slug.startsWith("bh-s-") ? "buy" : slug.startsWith("bh-r-") ? "rent" : "other",
      views: Number(r[1] || 0),
      visitors: Number(r[2] || 0),
    } satisfies PropertyView;
  });

  base.sections = (secRows ?? [])
    .map((r) => {
      const key = String(r[0] || "other");
      return { key, label: PAGE_SECTION_LABELS[key] ?? key, views: Number(r[1] || 0), visitors: Number(r[2] || 0) };
    })
    .sort((x, y) => y.views - x.views);

  return base;
}

/**
 * Month-by-month series driving the trend tables.
 *
 * One scan grouped by month rather than a query per month: twelve round trips
 * would be twelve chances to time out, and the shape of this data is the whole
 * point of the section — organic falling while AI climbs.
 */
/** Month by month; null when PostHog did not answer, so an empty table is never mistaken for no traffic. */
export async function getAiMonthly(from: string, to: string): Promise<AiMonthRow[] | null> {
  if (!process.env.POSTHOG_API_KEY) return [];
  const where = `event = '$pageview' AND ${rangeFilter(from, to)} AND ${hostFilter()} AND NOT ${BOT_EXPR}`;

  const [totals, assistants] = await Promise.all([
    hogql(
      `SELECT formatDateTime(toStartOfMonth(timestamp), '%Y-%m') AS m, ` +
        `count() AS allPv, countIf(${ORGANIC_EXPR}) AS organicPv, ` +
        `uniqIf(person_id, ${ORGANIC_EXPR}) AS organicVisitors, ` +
        `uniqIf(person_id, ${AI_EXPR}) AS aiVisitors ` +
        `FROM events WHERE ${where} GROUP BY m ORDER BY m`,
      40000,
    ),
    hogql(
      `SELECT formatDateTime(toStartOfMonth(timestamp), '%Y-%m') AS m, ${AI_WHICH} AS which, ` +
        `count(DISTINCT person_id) AS visitors ` +
        `FROM events WHERE ${where} AND ${AI_EXPR} GROUP BY m, which ORDER BY m`,
      40000,
    ),
  ]);
  // Both halves or neither: totals without the assistant split would show every assistant at zero.
  if (!totals || !assistants) return null;

  const byMonth = new Map<string, AiMonthRow>();
  for (const r of totals) {
    const month = String(r[0] || "");
    if (!month) continue;
    byMonth.set(month, {
      month,
      allPageviews: Number(r[1] || 0),
      organicPageviews: Number(r[2] || 0),
      organicVisitors: Number(r[3] || 0),
      aiVisitors: Number(r[4] || 0),
      byAssistant: {},
    });
  }
  for (const r of assistants) {
    const row = byMonth.get(String(r[0] || ""));
    if (!row) continue;
    row.byAssistant[String(r[1] || "other")] = Number(r[2] || 0);
  }
  return [...byMonth.values()].sort((x, y) => x.month.localeCompare(y.month));
}
