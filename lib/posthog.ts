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
// runs desktop Linux (BOT_EXPR). The SEO tab leaves those out; the Website tab
// counts every visit and shows how much of it is automated (lib/websiteGrowth.ts).
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
export const BOT_EXPR = `(coalesce(properties.$virt_is_bot, false) = true OR properties.$os = 'Linux')`;

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

export async function hogql(sql: string, timeoutMs = MIN_ATTEMPT_MS): Promise<any[][] | null> {
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

/**
 * A visit's channel, read off the sessions table: PostHog's own, except that a
 * visit our own site referred is Direct (see visitsSql).
 */
export const CHANNEL_SQL =
  `if($channel_type = 'Referral' AND (lower($entry_referring_domain) = 'bhomes.com' OR lower($entry_referring_domain) LIKE '%.bhomes.com'), 'Direct', $channel_type)`;

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
 * (visitRange).
 */
export const visitsSql = (range: string) =>
  `SELECT session_id AS v_sid, ${CHANNEL_SQL} AS channel, $entry_referring_domain AS ref FROM sessions WHERE ${range}`;

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
export function sectionSql(pathExpr: string): string {
  const p = `lower(coalesce(${pathExpr}, ''))`;
  return (
    `multiIf(match(${p}, '^/([a-z]{2}/?)?$'), 'home', ` +
    `coalesce(nullIf(extract(${p}, '^/(?:[a-z]{2}/)?([^/]+)'), ''), 'other'))`
  );
}

// ═══════════════════════════════════════════════════════════════════
// AI channel — what makes a visit AI.
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
// The channel is measured in PEOPLE: 1,415 sessions came from 1,227 people in
// August. AI visitors are each month's people in AI visits, bots and careers
// pages left out (growthTrafficSql below): the SEO tab's count, which the
// Dashboard's SEO card asks too.
// ═══════════════════════════════════════════════════════════════════

/** The visits PostHog started in a window, the day before included so a visit that crosses midnight keeps its channel. */
export const visitRange = (w: Window) =>
  `$start_timestamp >= toDateTime('${dayBefore(w.from)} 00:00:00') AND $start_timestamp <= toDateTime('${w.to} 23:59:59')`;

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

export function hostFilter(): string {
  return `(lower(properties.$host) = 'bhomes.com' OR lower(properties.$host) LIKE '%.bhomes.com')`;
}

export function rangeFilter(from: string, to: string): string {
  return `timestamp >= toDateTime('${from} 00:00:00') AND timestamp <= toDateTime('${to} 23:59:59')`;
}

// ── long ranges, a month at a time ─────────────────────────────────────────

export type Window = { from: string; to: string };

/** Most rows one API query hands back, even when asked for more. */
export const ROW_CAP = 50_000;

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

export async function askWindow(w: Window, sql: string, timeoutMs?: number): Promise<any[][] | null> {
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
export const CAREERS_SECTION = "join-our-team";
/** The site's own folders for the service lines the SEO tab follows by section. */
export const SERVICE_SECTIONS = {
  offPlan: ["off-plan", "developers", "search-projects"],
  propertyManagement: ["property-management"],
} as const;

export const sqlList = (xs: readonly string[]) => xs.map((x) => `'${x.replace(/[\\']/g, "")}'`).join(", ");

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
/** The SEO tab's pageviews: on the site, no bots, careers pages left out (job seekers are not the audience). */
const growthPageviews = (w: Window) =>
  `event = '$pageview' AND ${rangeFilter(w.from, w.to)} AND ${hostFilter()} AND NOT ${BOT_EXPR} AND ${sectionSql("properties.$pathname")} != '${CAREERS_SECTION}'`;

/**
 * The SEO tab's traffic question for one window: people from organic search,
 * people from AI assistants, then those who read the off-plan and the property
 * management sections, all by growthPageviews. The Dashboard's SEO card asks
 * it too (getOrganicVisitors), word for word, so a closed month's answer is
 * kept once for both.
 */
const growthTrafficSql = (w: Window) => {
  const SECTION = sectionSql("properties.$pathname");
  return (
    `SELECT count(DISTINCT if(v.channel = 'Organic Search', person_id, NULL)), count(DISTINCT if(v.channel = 'AI', person_id, NULL)), ` +
    `count(DISTINCT if(${SECTION} IN (${sqlList(SERVICE_SECTIONS.offPlan)}), person_id, NULL)), ` +
    `count(DISTINCT if(${SECTION} IN (${sqlList(SERVICE_SECTIONS.propertyManagement)}), person_id, NULL)) ` +
    `FROM events INNER JOIN (SELECT session_id AS v_sid, $channel_type AS channel FROM sessions ` +
    `WHERE ${visitRange(w)} AND $channel_type IN ('Organic Search', 'AI')) AS v ON $session_id = v.v_sid WHERE ${growthPageviews(w)}`
  );
};

/**
 * Organic and AI visitors over a range, counted as the SEO tab counts them:
 * people per calendar month (the first and last clipped to the range), added
 * up, careers pages left out. Organic here is search alone; the tab's organic
 * total is search plus AI.
 *
 * The Dashboard's SEO card asked another question until Nov 2026, through the
 * SEO & AI Channel report (since removed): careers pages in, people once
 * across the whole range, AI left out of organic. For the year to date it
 * read 9,575 AI visitors, 6.4% of organic, where the tab read 7,941 and 5.1%.
 */
export async function getOrganicVisitors(from: string, to: string): Promise<{ connected: boolean; seo: number | null; ai: number | null; error?: string }> {
  const connected = !!process.env.POSTHOG_API_KEY;
  if (!connected) return { connected, seo: null, ai: null };
  const got = await Promise.all(monthWindows(from, to).map((w) => askWindow(w, growthTrafficSql(w))));
  if (got.some((rows) => !rows?.[0])) return { connected, seo: null, ai: null, error: "PostHog did not answer for every month" };
  let seo = 0, ai = 0;
  for (const rows of got) {
    seo += Number(rows![0][0] ?? 0);
    ai += Number(rows![0][1] ?? 0);
  }
  return { connected, seo, ai };
}

export async function getGrowthTraffic(months: string[], newsSites: string[]): Promise<GrowthTraffic> {
  const connected = !!process.env.POSTHOG_API_KEY;
  const blank = (month: string): GrowthMonth => ({
    month, seo: null, ai: null, offPlan: null, propertyManagement: null, byAssistant: null, aiLanding: null, news: null, newsPeople: null,
  });
  if (!connected) return { connected, months: months.map(blank), assistantNames: {} };

  const SECTION = sectionSql("properties.$pathname");
  const pv = growthPageviews;
  const site = `replaceRegexpOne(lower(coalesce($entry_referring_domain, '')), '^www[.]', '')`;
  const fromNews = `arrayExists(h -> ${site} = h OR endsWith(${site}, concat('.', h)), [${sqlList(newsSites)}])`;
  const names = new Map<string, Map<string, number>>();

  const one = async (month: string): Promise<GrowthMonth> => {
    const [y, m] = month.split("-").map(Number);
    const w: Window = { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
    const [traffic, aiRows, newsRows] = await Promise.all([
      askWindow(w, growthTrafficSql(w)),
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
