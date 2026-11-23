// PostHog Web/SEO analytics, read via the HogQL Query API. Server-only.
//
// Needs a PostHog *personal* API key (phx_…) with Query:Read scope in
// POSTHOG_API_KEY. Project id + host default to the betterhomes project so the
// key alone is enough. No key / blocked egress / error → returns a graceful
// "not connected" shape so the page still renders.
//
// Channels are PostHog's own (see visitRange below): where a visit came from,
// AI assistants and search engines included, is PostHog's call from its own
// lists, so a new assistant counts as AI without a change here.
//
// Bot handling: a hit is automated if PostHog flags it ($virt_is_bot) or it
// runs desktop Linux (BOT_EXPR). "Humans only" (the default) excludes those.
import { cacheKey, remembered, type RememberOptions } from "@/lib/cache";
import { unstable_cache } from "next/cache";
import { errorMessage } from "@/lib/coerce";
import { dateOrNull } from "@/lib/dateRanges";
import { assistantKeySql } from "@/lib/aiSource";

const HOST = process.env.POSTHOG_HOST || "https://us.posthog.com";
const PROJECT = process.env.POSTHOG_PROJECT_ID || "198002";

/**
 * A hit is "automated" if PostHog flagged it OR it runs desktop Linux. Real
 * consumers are ~98% Windows/Mac/iOS/Android, so near-100%-Linux traffic (the
 * China / Singapore / Hong Kong / Netherlands server traffic, each ~1.0
 * pageviews/session) is crawlers.
 *
 * A typed list of cloud data-centre cities (Ashburn and three more) used to sit
 * here too. Those two rules already catch most of that traffic: what only the
 * list caught was about 250 of October's 59,000 human pageviews (0.4%), not
 * worth a list someone has to keep up.
 *
 * Defined once and shared by the Website and SEO tabs. It used to be written out
 * twice, which is how the two would eventually disagree about what a bot is
 * while both claiming to filter them.
 */
const BOT_EXPR = `(coalesce(properties.$virt_is_bot, false) = true OR properties.$os = 'Linux')`;

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
/**
 * Shortest wait for one attempt. PostHog holds a query that finds its three
 * slots taken for up to 30 s before running it, then allows 10 s of execution;
 * an attempt cut off at 15 s was abandoned while still in PostHog's line.
 */
const MIN_ATTEMPT_MS = Number(process.env.POSTHOG_TIMEOUT_MS || 45_000);
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

