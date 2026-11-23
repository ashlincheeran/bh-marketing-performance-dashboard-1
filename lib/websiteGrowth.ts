// The Website tab: bhomes.com month by month. Where visits came from, how much
// of it is noise, the careers site inside the property site, the enquiries the
// site brought and the business they led to, for a period of whole months
// (lib/growthPeriod.ts, by default the last 3) set against the same number of
// months just before, with at least a year of trend. Plus a look-up of any one
// page over the last 7, 30 or 90 days.
//
// Everything is live: PostHog for visits, the CRM (Metabase) for enquiries and
// outcomes. Two halves, as on the SEO tab: visits load with the page, and the
// CRM half is asked for once the page is open, so a slow CRM never holds up the
// rest. Every visit counts as PostHog records it, automated ones included:
// section 04 shows how much of it is noise rather than hiding it.
import { cacheKey, remembered, type RememberOptions } from "@/lib/cache";
import { FIRST_MONTH, endedMonth, monthBounds, resolvePeriod, type GrowthPeriod, type PeriodQuery } from "@/lib/growthPeriod";
import { DEAL_VALID, ENGAGE_START, IS_AI, IS_POPUP, LEAD_SCOPE, LEAD_SCOPE_JOIN, mbConfigured, mbQueryEx, utmJson } from "@/lib/metabase";
import type { SourceStatus } from "@/lib/organicGrowth";
import {
  BOT_EXPR, CAREERS_SECTION, CHANNEL_SQL, askWindow, hogql, hostFilter, rangeFilter, sectionSql, visitRange, visitsSql, type Window,
} from "@/lib/posthog";
import { ENQUIRY_CHANNELS, VISIT_CHANNELS, visitChannel, zeroes, type EnquiryChannel, type VisitChannel } from "@/lib/website";

/** The Engage cutover (lib/metabase.ts): the CRM's lead records begin here. */
const CRM_FIRST_MONTH = "2024-12";
/** How long one page's look-up is shown before PostHog is asked again. */
const LOOKUP_MS = 15 * 60_000;

const n = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => String(v ?? "");

// ── PostHog: what each month asks ────────────────────────────────────────────

/** Visits that began in a window, on bhomes.com. */
const begun = (w: Window) =>
  `$start_timestamp >= toDateTime('${w.from} 00:00:00') AND $start_timestamp <= toDateTime('${w.to} 23:59:59') ` +
  `AND (lower($entry_hostname) = 'bhomes.com' OR lower($entry_hostname) LIKE '%.bhomes.com')`;
/** Events on bhomes.com in a window. */
const within = (w: Window) => `${rangeFilter(w.from, w.to)} AND ${hostFilter()}`;
/** An event off the careers pages, where the careers form lives. */
const OFF_CAREERS = `${sectionSql("properties.$pathname")} != '${CAREERS_SECTION}'`;
/** A form sent: the site names each submission lead_<form>. */
const SENT = `startsWith(event, 'lead_')`;
/** The form an open or a send belongs to: the name the site gives it, or the event's own. */
const FORM = `coalesce(nullIf(toString(properties.form_name), ''), if(event = 'click_open_form', '(unnamed form)', replaceRegexpOne(event, '^lead_', '')))`;
const people = (cond: string) => `count(DISTINCT if(${cond}, person_id, NULL))`;

/** The PostHog questions behind each month, for a window. Exported so a test can read them. */
export const websiteSql = {
  /** Visits by channel and by whether they began on a careers page, and how many lasted under 5 seconds. */
  visits: (w: Window) =>
    `SELECT ${CHANNEL_SQL} AS channel, ${sectionSql("$entry_pathname")} = '${CAREERS_SECTION}' AS careers, count() AS visits, ` +
    `countIf($session_duration < 5) AS short FROM sessions WHERE ${begun(w)} GROUP BY channel, careers`,
  /** Visitors by country: everyone, and those PostHog flags as automated or that run desktop Linux. */
  countries: (w: Window) =>
    `SELECT coalesce(nullIf(properties.$geoip_country_name, ''), 'Unknown') AS country, count(DISTINCT person_id) AS visitors, ` +
    `${people(BOT_EXPR)} AS automated FROM events WHERE event = '$pageview' AND ${within(w)} GROUP BY country ORDER BY visitors DESC LIMIT 30`,
  devices: (w: Window) =>
    `SELECT coalesce(nullIf(properties.$device_type, ''), 'Unknown') AS device, count(DISTINCT person_id) AS visitors ` +
    `FROM events WHERE event = '$pageview' AND ${within(w)} GROUP BY device ORDER BY visitors DESC`,
  /** Page views by the site's own sections, every page. */
  sections: (w: Window) =>
    `SELECT ${sectionSql("properties.$pathname")} AS section, count() AS views FROM events WHERE event = '$pageview' AND ${within(w)} ` +
    `GROUP BY section ORDER BY views DESC LIMIT 40`,
  /** People who opened each form and who sent it, careers pages left out. */
  forms: (w: Window) =>
    `SELECT ${FORM} AS form, ${people("event = 'click_open_form'")} AS opened, ${people(SENT)} AS sent FROM events ` +
    `WHERE (event = 'click_open_form' OR ${SENT}) AND ${within(w)} AND ${OFF_CAREERS} GROUP BY form ORDER BY opened DESC, sent DESC LIMIT 40`,
  /** People who clicked a call to action, opened a form, searched, viewed a gallery and sent a form, careers pages left out. */
  actions: (w: Window) =>
    `SELECT ${people("event = 'cta_click'")}, ${people("event = 'click_open_form'")}, ${people("event = 'search'")}, ` +
    `${people("event = 'gallery_view'")}, ${people(SENT)} FROM events ` +
    `WHERE (event IN ('cta_click', 'click_open_form', 'search', 'gallery_view') OR ${SENT}) AND ${within(w)} AND ${OFF_CAREERS}`,
  /** People who sent a form, careers pages left out, by how their visit arrived. */
  senders: (w: Window) =>
    `SELECT v.channel AS channel, count(DISTINCT person_id) AS people FROM events INNER JOIN (${visitsSql(visitRange(w))}) AS v ON $session_id = v.v_sid ` +
    `WHERE ${SENT} AND ${within(w)} AND ${OFF_CAREERS} GROUP BY channel`,
};

export interface VisitMonth {
  /** Visits by how they arrived: those that began on a careers page, and the rest. */
  channels: Record<VisitChannel, { site: number; careers: number }>;
  /** Direct visits, careers left out, that lasted under 5 seconds. */
  directShort: number;
}

export interface VisitDetail {
  month: string;
  countries: { country: string; visitors: number; automated: number }[] | null;
  devices: Record<string, number> | null;
  sections: Record<string, number> | null;
  forms: { form: string; opened: number; sent: number }[] | null;
  actions: { clicked: number; opened: number; searched: number; gallery: number; sent: number } | null;
  senders: Partial<Record<VisitChannel, number>> | null;
}

export interface WebsiteReport {
  /** When this answer was worked out (lib/cache.ts). */
  cachedAt?: string | null;
  period: GrowthPeriod;
  /** Every month below is one of these, oldest first: period.months. */
  months: string[];
  /** One per month: null where PostHog did not answer, or before it recorded the site. */
  visits: (VisitMonth | null)[];
  /** One per month of the period itself (period.from to period.to), each part null where PostHog did not answer. */
  detail: VisitDetail[];
  sources: SourceStatus[];
  generatedAt: string;
}

const monthWindow = (m: string): Window => {
  const b = monthBounds(m);
  return { from: b.from, to: b.to };
};

const visitKeys: VisitChannel[] = [...VISIT_CHANNELS.map((c) => c.key), "direct"];

/** One month's visits by channel, or null when PostHog did not answer. */
export function readVisits(rows: unknown[][] | null): VisitMonth | null {
  if (!rows) return null;
  const channels = Object.fromEntries(visitKeys.map((k) => [k, { site: 0, careers: 0 }])) as VisitMonth["channels"];
  let directShort = 0;
  for (const r of rows) {
    const k = visitChannel(str(r[0]));
    const careers = r[1] === true || n(r[1]) === 1;
    channels[k][careers ? "careers" : "site"] += n(r[2]);
    if (k === "direct" && !careers) directShort += n(r[3]);
  }
  return { channels, directShort };
}