async function hogql(sql: string, timeoutMs = MIN_ATTEMPT_MS): Promise<any[][] | null> {
  const key = process.env.POSTHOG_API_KEY;
  if (!key) return null;
  const deadline = Date.now() + QUERY_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    await acquire();
    // Waited in line past the budget: asking now would only outlive the request.
    if (Date.now() >= deadline) {
      release();
      console.error(`[posthog] gave up waiting in line — ${sql.slice(0, 120)}`);
      return null;
    }
    let wait = 0;
    let why = "";
    // The timeout starts when the query does, not while it waits in line.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(timeoutMs, MIN_ATTEMPT_MS));
    try {
      const res = await fetch(`${HOST.replace(/\/$/, "")}/api/projects/${PROJECT}/query/`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        // PostHog's standard channels, without the project's custom channel
        // rules (set in PostHog, which split ChatGPT, Gemini and others out of
        // "AI" by name). The rules stay as they are in PostHog; they just don't
        // apply to the dashboard's questions, so "AI" holds every assistant.
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql, modifiers: { customChannelTypeRules: [] } } }),
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (res.ok) {
        const data = await res.json();
        return Array.isArray(data?.results) ? data.results : [];
      }
      const body = (await res.text().catch(() => "")).slice(0, 200);
      // 429 is PostHog saying "not now": worth waiting for — unless it is the
      // hourly budget, which no wait inside one request outlasts. A 5xx is worth
      // a couple more tries. 504 is PostHog's "hit the max execution time": once
      // more only, since a month-sized query that hits it was usually caught
      // behind other work, while one that is simply too big hits it every time.
      // Anything else is a bad query, and asking again gets the same answer.
      const budgetSpent = res.status === 429 && /budget/i.test(body);
      if (
        (res.status === 429 && !budgetSpent) ||
        (res.status === 504 && attempt < 2) ||
        (res.status >= 500 && res.status !== 504 && attempt < 3)
      ) {
        const after = Number(res.headers.get("retry-after"));
        wait = after > 0 ? after * 1000 : Math.min(10_000, 1000 * 2 ** (attempt - 1));
        why = `HTTP ${res.status}`;
      } else {
        // The query's start too, so a failure in the logs says which card it blanked.
        console.error(`[posthog] query HTTP ${res.status}: ${body} — ${sql.slice(0, 120)}`);
        return null;
      }
    } catch (e) {
      // A timeout or dropped connection: once more, in case it was contention.
      if (attempt < 2) {
        wait = 1000;
        why = errorMessage(e);
      } else {
        console.error(`[posthog] query error: ${errorMessage(e)} — ${sql.slice(0, 120)}`);
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
  /** When this answer was worked out (lib/cache.ts), for "Updated … ago". Null or absent when worked out just now and not kept. */
  cachedAt?: string | null;

  connected: boolean; // is a PostHog key configured
  hasData: boolean; // false only when PostHog answered and found no $pageview rows (incl. bots)
  humansOnly: boolean; // is the bot filter applied
  days: number;
  label: string; // human range label
  from: string; // resolved range start, YYYY-MM-DD — seeds the client date pickers
  to: string; // resolved range end, YYYY-MM-DD
  generatedAt: string; // when PostHog was queried, ISO — the "updated" stamp
  overview: { pageviews: number; visitors: number; sessions: number; organic: number } | null; // null when the totals did not load
  bots: { pageviews: number; pct: number }; // automated traffic detected in range
  trend: { day: string; pageviews: number; visitors: number }[];
  topPages: { path: string; views: number }[];
  sources: { source: string; sessions: number }[]; // visits by first referrer, our own domain as Direct
  countries: { country: string; visitors: number }[];
  flow: FlowData; // Channel → Landing → outcome touchpoint flow
  /**
   * The parts PostHog did not answer, even after queueing and retrying. Named
   * on the page, so a card left blank never passes for a quiet period: the
   * totals alone failing used to replace the whole tab with "no $pageview
   * events were found".
   */
  missing: string[];
}

/**
 * Each visit PostHog started in a range, with its channel and the site that
 * referred it, as a subquery to join pageviews to (`ON $session_id = v.v_sid`).
 *
 * The channel is PostHog's own ($channel_type: Organic Search, Paid Search,
 * Paid Social, AI, Referral and so on), from the visit's referrer, tags and
 * click ids. One change on top: a visit our own site referred is Direct, not
 * Referral. That is someone already browsing whose last visit timed out, and as
 * Referral it made bhomes.com the site's biggest referrer.
 *
 * Joined, not read off each pageview's `session`: PostHog leaves the session's
 * fields blank on a query that also reads the $virt_is_bot flag (BOT_EXPR),
 * so every channel came back empty. `range` filters $start_timestamp
 * (visitRange, or a relative one for the Website tab).
 */
const visitsSql = (range: string) =>
  `SELECT session_id AS v_sid, ` +
  `if($channel_type = 'Referral' AND (lower($entry_referring_domain) = 'bhomes.com' OR lower($entry_referring_domain) LIKE '%.bhomes.com'), 'Direct', $channel_type) AS channel, ` +
  `$entry_referring_domain AS ref FROM sessions WHERE ${range}`;

/**
 * Visits by channel and first referring domain, from a subquery with one
 * `channel` and `ref` per visit. Up to 5,000 domains, so a channel's "+N more"
 * and the shares on hover still add up over a long range (LIMIT 300 could cut
 * the referral tail).
 */
const entryDomainSql = (inner: string, where = "") =>
  `SELECT channel, if(ref = '' OR ref = '$direct', '(no referrer)', ref) AS domain, count() AS sessions ` +
  `FROM (${inner})${where} GROUP BY channel, domain ORDER BY sessions DESC LIMIT 5000`;

// Group a raw path into its site section (sectionSql below), so both tabs file
// a page alike. Returns a section key; '' means the session had no pageview at
// that step (they'd left) — we emit no node for it.
function pageBucket(e: string): string {
  return `if(${e} = '', '', ${sectionSql(e)})`;
}

// Page-journey flow: per session, the entry source (channel) then the first 3
// pages (bucketed), shown as Source → 1st → 2nd → 3rd page. Drop-off is implied
// — a session with fewer pages simply has no further link (no "Exit" node).
// Optional pageFilter keeps only sessions whose path sequence touches a substring.
// entrySources is the sources card's query (getWebMetrics): unfiltered, it is
// this chart's per-channel domain split too, so that is not asked twice.
async function getUserFlow(
  since: string,
  human: string,
  visits: string,
  pageFilter?: string[],
  exact = false,
  entrySources?: Promise<any[][] | null>,
): Promise<{ flow: FlowData; missing: string[] }> {
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
  // one row per session: PostHog's channel and entry referrer (visitsSql), and
  // the ordered page paths. The heavier host+path array (fullpaths) is built
  // ONLY when a page filter needs it — on a normal load we don't pay for it.
  const fullpathsSel = filterWhere
    ? `, arrayMap(x -> x.2, arraySort(x -> x.1, groupArray((timestamp, lower(concat(coalesce(properties.$host, ''), coalesce(nullif(properties.$pathname, ''), '/'))))))) AS fullpaths `
    : ` `;
  const innerSessions =
    `SELECT any(v.channel) AS channel, any(v.ref) AS ref, ` +
    `arrayMap(x -> x.2, arraySort(x -> x.1, groupArray((timestamp, lower(coalesce(nullif(properties.$pathname, ''), '/')))))) AS paths` +
    fullpathsSel +
    `FROM events INNER JOIN (${visitsSql(visits)}) AS v ON $session_id = v.v_sid ` +
    `WHERE event = '$pageview' AND ${since}${human} AND properties.$session_id != '' GROUP BY properties.$session_id`;
  const ownSources = !!filterWhere || !entrySources;
  const [rows, bdRows, pageBdRows] = await Promise.all([
    // PostHog's 50,000-row ceiling holds every journey shape: a whole year,
    // to November 2026, makes 8,268 of them over 681,669 visits, so the
    // session total below is exact. At LIMIT 500 a long range lost its rarer
    // journeys and the total read low. An answer that reaches the ceiling may
    // have been cut short, so it counts as unanswered.
    hogql(
      `SELECT channel, ${pageBucket("arrayElement(paths, 1)")} AS b1, ${pageBucket("arrayElement(paths, 2)")} AS b2, ${pageBucket("arrayElement(paths, 3)")} AS b3, count() AS sessions ` +
        `FROM (${innerSessions})${filterWhere} GROUP BY channel, b1, b2, b3 ORDER BY sessions DESC LIMIT 50000`,
    ).then((r) => (r && r.length >= ROW_CAP ? null : r)),
    ownSources ? hogql(entryDomainSql(innerSessions, filterWhere)) : entrySources,
    // per-bucket page composition (host + path) so a page node can show exactly
    // which real pages — across subdomains like survey./promo. — make it up.
    hogql(
      `SELECT ${pageBucket("path")} AS bucket, concat(host, path) AS page, count() AS views ` +
        `FROM (SELECT lower(coalesce(nullif(properties.$pathname, ''), '/')) AS path, coalesce(properties.$host, '') AS host ` +
        `FROM events WHERE event = '$pageview' AND ${since}${human}) GROUP BY bucket, page ORDER BY views DESC LIMIT 2000`,
    ),
  ]);
  const missing = [
    ...(rows ? [] : ["journeys"]),
    // Unfiltered, the source split is the sources card's query, which the caller names.
    ...(bdRows || !ownSources ? [] : ["journey sources"]),
    ...(pageBdRows ? [] : ["journey pages"]),
  ];
  if (!rows || !rows.length) return { flow: { nodes: [], links: [], sessions: 0 }, missing };

  // Section keys → their labels (sectionLabel); '' (no page at that step) stays ''.
  const section = (k: unknown) => {
    const s = String(k || "");
    return s ? sectionLabel(s) : "";
  };
  const data = rows.map((r) => ({ channel: String(r[0] || "Unknown"), b1: section(r[1]), b2: section(r[2]), b3: section(r[3]), sessions: Number(r[4] || 0) }));
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
    const ch = String(r[0] || "Unknown");
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
    const folded = cat(section(r[0])); // '' → skip
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

  return { flow: { nodes, links, sessions }, missing };
}

/** The Website tab's figures, remembered (lib/cache.ts). Kept only when every PostHog query answered. */
export async function getWebMetrics(
  daysRaw = 30,
  fromRaw?: string,
  toRaw?: string,
  humansOnly = true,
  flowPages?: string[],
  flowMatch?: string,
  opts: RememberOptions = {},
): Promise<WebMetrics> {
  const from = dateOrNull(fromRaw);
  const to = dateOrNull(toRaw);
  const days = Math.max(1, Math.min(365, Math.round(daysRaw || 30)));
  return remembered(
    // "posthog": channels and sections are PostHog's and the site's own; answers kept before used the typed lists.
    cacheKey("webMetrics", { days, from, to, humansOnly, flowPages: flowPages ?? null, flowMatch: flowMatch ?? null, channels: "posthog" }),
    () => computeWebMetrics(days, from ?? undefined, to ?? undefined, humansOnly, flowPages, flowMatch),
    (d) => d.connected && d.missing.length === 0,
    opts,
  );
}

async function computeWebMetrics(daysRaw = 30, fromRaw?: string, toRaw?: string, humansOnly = true, flowPages?: string[], flowMatch?: string): Promise<WebMetrics> {
  const from = dateOrNull(fromRaw);
  const to = dateOrNull(toRaw);
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
  const base: WebMetrics = { connected: !!key, hasData: false, humansOnly, days, label, from: resolvedFrom, to: resolvedTo, generatedAt: new Date().toISOString(), overview: null, bots: { pageviews: 0, pct: 0 }, trend: [], topPages: [], sources: [], countries: [], flow: { nodes: [], links: [], sessions: 0 }, missing: [] };
  if (!key) return base;

  const pv = `event = '$pageview'`;
  const botExpr = BOT_EXPR;
  const human = humansOnly ? ` AND NOT ${botExpr}` : "";
  // The visits PostHog started in the range, the day before it included so a
  // visit that crosses midnight keeps its channel.
  const visits =
    from && to && from <= to
      ? `$start_timestamp >= toDateTime('${dayBefore(from)} 00:00:00') AND $start_timestamp <= toDateTime('${to} 23:59:59')`
      : `$start_timestamp >= now() - INTERVAL ${days + 1} DAY`;
  // PostHog's Organic Search: unpaid search results. A Google Ads click is
  // Paid Search and an assistant is AI, which the old list of search-engine
  // referrers counted here too (5,294 of October's 16,724 "organic" visitors
  // were Google Ads clicks).
  const organic = `$session_id IN (SELECT session_id FROM sessions WHERE ${visits} AND $channel_type = 'Organic Search')`;
  // Visits by where they came from, read as the journey chart reads them: each
  // visit's channel and first referrer from PostHog, our own domain as Direct.
  // Counting every pageview's referrer listed www.bhomes.com as a source
  // (internal clicks carry it) and counted a Google visit that browsed on twice.
  const entrySources = hogql(
    entryDomainSql(
      `SELECT any(v.channel) AS channel, any(v.ref) AS ref FROM events INNER JOIN (${visitsSql(visits)}) AS v ON $session_id = v.v_sid ` +
        `WHERE ${pv} AND ${since}${human} AND properties.$session_id != '' GROUP BY properties.$session_id`,
    ),
  );

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
    // PostHog returns 100 rows unless asked for more: "This year" drew 1 January
    // to 10 April and stopped there.
    hogql(`SELECT toDate(timestamp) AS day, count() AS pageviews, count(DISTINCT person_id) AS visitors FROM events WHERE ${pv} AND ${since}${human} GROUP BY day ORDER BY day LIMIT 10000`),
    hogql(`SELECT properties.$pathname AS path, count() AS views FROM events WHERE ${pv} AND ${since}${human} AND properties.$pathname != '' GROUP BY path ORDER BY views DESC LIMIT 12`),
    entrySources,
    hogql(`SELECT properties.$geoip_country_name AS country, count(DISTINCT person_id) AS visitors FROM events WHERE ${pv} AND ${since}${human} AND properties.$geoip_country_name != '' GROUP BY country ORDER BY visitors DESC LIMIT 10`),
    getUserFlow(since, human, visits, flowPages, flowMatch === "exact", entrySources),
  ]);

  const row = ov && ov[0];
  const all = row ? { pageviews: Number(row[0] || 0), visitors: Number(row[1] || 0), sessions: Number(row[2] || 0), organic: Number(row[3] || 0) } : null;
  const humans = row ? { pageviews: Number(row[4] || 0), visitors: Number(row[5] || 0), sessions: Number(row[6] || 0), organic: Number(row[7] || 0) } : null;
  const botPv = row ? Number(row[8] || 0) : 0;
  const overview = humansOnly ? humans : all;
  const botPct = all && all.pageviews ? Math.round((botPv / all.pageviews) * 100) : 0;

  const bySource = new Map<string, number>();
  for (const r of sr ?? []) {
    // A visit with no referrer is listed by its channel (a Paid Social visit
    // from an app that passes none), so "(no referrer)" never stands as a site.
    const channel = String(r[0] || "Unknown"), domain = String(r[1] || "(no referrer)");
    const source = channel === "Direct" ? "Direct / none" : domain === "(no referrer)" ? channel : domain;
    bySource.set(source, (bySource.get(source) ?? 0) + Number(r[2] || 0));
  }

  return {
    connected: true,
    // False only when the totals answered and counted nothing. Totals that did
    // not answer are named in `missing` instead, and the other cards still show.
    hasData: all ? all.pageviews > 0 : true,
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
    sources: [...bySource].map(([source, sessions]) => ({ source, sessions })).sort((a, b) => b.sessions - a.sessions).slice(0, 10),
    countries: (co ?? []).map((r) => ({ country: String(r[0] || "—"), visitors: Number(r[1] || 0) })),
    flow: fl.flow,
    missing: [
      ...(row ? [] : ["totals"]),
      ...([["daily trend", tr], ["top pages", tp], ["traffic sources", sr], ["countries", co]] as const)
        .filter(([, rows]) => rows === null)
        .map(([name]) => name),
      ...fl.missing,
    ],
  };
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