async function visitDetail(month: string): Promise<VisitDetail> {
  const w = monthWindow(month);
  const [countries, devices, sections, forms, actions, senders] = await Promise.all([
    askWindow(w, websiteSql.countries(w)),
    askWindow(w, websiteSql.devices(w)),
    askWindow(w, websiteSql.sections(w)),
    askWindow(w, websiteSql.forms(w)),
    askWindow(w, websiteSql.actions(w)),
    askWindow(w, websiteSql.senders(w)),
  ]);
  const a = actions?.[0];
  const bySender: Partial<Record<VisitChannel, number>> = {};
  for (const r of senders ?? []) {
    const k = visitChannel(str(r[0]));
    bySender[k] = (bySender[k] ?? 0) + n(r[1]);
  }
  return {
    month,
    countries: countries?.map((r) => ({ country: str(r[0]), visitors: n(r[1]), automated: n(r[2]) })) ?? null,
    devices: devices ? Object.fromEntries(devices.map((r) => [str(r[0]), n(r[1])])) : null,
    sections: sections ? Object.fromEntries(sections.map((r) => [str(r[0]), n(r[1])])) : null,
    forms: forms?.map((r) => ({ form: str(r[0]), opened: n(r[1]), sent: n(r[2]) })) ?? null,
    actions: actions ? { clicked: n(a?.[0]), opened: n(a?.[1]), searched: n(a?.[2]), gallery: n(a?.[3]), sent: n(a?.[4]) } : null,
    senders: senders ? bySender : null,
  };
}

/** The visits half for a period, remembered (lib/cache.ts) and kept only when PostHog answered every question. */
export async function getWebsiteReport(q: PeriodQuery = {}, opts: RememberOptions = {}): Promise<WebsiteReport> {
  const period = resolvePeriod(q, endedMonth());
  const answer = await remembered(
    cacheKey("websiteGrowth", { from: period.from, to: period.to }),
    () => computeWebsiteReport(period),
    (d) => d.sources.every((x) => x.state === "ok"),
    opts,
  );
  // The period as asked for now, never the one an answer was kept under (see lib/organicGrowth.ts).
  return { ...answer, period };
}

async function computeWebsiteReport(period: GrowthPeriod): Promise<WebsiteReport> {
  const connected = !!process.env.POSTHOG_API_KEY;
  const months = period.months;
  const tracked = months.filter((m) => m >= FIRST_MONTH);
  const inPeriod = months.filter((m) => m >= period.from && m <= period.to);
  const [visits, detail] = await Promise.all([
    Promise.all(months.map((m) => (connected && m >= FIRST_MONTH ? askWindow(monthWindow(m), websiteSql.visits(monthWindow(m))).then(readVisits) : null))),
    Promise.all(inPeriod.map(visitDetail)),
  ]);

  const missedMonths = tracked.filter((m) => visits[months.indexOf(m)] == null);
  const missedParts = detail.flatMap((d) =>
    (["countries", "devices", "sections", "forms", "actions", "senders"] as const).filter((k) => d[k] == null).map((k) => `${k} in ${d.month}`),
  );
  const sources: SourceStatus[] = [
    !connected
      ? { name: "PostHog", state: "off", detail: "no API key configured" }
      : tracked.length && missedMonths.length === tracked.length
        ? { name: "PostHog", state: "down", detail: "did not answer for any month; visit figures are blank, not zero" }
        : missedMonths.length || missedParts.length
          ? { name: "PostHog", state: "partial", detail: `did not answer for ${[...missedMonths, ...missedParts].slice(0, 6).join(", ")}; reload to try again` }
          : { name: "PostHog", state: "ok", detail: "answered" },
  ];
  return { period, months, visits, detail, sources, generatedAt: new Date().toISOString() };
}

// ── the CRM half ─────────────────────────────────────────────────────────────

const src = utmJson("source");
const med = utmJson("medium");