/**
 * A page's site section, read off its address: the first folder after the
 * language, so /en/blog/… is "blog" and /en/join-our-team/… is
 * "join-our-team". The home page (/, /en) is "home".
 *
 * This was a typed list of fourteen rules (/en/sales/ is Buy, and so on), so a
 * section the site added later fell into "Other" until the list was edited,
 * and the site had in fact moved to /en/buy/ and /en/rent/. Every section now
 * shows under the site's own folder name. "By site section" used to be summed
 * in JS from the top 60 pages only, which left 42% of August's pageviews out;
 * the query still classifies every pageview.
 */
function sectionSql(pathExpr: string): string {
  const p = `lower(coalesce(${pathExpr}, ''))`;
  return (
    `multiIf(match(${p}, '^/([a-z]{2}/?)?$'), 'home', ` +
    `coalesce(nullIf(extract(${p}, '^/(?:[a-z]{2}/)?([^/]+)'), ''), 'other'))`
  );
}

/** A section key as words: "join-our-team" is "Join our team", "home" the "Home page". */
function sectionLabel(key: string): string {
  if (key === "home") return "Home page";
  const words = key.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Other";
}

/** How many sections the AI landing card names; the rest are added up as "Other pages". */
const PAGE_TYPES_SHOWN = 10;

// ═══════════════════════════════════════════════════════════════════
// AI channel — the SEO & AI Channel report's data layer.
//
// A visit is AI when PostHog files it under its AI channel: an assistant
// referred it or tagged the link (the ChatGPT app on a phone tags rather than
// referring, and phones are 65% of this channel). PostHog keeps the list of
// assistants, so a new one counts without a change here. This was a typed list
// of five, and nine others have sent visits since December 2025, Doubao,
// Manus and Grok among them.
//
// A visit's channel is how it started, so all of its pages count as AI, and a
// visit that began elsewhere does not, even if it later passes through an
// assistant's link. The typed list read each pageview on its own; October's AI
// visitors move from 1,103 to 1,073 between the two.
//
// The report measures the channel in PEOPLE: 1,415 sessions came from 1,227
// people in August. Everything below is per-person by default for that reason,
// with sessions and pageviews reported alongside so the ratios stay visible.
// ═══════════════════════════════════════════════════════════════════

/** The visits PostHog started in a window, the day before included so a visit that crosses midnight keeps its channel. */
const visitRange = (w: Window) =>
  `$start_timestamp >= toDateTime('${dayBefore(w.from)} 00:00:00') AND $start_timestamp <= toDateTime('${w.to} 23:59:59')`;