/** A job application: the careers form writes the applicant's CV first ("CV: …"), whatever source the CRM files it under. */
export const IS_JOB = `COALESCE(l.message, '') LIKE 'CV:%'`;
/** An enquiry made on the website: filed under the website, an AI assistant or an on-site pop-up. */
const ON_WEBSITE = `(LOWER(l.enquiry_source) = 'website' OR ${IS_AI} OR ${IS_POPUP})`;
/** A paid tag, in the spellings the campaigns use. */
const PAID = `${med} IN ('cpc', 'ppc', 'paid', 'paid social', 'paid_social', 'paid-social', 'paidsocial', 'paid search', 'paid_search', 'paid-search', 'paidsearch')`;
/** The channel an enquiry carried in its tags (lib/websiteChannels.ts, ENQUIRY_CHANNELS). */
export const ENQUIRY_CHANNEL =
  `CASE WHEN ${IS_AI} THEN 'ai' WHEN ${IS_POPUP} THEN 'popup' WHEN COALESCE(${src}, '') = '' THEN 'untagged' ` +
  `WHEN ${PAID} AND ${src} REGEXP 'google|adwords|bing' THEN 'paidSearch' WHEN ${PAID} THEN 'paidSocial' ` +
  `WHEN ${src} LIKE '%email%' OR ${med} LIKE '%email%' THEN 'email' ELSE 'other' END`;

/** The two CRM questions behind the Website tab, for a window of whole months. Exported so a test can read them. */
export function websiteCrmSql(from: string, to: string): { leads: string; outcomes: string } {
  const window = (col: string) => `${col} >= '${from} 00:00:00' AND ${col} <= '${to} 23:59:59'`;
  // Each person once per month and channel, once per month as an enquirer, and once as an applicant.
  const leads =
    `SELECT m, kind, ch, COUNT(DISTINCT cid) people FROM (` +
    `SELECT DATE_FORMAT(l.created_at, '%Y-%m') m, l.customer_id cid, CASE WHEN ${IS_JOB} THEN 'jobs' ELSE 'enquiries' END kind, ${ENQUIRY_CHANNEL} ch ` +
    `FROM leads l ${LEAD_SCOPE_JOIN} WHERE ${window("l.created_at")} AND ${LEAD_SCOPE} AND (${ON_WEBSITE} OR ${IS_JOB})` +
    `) t GROUP BY m, kind, ch WITH ROLLUP`;
  // Each person's first website enquiry since the Engage cutover, and the channel it carried.
  const touch =
    `SELECT cid, created_at first_at, ch FROM (SELECT l.customer_id cid, l.created_at, ${ENQUIRY_CHANNEL} ch, ` +
    `ROW_NUMBER() OVER (PARTITION BY l.customer_id ORDER BY l.created_at, l.id) k FROM leads l ${LEAD_SCOPE_JOIN} ` +
    `WHERE l.created_at >= '${ENGAGE_START}' AND l.created_at <= '${to} 23:59:59' AND ${LEAD_SCOPE} AND ${ON_WEBSITE} AND NOT (${IS_JOB})) w WHERE k = 1`;
  const demand = `td.cid IS NOT NULL AND d.created_at >= td.first_at AND dl.created_at >= td.first_at`;
  const supply = `ts.cid IS NOT NULL AND d.created_at >= ts.first_at AND li.created_at >= ts.first_at`;
  const outcomes =
    `WITH touch AS (${touch}) ` +
    `SELECT 'listed' k, DATE_FORMAT(li.created_at, '%Y-%m') m, tc.ch ch, COUNT(DISTINCT li.id) n, 0 comm ` +
    `FROM listings li JOIN leads l2 ON l2.id = li.lead_id JOIN touch tc ON tc.cid = l2.customer_id ` +
    `WHERE ${window("li.created_at")} AND li.created_at >= tc.first_at GROUP BY 1, 2, 3 ` +
    `UNION ALL ` +
    `SELECT k, m, ch, COUNT(*) n, SUM(comm) comm FROM (` +
    `SELECT CASE WHEN d.status = 'Completed' THEN 'completed' WHEN d.status = 'Reserved' AND d.state = 'Open' THEN 'awaiting' ELSE 'ended' END k, ` +
    `DATE_FORMAT(d.created_at, '%Y-%m') m, CASE WHEN ${demand} THEN td.ch ELSE ts.ch END ch, ` +
    // A deal carries its final or its reserved commission, never both (bh-crm-metabase).
    `GREATEST(COALESCE(d.final_gross_commission_amount, 0), COALESCE(d.reserved_gross_commission_amount, 0)) comm ` +
    `FROM deals d LEFT JOIN leads dl ON dl.id = d.lead_id LEFT JOIN touch td ON td.cid = dl.customer_id ` +
    `LEFT JOIN listings li ON li.id = d.listing_id LEFT JOIN leads ll ON ll.id = li.lead_id LEFT JOIN touch ts ON ts.cid = ll.customer_id ` +
    `WHERE ${window("d.created_at")} AND ${DEAL_VALID} AND ((${demand}) OR (${supply}))` +
    `) x GROUP BY k, m, ch`;
  return { leads, outcomes };
}

export interface WebsiteCrmMonth {
  month: string;
  /** People with a website enquiry that month, by the channel it carried; and in all, each person once. Job applications left out. */
  enquiries: Record<EnquiryChannel, number>;
  enquirers: number;
  /** People who applied for a job through the careers form. */
  jobs: number;
  /** Listings placed, and deals reserved and completed, that month by people whose first website enquiry came first, by its channel. */
  listed: Record<EnquiryChannel, number>;
  reserved: Record<EnquiryChannel, number>;
  completed: Record<EnquiryChannel, number>;
  /** Of the deals reserved, those still awaiting completion. */
  awaiting: number;
  /** Gross commission on those deals: completed, and reserved still awaiting completion. */
  commission: { completed: number; awaiting: number };
}

export interface WebsiteCrmReport {
  cachedAt?: string | null;
  /** The same months as the visits half: period.months. */
  months: string[];
  /** One per month: zeros for a month with nothing, null before the CRM's records begin or when it did not answer. */
  crm: (WebsiteCrmMonth | null)[];
  connected: boolean;
  error?: string;
  generatedAt: string;
}

const isChannel = (k: string): k is EnquiryChannel => ENQUIRY_CHANNELS.some((c) => c.key === k);
const blankCrmMonth = (month: string): WebsiteCrmMonth => ({
  month, enquiries: zeroes(ENQUIRY_CHANNELS), enquirers: 0, jobs: 0,
  listed: zeroes(ENQUIRY_CHANNELS), reserved: zeroes(ENQUIRY_CHANNELS), completed: zeroes(ENQUIRY_CHANNELS),
  awaiting: 0, commission: { completed: 0, awaiting: 0 },
});

/** The CRM's two answers as months. Exported so a test can feed it rows. */
export function readWebsiteCrm(leads: unknown[][], outcomes: unknown[][]): Map<string, WebsiteCrmMonth> {
  const byMonth = new Map<string, WebsiteCrmMonth>();
  const month = (m: string) => byMonth.get(m) ?? byMonth.set(m, blankCrmMonth(m)).get(m)!;
  // WITH ROLLUP: a NULL channel is the kind's own row, each person once; a NULL kind is the month's, a NULL month the grand total.
  for (const [m, kind, ch, v] of leads) {
    if (m == null || kind == null) continue;
    const row = month(str(m));
    if (ch == null) {
      if (kind === "jobs") row.jobs = n(v);
      else row.enquirers = n(v);
    } else if (kind === "enquiries" && isChannel(str(ch))) row.enquiries[str(ch) as EnquiryChannel] = n(v);
  }
  for (const [k, m, ch, v, comm] of outcomes) {
    const c = str(ch);
    if (!m || !isChannel(c)) continue;
    const row = month(str(m));
    if (k === "listed") {
      row.listed[c] += n(v);
      continue;
    }
    row.reserved[c] += n(v);
    if (k === "completed") {
      row.completed[c] += n(v);
      row.commission.completed += n(comm);
    } else if (k === "awaiting") {
      row.awaiting += n(v);
      row.commission.awaiting += n(comm);
    }
  }
  return byMonth;
}