/** A pageview in a visit PostHog files under `channel`, in its own words ('AI', 'Organic Search'). */
const inChannel = (channel: string, w: Window) =>
  `$session_id IN (SELECT session_id FROM sessions WHERE ${visitRange(w)} AND $channel_type = '${channel}')`;

/**
 * Where an AI visit came from: the tag the assistant put on its link, or else
 * the site that referred it. The tag first, as PostHog reads it: it survives a
 * hop through another page, where the referrer becomes that page.
 */
const AI_SOURCE = `lower(if(coalesce($entry_utm_source, '') != '', $entry_utm_source, $entry_referring_domain))`;

/**
 * Pageviews joined to their AI visit (`FROM events ${aiJoin(w)} WHERE …`),
 * which carries `ai.which`, the assistant by lib/aiSource.ts's rule, and
 * `ai.src`, the name it arrived under (AI_SOURCE). An inner join, so only the
 * AI visits' pageviews remain.
 */
const aiJoin = (w: Window) =>
  `INNER JOIN (SELECT session_id AS ai_sid, ${assistantKeySql(AI_SOURCE)} AS which, ${AI_SOURCE} AS src ` +
  `FROM sessions WHERE ${visitRange(w)} AND $channel_type = 'AI') AS ai ON $session_id = ai.ai_sid`;

/** The names an assistant arrived under, most used first, as the card shows them: "www." dropped. */
const sourceNames = (names: unknown[]): string[] => [
  ...new Set(names.map((n) => String(n ?? "").replace(/^www\./, "")).filter(Boolean)),
];