/** The CRM half for a period, remembered and kept only when the CRM answered both questions. */
export async function getWebsiteCrmReport(q: PeriodQuery = {}, opts: RememberOptions = {}): Promise<WebsiteCrmReport> {
  const { months } = resolvePeriod(q, endedMonth());
  return remembered(
    cacheKey("websiteGrowthCrm", { first: months[0], last: months[months.length - 1] }),
    async () => {
      const connected = mbConfigured();
      const asked = months.filter((m) => m >= CRM_FIRST_MONTH);
      const blank = (error?: string): WebsiteCrmReport => ({ months, crm: months.map(() => null), connected, error, generatedAt: new Date().toISOString() });
      if (!connected) return blank();
      if (!asked.length) return { ...blank(), crm: months.map(() => null) };
      const sql = websiteCrmSql(monthBounds(asked[0]).from, monthBounds(asked[asked.length - 1]).to);
      const [leads, outcomes] = await Promise.all([mbQueryEx(sql.leads, true, 60_000), mbQueryEx(sql.outcomes, true, 60_000)]);
      if ("error" in leads) return blank(`Metabase reachable, but the enquiries query failed: ${leads.error}`);
      if ("error" in outcomes) return blank(`Metabase reachable, but the listings and deals query failed: ${outcomes.error}`);
      const byMonth = readWebsiteCrm(leads.rows, outcomes.rows);
      return {
        months,
        crm: months.map((m) => (m >= CRM_FIRST_MONTH ? (byMonth.get(m) ?? blankCrmMonth(m)) : null)),
        connected,
        generatedAt: new Date().toISOString(),
      };
    },
    (d) => d.connected && !d.error,
    opts,
  );
}

// ── one page, looked up ──────────────────────────────────────────────────────

/** The questions behind one page's look-up, over the last `days` days. Exported so a test can read them. */
export function lookupSql(path: string, days: number) {
  const at = (expr: string) => `replaceRegexpOne(lower(${expr}), '/+$', '') = '${path}'`;
  const since = `timestamp >= now() - INTERVAL ${days} DAY AND ${hostFilter()}`;
  const onPage = `${since} AND ${at("properties.$pathname")}`;
  const viewed = `event = '$pageview' AND ${onPage}`;
  return {
    overview:
      `SELECT countIf(event = '$pageview'), ${people("event = '$pageview'")}, ` +
      `round(avgIf(toFloat(properties.$prev_pageview_duration), event = '$pageleave' AND toFloat(properties.$prev_pageview_duration) BETWEEN 0 AND 1800)), ` +
      `round(avgIf(toFloat(properties.$prev_pageview_max_scroll_percentage), event = '$pageleave') * 100), ` +
      `countIf(event = 'cta_click'), ${people("event = 'cta_click'")}, ${people("event = 'click_open_form'")}, ${people(SENT)} ` +
      `FROM events WHERE ${onPage} AND (event IN ('$pageview', '$pageleave', 'cta_click', 'click_open_form') OR ${SENT})`,
    entrances:
      `SELECT count(), round(100 * avg(toFloat($is_bounce)), 1), round(avg($session_duration)), round(avg($pageview_count), 2) FROM sessions ` +
      `WHERE $start_timestamp >= now() - INTERVAL ${days} DAY AND ${at("$entry_pathname")} ` +
      `AND (lower($entry_hostname) = 'bhomes.com' OR lower($entry_hostname) LIKE '%.bhomes.com')`,
    trend:
      `SELECT toDate(toTimeZone(timestamp, 'Asia/Dubai')) AS day, count(), count(DISTINCT person_id) FROM events WHERE ${viewed} GROUP BY day ORDER BY day`,
    sources:
      `SELECT v.channel AS channel, count(DISTINCT person_id) AS visitors FROM events INNER JOIN (${visitsSql(`$start_timestamp >= now() - INTERVAL ${days + 1} DAY`)}) AS v ` +
      `ON $session_id = v.v_sid WHERE ${viewed} GROUP BY channel ORDER BY visitors DESC`,
    clicks:
      `SELECT coalesce(nullIf(properties.cta_text, ''), nullIf(properties.cta_name, ''), '(unnamed)') AS button, coalesce(properties.cta_location, '') AS place, ` +
      `coalesce(properties.cta_url, '') AS target, count() AS clicks, count(DISTINCT person_id) FROM events WHERE event = 'cta_click' AND ${onPage} ` +
      `GROUP BY button, place, target ORDER BY clicks DESC LIMIT 12`,
    next:
      `SELECT if(coalesce(nxt, '') = '', '(left the site)', if(nxt = '${path}', '(same page: filters or pagination)', nxt)) AS next_page, count() AS views FROM (` +
      `SELECT p, leadInFrame(p) OVER (PARTITION BY sid ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS nxt FROM (` +
      `SELECT $session_id AS sid, timestamp AS ts, replaceRegexpOne(lower(properties.$pathname), '/+$', '') AS p FROM events ` +
      `WHERE event = '$pageview' AND ${since} AND $session_id IN (SELECT $session_id FROM events WHERE ${viewed}))) ` +
      `WHERE p = '${path}' GROUP BY next_page ORDER BY views DESC LIMIT 10`,
    forms:
      `SELECT ${FORM} AS form, ${people("event = 'click_open_form'")} AS opened, ${people(SENT)} AS sent FROM events ` +
      `WHERE (event = 'click_open_form' OR ${SENT}) AND ${onPage} GROUP BY form ORDER BY opened DESC, sent DESC LIMIT 12`,
    devices:
      `SELECT coalesce(nullIf(properties.$device_type, ''), 'Unknown') AS device, count(DISTINCT person_id) AS visitors FROM events ` +
      `WHERE ${viewed} GROUP BY device ORDER BY visitors DESC`,
  };
}

export interface PageLookup {
  cachedAt?: string | null;
  path: string;
  days: number;
  /** Each part null where PostHog did not answer. */
  overview: { views: number; visitors: number; seconds: number | null; scroll: number | null; clicks: number; clickers: number; openers: number; senders: number } | null;
  entrances: { visits: number; bounce: number | null; seconds: number | null; pages: number | null } | null;
  trend: { day: string; views: number; visitors: number }[] | null;
  sources: { channel: VisitChannel; visitors: number }[] | null;
  clicks: { button: string; place: string; target: string; clicks: number; people: number }[] | null;
  next: { page: string; views: number }[] | null;
  forms: { form: string; opened: number; sent: number }[] | null;
  devices: { device: string; visitors: number }[] | null;
  connected: boolean;
  generatedAt: string;
}

/** A figure PostHog may leave empty (no time on page recorded): null, never zero. */
const maybe = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** One page's traffic, engagement, clicks, forms and next pages, kept for LOOKUP_MS and kept only when PostHog answered in full. */
export async function getPageLookup(path: string, days: number): Promise<PageLookup> {
  return remembered(
    cacheKey("pageLookup", { path, days }),
    async () => {
      const connected = !!process.env.POSTHOG_API_KEY;
      const q = lookupSql(path, days);
      const [ov, en, tr, so, cl, nx, fo, de] = connected
        ? await Promise.all([q.overview, q.entrances, q.trend, q.sources, q.clicks, q.next, q.forms, q.devices].map((sql) => hogql(sql)))
        : Array<null>(8).fill(null);
      const o = ov?.[0], e = en?.[0];
      return {
        path, days, connected, generatedAt: new Date().toISOString(),
        overview: o ? { views: n(o[0]), visitors: n(o[1]), seconds: maybe(o[2]), scroll: maybe(o[3]), clicks: n(o[4]), clickers: n(o[5]), openers: n(o[6]), senders: n(o[7]) } : null,
        entrances: e ? { visits: n(e[0]), bounce: maybe(e[1]), seconds: maybe(e[2]), pages: maybe(e[3]) } : null,
        trend: tr?.map((r) => ({ day: str(r[0]).slice(0, 10), views: n(r[1]), visitors: n(r[2]) })) ?? null,
        sources: so ? Object.entries(so.reduce<Record<string, number>>((acc, r) => {
          const k = visitChannel(str(r[0]));
          acc[k] = (acc[k] ?? 0) + n(r[1]);
          return acc;
        }, {})).map(([channel, visitors]) => ({ channel: channel as VisitChannel, visitors })).sort((a, b) => b.visitors - a.visitors) : null,
        clicks: cl?.map((r) => ({ button: str(r[0]), place: str(r[1]), target: str(r[2]), clicks: n(r[3]), people: n(r[4]) })) ?? null,
        next: nx?.map((r) => ({ page: str(r[0]), views: n(r[1]) })) ?? null,
        forms: fo?.map((r) => ({ form: str(r[0]), opened: n(r[1]), sent: n(r[2]) })) ?? null,
        devices: de?.map((r) => ({ device: str(r[0]), visitors: n(r[1]) })) ?? null,
      };
    },
    (d) => d.connected && [d.overview, d.entrances, d.trend, d.sources, d.clicks, d.next, d.forms, d.devices].every((x) => x != null),
    { maxAgeMs: LOOKUP_MS },
  );
}