export interface AssistantStat {
  /** lib/aiSource.ts's name for it: "chatgpt", "gemini". */
  key: string;
  /** The name it most often arrived under: chatgpt.com, gemini.google.com. */
  label: string;
  /** Every name it arrived under, most used first: gemini.google.com and a plain "gemini" tag. */
  sources: string[];
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
  /** Pageviews in visits PostHog files under Organic Search — the same measure as the monthly series, for any range. */
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
  /**
   * True when the range spans months and was asked a month at a time: the
   * whole-site visitor counts (allVisitors, and the visitors of topPages,
   * sections and propertyViews) are then each month's visitors added up, so a
   * person returning in a later month counts again. The AI channel's figures
   * and organic visitors are still counted once per person.
   */
  visitorsByMonth?: boolean;
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

// ── long ranges, a month at a time ─────────────────────────────────────────

/** A window's rows, or null when PostHog did not answer for it. */
type Rows = any[][] | null;

/** What the AI channel's cards are built from, however the range was asked. */
interface ChannelRows {
  funnel: Rows; perAssistant: Rows; entry: Rows; geo: Rows; device: Rows; returning: Rows; actions: Rows;
  forms: Rows; top: Rows; all: Rows; props: Rows; secRows: Rows; acting: Rows; landing: Rows;
}

type Window = { from: string; to: string };

/** Most rows one API query hands back, even when asked for more. */
const ROW_CAP = 50_000;

/**
 * Calendar months covering from → to, the first and last clipped to the range:
 * 14 August → 3 October is 14–31 August, September, and 1–3 October.
 */
function monthWindows(from: string, to: string): Window[] {
  if (!dateOrNull(from) || !dateOrNull(to) || from > to) return [{ from, to }];
  const out: Window[] = [];
  for (let start = from; start <= to; ) {
    const [y, m] = start.split("-").map(Number);
    // Day 0 of the next month is this month's last day.
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    out.push({ from: start, to: end < to ? end : to });
    start = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  }
  return out;
}

const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * Answers about months that have ended, kept for a week.
 *
 * A closed month no longer changes, yet every load of "this year" asked PostHog
 * about each one again: most of what a long range costs, in a project allowed
 * 2,400 queries an hour. They were kept in each server's memory, which Vercel
 * recycles: after three idle days "this year" took 127 s on first load and "this
 * month" 92 s. They now go in Vercel's shared data cache, which every server
 * reads and a cold start keeps; memory stays in front of it, so a server that
 * already holds a month doesn't ask the cache again.
 */
const SETTLED_TTL_S = 7 * 86_400;
const settled = new Map<string, any[][]>();
const NO_ANSWER = "posthog: no answer";

/** A closed window's answer from the shared cache, asking PostHog only when it holds none. */
async function sharedAnswer(sql: string, timeoutMs?: number): Promise<any[][] | null> {
  const ask = async () => {
    const rows = await hogql(sql, timeoutMs);
    // Thrown, not returned: a failure must never be kept and served for a week.
    if (!rows) throw new Error(NO_ANSWER);
    return rows;
  };
  try {
    return await unstable_cache(ask, ["posthog-window", sql], { revalidate: SETTLED_TTL_S })();
  } catch (e) {
    if (e instanceof Error && e.message === NO_ANSWER) return null;
    // No data cache outside a Next.js server, as in a test harness: ask directly.
    return hogql(sql, timeoutMs);
  }
}

async function askWindow(w: Window, sql: string, timeoutMs?: number): Promise<any[][] | null> {
  // Yesterday can still receive late events; anything before it is settled.
  const closed = w.to < dayBefore(new Date().toISOString().slice(0, 10));
  if (!closed) return hogql(sql, timeoutMs);
  const held = settled.get(sql);
  if (held) return held;
  const rows = await sharedAnswer(sql, timeoutMs);
  if (rows && rows.length <= 5_000) {
    if (settled.size >= 500) settled.delete(settled.keys().next().value as string);
    settled.set(sql, rows);
  }
  return rows;
}

const addTo = (m: Map<string, Set<string>>, key: string, id: string) => {
  const s = m.get(key);
  if (s) s.add(id);
  else m.set(key, new Set([id]));
};
/** People per key, most first: the shape of a `count(DISTINCT person_id) … ORDER BY … LIMIT n` answer. */
const ranked = (m: Map<string, Set<string>>, n: number): any[][] =>
  [...m].map(([k, s]): any[] => [k, s.size]).sort((x, y) => y[1] - x[1]).slice(0, n);
/** Rows added up by their first column across the months. */
const addUp = (rows: any[][], cols: number): Map<string, number[]> => {
  const m = new Map<string, number[]>();
  for (const r of rows) {
    const k = String(r[0] ?? "");
    const acc = m.get(k) ?? new Array<number>(cols).fill(0);
    for (let i = 0; i < cols; i++) acc[i] += Number(r[i + 1] || 0);
    m.set(k, acc);
  }
  return m;
};

/**
 * The same row sets for a range longer than a month, asked a month at a time.
 *
 * PostHog stops an API query at 10 s of execution, and queries made with an
 * API key run on a throttled pool: a month of this site's events, about 1.4
 * million rows with each one's properties read for the host and bot filters,
 * takes some 3.5 s there. January to October (12–14 million rows) hit the
 * limit on every question, 29 times in one day of PostHog's query log, and
 * "this year" came back with the whole AI channel blank. A month at a time
 * stays inside the limit, at the cost of more questions in the queue.
 *
 * Splitting is exact only for figures that add up across months. Pageviews and
 * views do; people do not, since someone who visits in March and in May is one
 * visitor. So the AI channel (a few thousand pageviews a month) and what its
 * visitors did are fetched as rows and counted here, each person once, by the
 * same rules as the single-range queries, and organic visitors, the AI share's
 * denominator, as the list of people. The rest of the site is too large for
 * that, at around 50,000 people a month: its visitor counts are each month's
 * added up, and `visitorsByMonth` has the page say so.
 *
 * A month left unanswered blanks its card for the whole range, as a failed
 * single-range query does: a total missing a month must not pass for a full one.
 */
async function channelRowsByMonth(from: string, windows: Window[], detail: boolean): Promise<ChannelRows> {
  const pvIn = (w: Window) => `event = '$pageview' AND ${rangeFilter(w.from, w.to)} AND ${hostFilter()} AND NOT ${BOT_EXPR}`;
  const each = async (sql: (w: Window) => string, timeoutMs?: number): Promise<Rows> => {
    const parts = await Promise.all(windows.map((w) => askWindow(w, sql(w), timeoutMs)));
    // A month at the row cap may have been cut short: unanswered, not counted short.
    return parts.every((p) => p && p.length < ROW_CAP) ? (parts as any[][][]).flat() : null;
  };
  const none = Promise.resolve([] as any[][]);

  const [aiRows, firstSeen, actedRows, topRows, allRows, organicPeople, propRows, sectionRows] = await Promise.all([
    // Every AI pageview, carrying what each AI card is counted from.
    each(
      (w) =>
        `SELECT person_id, properties.$session_id AS sid, toUnixTimestamp64Milli(timestamp) AS ms, ai.which AS which, ` +
        `properties.$pathname AS path, properties.$geoip_country_name AS country, properties.$device_type AS device, ` +
        `${sectionSql("properties.$pathname")} AS section, ai.src AS src ` +
        `FROM events ${aiJoin(w)} WHERE ${pvIn(w)} LIMIT ${ROW_CAP}`,
    ),
    detail
      ? each(
          (w) =>
            `SELECT person_id, min(person.created_at) >= toDateTime('${from} 00:00:00') AS fresh ` +
            `FROM events WHERE ${pvIn(w)} AND ${inChannel("AI", w)} GROUP BY person_id LIMIT ${ROW_CAP}`,
        )
      : none,
    detail
      ? each((w) => {
          // AI sessions from the day before this month as well, where the range
          // allows, so a visit that crosses midnight at a month's end keeps its
          // later events.
          const since = w.from > from ? dayBefore(w.from) : w.from;
          return (
            `SELECT person_id, event, properties.form_name AS form FROM events ` +
            `WHERE ${rangeFilter(w.from, w.to)} AND NOT startsWith(event, '$') AND $session_id IN (` +
            `SELECT $session_id FROM events WHERE event = '$pageview' AND ${rangeFilter(since, w.to)} AND ${hostFilter()} ` +
            `AND NOT ${BOT_EXPR} AND ${inChannel("AI", { from: since, to: w.to })} AND $session_id != '') LIMIT ${ROW_CAP}`
          );
        })
      : none,
    // Deeper than the 60 shown, so a page that ranks lower in one month still has its every month counted.
    detail
      ? each(
          (w) =>
            `SELECT properties.$pathname AS path, count(DISTINCT person_id) AS visitors, count() AS views ` +
            `FROM events WHERE ${pvIn(w)} GROUP BY path ORDER BY views DESC LIMIT 300`,
        )
      : none,
    each(
      (w) =>
        `SELECT count() AS pageviews, count(DISTINCT person_id) AS visitors, countIf(${inChannel("Organic Search", w)}) AS organicPv ` +
        `FROM events WHERE ${pvIn(w)}`,
    ),
    each((w) => `SELECT DISTINCT person_id FROM events WHERE ${pvIn(w)} AND ${inChannel("Organic Search", w)} LIMIT ${ROW_CAP}`),
    detail
      ? each(
          (w) =>
            `SELECT properties.$pathname AS path, count() AS views, count(DISTINCT person_id) AS visitors ` +
            `FROM events WHERE ${pvIn(w)} AND properties.$pathname LIKE '/en/property/%' ` +
            `GROUP BY path ORDER BY views DESC LIMIT 400`,
        )
      : none,
    detail
      ? each(
          (w) =>
            `SELECT ${sectionSql("properties.$pathname")} AS section, count() AS views, count(DISTINCT person_id) AS visitors ` +
            `FROM events WHERE ${pvIn(w)} GROUP BY section ORDER BY views DESC`,
        )
      : none,
  ]);

  // ── the AI channel, counted from its pageviews ──
  let funnel: Rows = null, perAssistant: Rows = null, entry: Rows = null, geo: Rows = null, device: Rows = null, landing: Rows = null;
  if (aiRows) {
    const people = new Set<string>(), sessions = new Set<string>();
    const per = new Map<string, { people: Set<string>; sessions: Set<string>; pageviews: number; names: Map<string, number> }>();
    const firstInSession = new Map<string, any[]>(), firstOfPerson = new Map<string, any[]>();
    const byCountry = new Map<string, Set<string>>(), byDevice = new Map<string, Set<string>>();
    const earlier = (was: any[] | undefined, r: any[]) => !was || Number(r[2]) < Number(was[2]);
    for (const r of aiRows) {
      const pid = String(r[0]);
      // A missing session id is not a session; an empty one is counted, as count(DISTINCT …) counts it.
      const sid = r[1] == null ? null : String(r[1]);
      const which = String(r[3] || "other");
      people.add(pid);
      if (sid != null) sessions.add(sid);
      const a = per.get(which) ?? { people: new Set<string>(), sessions: new Set<string>(), pageviews: 0, names: new Map<string, number>() };
      a.people.add(pid);
      if (sid != null) a.sessions.add(sid);
      a.pageviews++;
      const name = String(r[8] ?? "");
      a.names.set(name, (a.names.get(name) ?? 0) + 1);
      per.set(which, a);
      if (sid && earlier(firstInSession.get(sid), r)) firstInSession.set(sid, r);
      if (earlier(firstOfPerson.get(pid), r)) firstOfPerson.set(pid, r);
      addTo(byCountry, String(r[5] ?? ""), pid);
      addTo(byDevice, String(r[6] ?? ""), pid);
    }
    funnel = [[aiRows.length, sessions.size, people.size]];
    // The names most used first, as topK lists them in the single-range query.
    perAssistant = [...per].map(([which, a]) => [
      which, a.people.size, a.sessions.size, a.pageviews,
      [...a.names].sort((x, y) => y[1] - x[1]).map(([n]) => n),
    ]);
    // Each AI session's arrival page, then people per page and assistant: the single-range query's two levels.
    const arrivals = new Map<string, { path: string; which: string; people: Set<string> }>();
    for (const r of firstInSession.values()) {
      const path = String(r[4] ?? ""), which = String(r[3] || "other");
      const k = `${path}\u0000${which}`;
      const e = arrivals.get(k) ?? { path, which, people: new Set<string>() };
      e.people.add(String(r[0]));
      arrivals.set(k, e);
    }
    entry = [...arrivals.values()].map((e): any[] => [e.path, e.which, e.people.size]).sort((x, y) => y[2] - x[2]);
    geo = ranked(byCountry, 15);
    device = ranked(byDevice, 6);
    const landed = new Map<string, number>();
    for (const r of firstOfPerson.values()) {
      const section = String(r[7] || "other");
      landed.set(section, (landed.get(section) ?? 0) + 1);
    }
    landing = [...landed];
  }

  let returning: Rows = detail ? null : [];
  if (detail && firstSeen) {
    // The same person in two months carries the same first-seen date in both.
    const fresh = new Map<string, number>();
    for (const r of firstSeen) if (r[1] != null) fresh.set(String(r[0]), Number(r[1]));
    const n = [...fresh.values()].filter(Boolean).length;
    returning = [[n, fresh.size - n]];
  }

  let actions: Rows = detail ? null : [], forms: Rows = detail ? null : [], acting: Rows = detail ? null : [];
  if (detail && actedRows) {
    const everyone = new Set<string>();
    const byEvent = new Map<string, { people: Set<string>; fires: number }>();
    const byForm = new Map<string, { opened: Set<string>; submitted: Set<string> }>();
    for (const r of actedRows) {
      const pid = String(r[0]), event = String(r[1] ?? "");
      everyone.add(pid);
      const e = byEvent.get(event) ?? { people: new Set<string>(), fires: 0 };
      e.people.add(pid);
      e.fires++;
      byEvent.set(event, e);
      if (r[2] != null && r[2] !== "") {
        const f = byForm.get(String(r[2])) ?? { opened: new Set<string>(), submitted: new Set<string>() };
        if (event === "click_open_form") f.opened.add(pid);
        if (event.startsWith("lead")) f.submitted.add(pid);
        byForm.set(String(r[2]), f);
      }
    }
    actions = [...byEvent].map(([ev, e]): any[] => [ev, e.people.size, e.fires]).sort((x, y) => y[1] - x[1]).slice(0, 25);
    forms = [...byForm].map(([form, f]): any[] => [form, f.opened.size, f.submitted.size]).sort((x, y) => y[1] - x[1]).slice(0, 20);
    acting = [[everyone.size, actedRows.length]];
  }

  // ── the whole site: views add up, visitors are each month's added up ──
  const top = !detail ? [] : topRows && [...addUp(topRows, 2)].map(([path, [visitors, views]]): any[] => [path, visitors, views]).sort((x, y) => y[2] - x[2]).slice(0, 60);
  const props = !detail ? [] : propRows && [...addUp(propRows, 2)].map(([path, [views, visitors]]): any[] => [path, views, visitors]).sort((x, y) => y[1] - x[1]).slice(0, 80);
  const secRows = !detail ? [] : sectionRows && [...addUp(sectionRows, 2)].map(([section, [views, visitors]]): any[] => [section, views, visitors]);
  let all: Rows = null;
  if (allRows && organicPeople) {
    const sum = (i: number) => allRows.reduce((n, r) => n + Number(r[i] || 0), 0);
    all = [[sum(0), sum(1), sum(2), new Set(organicPeople.map((r) => String(r[0]))).size]];
  }

  return {
    funnel, perAssistant, returning, actions, forms, top, all, props, secRows, acting,
    entry: detail ? entry : [], geo: detail ? geo : [], device: detail ? device : [], landing: detail ? landing : [],
  };
}

/** The cards' row sets for a range inside one month, one question each. */
async function channelRows(from: string, to: string, detail: boolean): Promise<ChannelRows> {
  /**
   * A comparison period needs only its headline counts — visitors, sessions,
   * pageviews, the per-assistant split and the site totals. The other eleven
   * questions would take their turn in PostHog's queue for figures no card
   * shows, so for it they are not asked.
   */
  const more = (sql: string, timeoutMs?: number) => (detail ? hogql(sql, timeoutMs) : Promise.resolve([] as any[][]));

  const w: Window = { from, to };
  const where = `${rangeFilter(from, to)} AND ${hostFilter()} AND NOT ${BOT_EXPR}`;
  const pv = `event = '$pageview' AND ${where}`;
  const isAi = inChannel("AI", w);
  const isOrganic = inChannel("Organic Search", w);
  /** Sessions that arrived from an assistant — where "what AI visitors do" happens. */
  const aiSessions =
    `$session_id IN (SELECT $session_id FROM events ` +
    `WHERE ${pv} AND ${isAi} AND $session_id != '')`;
  /**
   * What a visitor did, within those sessions.
   *
   * The session was already vetted when it arrived — its landing pageview
   * passed the host and bot filters — so its later events are not re-checked
   * one by one. Over a long range that re-check was the whole cost (five
   * properties parsed per event, across every event on the site) and pushed
   * these queries past PostHog's 10 s limit. It was also slightly wrong: some
   * Android browsers report their OS as Linux on later events, which the bot
   * filter reads as a crawler. August moves from 160 people and 386 events to
   * 163 and 391; the report counts 171.
   */
  const acted = `${rangeFilter(from, to)} AND NOT startsWith(event, '$') AND ${aiSessions}`;

  const [funnel, perAssistant, entry, geo, device, returning, actions, forms, top, all, props, secRows, acting, landing] = await Promise.all([
    // Funnel + context in one scan. Cheapest query here, and the one the KPIs need.
    hogql(
      `SELECT count() AS pageviews, count(DISTINCT properties.$session_id) AS sessions, ` +
        `count(DISTINCT person_id) AS visitors ` +
        `FROM events WHERE ${pv} AND ${isAi}`,
    ),
    // Each assistant, with the names it arrived under, most used first.
    hogql(
      `SELECT ai.which AS which, count(DISTINCT person_id) AS visitors, ` +
        `count(DISTINCT properties.$session_id) AS sessions, count() AS pageviews, topK(5)(ai.src) AS names ` +
        `FROM events ${aiJoin(w)} WHERE ${pv} GROUP BY which`,
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
        `any(ai.which) AS which, any(person_id) AS pid ` +
        `FROM events ${aiJoin(w)} WHERE ${pv} AND properties.$session_id != '' GROUP BY sid` +
        `) GROUP BY path, which ORDER BY visitors DESC LIMIT 400`,
      25000,
    ),
    more(
      `SELECT properties.$geoip_country_name AS country, count(DISTINCT person_id) AS visitors ` +
        `FROM events WHERE ${pv} AND ${isAi} GROUP BY country ORDER BY visitors DESC LIMIT 15`,
    ),
    more(
      `SELECT properties.$device_type AS device, count(DISTINCT person_id) AS visitors ` +
        `FROM events WHERE ${pv} AND ${isAi} GROUP BY device ORDER BY visitors DESC LIMIT 6`,
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
        `FROM events WHERE ${pv} AND ${isAi} GROUP BY person_id)`,
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
        `FROM events WHERE ${acted} ` +
        `GROUP BY event ORDER BY people DESC LIMIT 25`,
      25000,
    ),
    more(
      `SELECT properties.form_name AS form, ` +
        `uniqIf(person_id, event = 'click_open_form') AS opened, ` +
        `uniqIf(person_id, startsWith(event, 'lead')) AS submitted ` +
        `FROM events WHERE ${acted} AND properties.form_name IS NOT NULL AND properties.form_name != '' ` +
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
        `countIf(${isOrganic}) AS organicPv, uniqIf(person_id, ${isOrganic}) AS organicVisitors ` +
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
        `FROM events WHERE ${acted}`,
      25000,
    ),
    // Each AI visitor once, by the section of the first page they landed on.
    more(
      `SELECT ${sectionSql("path")} AS section, count() AS people FROM (` +
        `SELECT person_id, argMin(properties.$pathname, timestamp) AS path ` +
        `FROM events WHERE ${pv} AND ${isAi} GROUP BY person_id` +
        `) GROUP BY section`,
      25000,
    ),
  ]);
  return { funnel, perAssistant, entry, geo, device, returning, actions, forms, top, all, props, secRows, acting, landing };
}

/**
 * Everything the report needs for a range, in one call: asked as one range
 * inside a month, or a month at a time beyond one (channelRowsByMonth).
 *
 * Queries are issued together but each degrades on its own: a section that
 * times out comes back empty while the rest still render, rather than taking
 * the page down. The headline funnel is deliberately the cheapest query of the
 * set so it is the least likely to be the one that fails.
 *
 * `skip` returns the empty shape without asking PostHog: for a comparison
 * period that starts before PostHog's records, whose figures the page never
 * shows. "This year" spent some 30 queue slots on 2025 that way.
 */
export async function getAiChannel(from: string, to: string, opts: { detail?: boolean; skip?: boolean } = {}): Promise<AiChannel> {
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
  if (!key || opts.skip) return base;

  const detail = opts.detail !== false;
  const windows = monthWindows(from, to);
  const byMonth = windows.length > 1;
  const { funnel, perAssistant, entry, geo, device, returning, actions, forms, top, all, props, secRows, acting, landing } =
    byMonth ? await channelRowsByMonth(from, windows, detail) : await channelRows(from, to, detail);
  base.visitorsByMonth = byMonth;

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

  // The same visitors, each ONCE, by the site section they first landed on.
  //
  // This used to be summed from the entry-page table, which counts a person
  // once per page they arrived on — someone who came in twice, on two pages,
  // was two people — so the groups did not add up to the visitor total the
  // card sets them against. One first landing per person does: August adds up
  // to its 1,221 visitors, with careers 219 and blog 249 — both the report's.
  // Past the first PAGE_TYPES_SHOWN sections, and pages in no folder, they are
  // added up as "Other pages": still each person once.
  const bySection = (landing ?? [])
    .map((r) => ({ key: String(r[0] || "other"), value: Number(r[1] || 0) }))
    .sort((x, y) => y.value - x.value);
  const named = bySection.filter((x) => x.key !== "other");
  const otherPages =
    named.slice(PAGE_TYPES_SHOWN).reduce((n, x) => n + x.value, 0) + (bySection.find((x) => x.key === "other")?.value ?? 0);
  base.pageTypes = [
    ...named.slice(0, PAGE_TYPES_SHOWN).map((x) => ({ label: sectionLabel(x.key), value: x.value })),
    ...(otherPages > 0 ? [{ label: "Other pages", value: otherPages }] : []),
  ];

  // Every assistant PostHog saw, most visitors first; the page decides how many to show.
  base.assistants = (perAssistant ?? [])
    .map((r) => {
      const key = String(r[0] || "");
      const names = sourceNames(Array.isArray(r[4]) ? r[4] : []);
      return {
        key: key || "other",
        label: names[0] ?? (key || "Other"),
        sources: names,
        visitors: Number(r[1] || 0),
        sessions: Number(r[2] || 0),
        pageviews: Number(r[3] || 0),
        leads: 0, // filled from Metabase by the caller — PostHog does not hold leads
        topEntryPages: (perAssistantPages.get(key || "other") ?? [])
          .sort((x, y) => y.visitors - x.visitors)
          .slice(0, 4),
      } satisfies AssistantStat;
    })
    .sort((x, y) => y.visitors - x.visitors);

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
      return { key, label: sectionLabel(key), views: Number(r[1] || 0), visitors: Number(r[2] || 0) };
    })
    .sort((x, y) => y.views - x.views);

  return base;
}

/**
 * Month-by-month series driving the trend tables, asked a month at a time.
 *
 * This was one scan grouped by month, on the reasoning that twelve round trips
 * were twelve chances to time out. The query log says otherwise: January to
 * October reads 11–13 million rows, and that scan hit PostHog's 10 s limit on
 * load after load, leaving the table blank even on the tab's default view. A
 * month reads about 1.4 million and answers in a few seconds, and a month that
 * has ended is kept (askWindow), so a reload asks only about the current one.
 */
/** Month by month; null when PostHog did not answer, so an empty table is never mistaken for no traffic. */
export async function getAiMonthly(from: string, to: string): Promise<AiMonthRow[] | null> {
  if (!process.env.POSTHOG_API_KEY) return [];

  const parts = await Promise.all(
    monthWindows(from, to).map(async (w) => {
      const where = `event = '$pageview' AND ${rangeFilter(w.from, w.to)} AND ${hostFilter()} AND NOT ${BOT_EXPR}`;
      const [totals, assistants] = await Promise.all([
        askWindow(
          w,
          `SELECT formatDateTime(toStartOfMonth(timestamp), '%Y-%m') AS m, ` +
            `count() AS allPv, countIf(${inChannel("Organic Search", w)}) AS organicPv, ` +
            `uniqIf(person_id, ${inChannel("Organic Search", w)}) AS organicVisitors, ` +
            `uniqIf(person_id, ${inChannel("AI", w)}) AS aiVisitors ` +
            `FROM events WHERE ${where} GROUP BY m ORDER BY m`,
          40000,
        ),
        askWindow(
          w,
          `SELECT formatDateTime(toStartOfMonth(timestamp), '%Y-%m') AS m, ai.which AS which, ` +
            `count(DISTINCT person_id) AS visitors ` +
            `FROM events ${aiJoin(w)} WHERE ${where} GROUP BY m, which ORDER BY m`,
          40000,
        ),
      ]);
      // Both halves or neither: totals without the assistant split would show every assistant at zero.
      return totals && assistants ? { totals, assistants } : null;
    }),
  );
  // Every month or none: a table with a month missing would read as a month without traffic.
  if (parts.some((p) => !p)) return null;
  const totals = parts.flatMap((p) => p!.totals);
  const assistants = parts.flatMap((p) => p!.assistants);

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

// ═══════════════════════════════════════════════════════════════════
// Organic growth — the SEO tab's year, month by month.
//
// Whole months only, each asked on its own and kept once it has closed
// (askWindow), so a year costs PostHog a few questions a month, once.
// Visitors are people, counted within each month; the tab adds months up and
// says so. Careers pages are left out throughout: the people reading them are
// looking for a job, not a home.
// ═══════════════════════════════════════════════════════════════════

/** The careers section: job seekers, left out of the SEO tab's visitors. */
const CAREERS_SECTION = "join-our-team";
/** The site's own folders for the service lines the SEO tab follows by section. */
export const SERVICE_SECTIONS = {
  offPlan: ["off-plan", "developers", "search-projects"],
  propertyManagement: ["property-management"],
} as const;

const sqlList = (xs: readonly string[]) => xs.map((x) => `'${x.replace(/[\\']/g, "")}'`).join(", ");

export interface GrowthMonth {
  month: string; // YYYY-MM
  /** People in Organic Search visits, and in AI visits. */
  seo: number | null;
  ai: number | null;
  /** People in SEO or AI visits who read the off-plan, or the property management, section. */
  offPlan: number | null;
  propertyManagement: number | null;
  /** AI visitors by assistant (lib/aiSource.ts names). */
  byAssistant: Record<string, number> | null;
  /** AI visitors by the section of the first page they read that month. */
  aiLanding: Record<string, number> | null;
  /** People who came from a news site that has covered betterhomes, by site. */
  news: Record<string, number> | null;
  newsPeople: number | null;
}

export interface GrowthTraffic {
  connected: boolean;
  /** One per month asked, in order. */
  months: GrowthMonth[];
  /** The names each assistant arrived under, most visitors first. */
  assistantNames: Record<string, string[]>;
  error?: string;
}

/**
 * Organic and AI visitors month by month for the SEO tab, with the AI
 * channel's assistants and landing sections, the off-plan and property
 * management sections' visitors, and the people news sites sent.
 *
 * `newsSites` are the web sites that have covered betterhomes, from the press
 * bot's kept stories (lib/data.ts), so the list grows as coverage does.
 */
export async function getGrowthTraffic(months: string[], newsSites: string[]): Promise<GrowthTraffic> {
  const connected = !!process.env.POSTHOG_API_KEY;
  const blank = (month: string): GrowthMonth => ({
    month, seo: null, ai: null, offPlan: null, propertyManagement: null, byAssistant: null, aiLanding: null, news: null, newsPeople: null,
  });
  if (!connected) return { connected, months: months.map(blank), assistantNames: {} };

  const SECTION = sectionSql("properties.$pathname");
  const pv = (w: Window) =>
    `event = '$pageview' AND ${rangeFilter(w.from, w.to)} AND ${hostFilter()} AND NOT ${BOT_EXPR} AND ${SECTION} != '${CAREERS_SECTION}'`;
  const site = `replaceRegexpOne(lower(coalesce($entry_referring_domain, '')), '^www[.]', '')`;
  const fromNews = `arrayExists(h -> ${site} = h OR endsWith(${site}, concat('.', h)), [${sqlList(newsSites)}])`;
  const names = new Map<string, Map<string, number>>();

  const one = async (month: string): Promise<GrowthMonth> => {
    const [y, m] = month.split("-").map(Number);
    const w: Window = { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
    const [traffic, aiRows, newsRows] = await Promise.all([
      askWindow(
        w,
        `SELECT count(DISTINCT if(v.channel = 'Organic Search', person_id, NULL)), count(DISTINCT if(v.channel = 'AI', person_id, NULL)), ` +
          `count(DISTINCT if(${SECTION} IN (${sqlList(SERVICE_SECTIONS.offPlan)}), person_id, NULL)), ` +
          `count(DISTINCT if(${SECTION} IN (${sqlList(SERVICE_SECTIONS.propertyManagement)}), person_id, NULL)) ` +
          `FROM events INNER JOIN (SELECT session_id AS v_sid, $channel_type AS channel FROM sessions ` +
          `WHERE ${visitRange(w)} AND $channel_type IN ('Organic Search', 'AI')) AS v ON $session_id = v.v_sid WHERE ${pv(w)}`,
      ),
      // One row per AI visitor and assistant: the name it came under, and the section of their first page.
      askWindow(
        w,
        `SELECT person_id, ai.which AS which, ai.src AS src, toUnixTimestamp64Milli(min(timestamp)) AS first_at, argMin(${SECTION}, timestamp) AS first_section ` +
          `FROM events ${aiJoin(w)} WHERE ${pv(w)} GROUP BY person_id, which, src LIMIT ${ROW_CAP}`,
      ),
      newsSites.length
        ? askWindow(
            w,
            // A link or a news portal, never an ad or a social post: the coverage list also holds the odd
            // LinkedIn or Instagram post, and their ordinary social traffic is not news.
            `SELECT DISTINCT person_id, n.site AS site FROM events INNER JOIN (SELECT session_id AS n_sid, ${site} AS site FROM sessions ` +
              `WHERE ${visitRange(w)} AND $channel_type IN ('Referral', 'Organic Search') AND ${fromNews}) AS n ON $session_id = n.n_sid ` +
              `WHERE ${pv(w)} LIMIT ${ROW_CAP}`,
          )
        : Promise.resolve([] as any[][]),
    ]);

    const out = blank(month);
    const t = traffic?.[0];
    if (t) [out.seo, out.ai, out.offPlan, out.propertyManagement] = [Number(t[0] ?? 0), Number(t[1] ?? 0), Number(t[2] ?? 0), Number(t[3] ?? 0)];

    if (aiRows && aiRows.length < ROW_CAP) {
      const people = new Map<string, Set<string>>();
      const first = new Map<string, { at: number; section: string }>();
      for (const r of aiRows) {
        const pid = String(r[0]), which = String(r[1] || "other"), src = String(r[2] ?? "").replace(/^www\./, "");
        addTo(people, which, pid);
        const n = names.get(which) ?? new Map<string, number>();
        if (src) n.set(src, (n.get(src) ?? 0) + 1);
        names.set(which, n);
        const at = Number(r[3]), was = first.get(pid);
        if (!was || at < was.at) first.set(pid, { at, section: String(r[4] || "other") });
      }
      out.byAssistant = Object.fromEntries([...people].map(([k, s]) => [k, s.size]));
      const landing: Record<string, number> = {};
      for (const f of first.values()) landing[f.section] = (landing[f.section] ?? 0) + 1;
      out.aiLanding = landing;
    }

    if (newsRows && newsRows.length < ROW_CAP) {
      const bySite = new Map<string, Set<string>>();
      for (const r of newsRows) addTo(bySite, String(r[1] ?? ""), String(r[0]));
      out.news = Object.fromEntries([...bySite].map(([k, s]) => [k, s.size]));
      out.newsPeople = new Set(newsRows.map((r) => String(r[0]))).size;
    }
    return out;
  };

  const got = await Promise.all(months.map(one));
  const assistantNames = Object.fromEntries(
    [...names].map(([k, n]) => [k, [...n].sort((a, b) => b[1] - a[1]).map(([name]) => name)]),
  );
  const failed = got.some((g) => g.seo == null || g.byAssistant == null || g.news == null);
  return { connected, months: got, assistantNames, error: failed ? "PostHog did not answer for every month" : undefined };
}
