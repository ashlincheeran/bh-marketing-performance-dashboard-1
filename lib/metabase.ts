// Metabase (betterhomes CRM) — organic & AI leads, and their pipeline stage /
// open-closed status. Server-only.
//
// Runs native SQL against the Metabase `leads` view via the dataset API. Auth is
// either a username/password login (Metabase session) OR an API key. Set (missing
// → graceful "not connected"):
//   METABASE_URL       e.g. "https://metabase.yourco.com"
//   METABASE_USERNAME  Metabase login email  ── used together (session auth)
//   METABASE_PASSWORD  Metabase login password ─┘
//   METABASE_API_KEY   optional alternative to username/password
//   METABASE_DB_ID     the database id (defaults to 14)
//
// Lead taxonomy (confirmed against the `leads` view):
//   • AI lead      — utm.source or enquiry_source is an LLM domain (chatgpt.com…)
//   • Organic lead — enquiry_source='website' with no utm, OR a website pop-up
//   • Stage        — the `status` column (New · Qualified · … · Deal)
//   • Status       — the `state`  column (Open · Closed · Completed)
import { clearNotification, notify } from "@/lib/notify";

const DB_ID = Number(process.env.METABASE_DB_ID || 14);

/**
 * Every spelling of an assistant the CRM actually holds, not just the domains.
 *
 * Matching is exact (SQL IN), and the list used to carry only the full domains.
 * A distinct-values pass over 2026 leads found three more in use: bare
 * "chatgpt" and "gemini", and "copilot.com" rather than copilot.microsoft.com —
 * five AI leads counted as something else, including the Copilot lead the
 * August report names. The bare forms for the remaining assistants are listed
 * too: the pattern demonstrably occurs, and none of these words can mean
 * anything but the assistant.
 */
const LLM_DOMAINS = [
  "chatgpt.com", "chatgpt", "openai.com", "openai",
  "gemini.google.com", "gemini",
  "perplexity.ai", "perplexity",
  "claude.ai", "claude",
  "copilot.microsoft.com", "copilot.com", "copilot",
];

export interface LeadsData {
  connected: boolean;
  label: string;
  aiLeads: number;
  organicLeads: number;
  websiteNoUtm: number;
  popup: number;
  aiBySource: { source: string; n: number }[];
  stage: { segment: string; stage: string; n: number }[]; // pipeline (status col)
  status: { segment: string; status: string; n: number }[]; // open/closed (state col)
  /** Buyer / Landlord / Seller / Tenant — the lead's own `type` column. */
  leadType: { segment: string; type: string; n: number }[];
  /**
   * Deals created in the window, attributed to the channel of the LEAD they
   * came from (deals.lead_id → leads). Same DEAL_VALID rule as Company
   * Performance. Checked against the August report: organic 10 in July and 6
   * in August, AI 0 — an exact match.
   */
  deals: { ai: number; organic: number };
  /**
   * AI and organic leads in the window that LEAD_SCOPE left out — staff form
   * tests, imports, GoYzer. Reported so the figures still reconcile with
   * anything counted the old way (August 2026: 993 organic before, 972 after).
   */
  excluded: number;
  /**
   * Raw enquiry_source × utm.source × utm.medium counts with the bucket each
   * combination lands in. The classification below is all inference over free
   * text, so this is the audit trail: it shows what actually exists in the view
   * and, in particular, what fell into 'other' rather than organic or ai.
   */
  sourceAudit: { enquirySource: string; utmSource: string; utmMedium: string; segment: string; n: number }[];
  error?: string;
}


const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// SQL fragments (reused across the queries)
// `utm` is read defensively. JSON_EXTRACT raises "Invalid JSON text" and fails
// the ENTIRE query if a single row holds something that isn't JSON — which a
// column fed by web forms eventually will. JSON_VALID gates every access so one
// bad row yields NULL instead of killing the whole card.
//
// The NULLIF is load-bearing, not defensive. `utm` holds all six keys even when
// empty, so an untagged form submit stores {"source": null, ...}. JSON_UNQUOTE
// renders that JSON null as the *string* 'null', which is neither SQL NULL nor
// '' — so "has no utm source" tests silently failed on it. In one sample month
// 755 of 917 website leads (82%) carried it, and every one was classified
// 'other' instead of organic. Folding 'null' back to SQL NULL here is what makes
// IS_WEB_NOUTM below actually mean what it says.
//
// Every fragment reads the lead as `l`. Lead counts join `customers c` for the
// lead scope below, and both tables carry `type` and `created_at`, so a bare
// column name would be ambiguous.
const utmJson = (key: string) => `NULLIF(CASE WHEN JSON_VALID(l.utm) THEN LOWER(JSON_UNQUOTE(JSON_EXTRACT(l.utm,'$.${key}'))) END, 'null')`;
const utmSource = utmJson("source");
const utmMedium = utmJson("medium");
const llmList = LLM_DOMAINS.map((d) => `'${d}'`).join(",");
const IS_AI = `(${utmSource} IN (${llmList}) OR LOWER(l.enquiry_source) IN (${llmList}))`;
// Pop-up tags are hand-written and inconsistent — 'pop-up', 'website_pop-up' and
// 'website-popup' all occur. Stripping hyphens first collapses every spelling
// onto one pattern; matching '%pop-up%' alone missed the unhyphenated form.
const noHyphen = (e: string) => `REPLACE(${e}, '-', '')`;
const IS_POPUP = `(${noHyphen(utmSource)} LIKE '%popup%' OR ${noHyphen(utmMedium)} LIKE '%popup%' OR ${noHyphen("LOWER(l.enquiry_source)")} LIKE '%popup%')`;
const IS_WEB_NOUTM = `(LOWER(l.enquiry_source) = 'website' AND (l.utm IS NULL OR ${utmSource} IS NULL OR ${utmSource} = ''))`;
const SEG = `CASE WHEN ${IS_AI} THEN 'ai' WHEN (${IS_WEB_NOUTM} OR ${IS_POPUP}) THEN 'organic' ELSE 'other' END`;
// The finer split. `organic` is website+popup, so SEG is derivable from this and
// only one of the two needs to be computed in SQL.
const SUB = `CASE WHEN ${IS_AI} THEN 'ai' WHEN ${IS_WEB_NOUTM} THEN 'website' WHEN ${IS_POPUP} THEN 'popup' ELSE 'other' END`;
const segOf = (sub: string) => (sub === "ai" ? "ai" : sub === "website" || sub === "popup" ? "organic" : "other");

// ── Lead scope ──────────────────────────────────────────────────────────────
//
// Rows that are not enquiries, kept out of every lead count on every tab. Each
// rule was checked against the CRM on 20 Oct 2026, following the
// bh-crm-metabase rules:
//
//  • GoYzer, the old CRM. Never counted: its rows since the Engage cutover
//    arrive already completed, and the earlier ones are a migrated register.
//  • Bulk imports by the technology account: rows it created with no enquiry
//    source and no input channel at all. 98,648 of them landed on 19–20 April
//    2025, against about 550 leads on a normal day, and smaller batches
//    followed in July and August 2025. Left in, April 2025 reads as 113,151
//    leads and every "No Source" trend spikes. The same account also files
//    real leads through the feeds, so only the source-less rows are dropped.
//  • Internal staff cards, the technology team's named test contacts, and
//    company or vendor e-mail addresses: form tests, not clients.
//
// Cards the CRM marks "Agent" STAY IN, by the business's decision (20 Oct
// 2026): they are mostly outside brokers enquiring on our listings — 27,729
// cards behind a third of portal leads — and count as leads.
//
// Deals are never filtered by this: deals keyed into GoYzer and synced into
// Engage (all of them until spring 2026) are real outcomes and stay in.
const IMPORT_ACCOUNT_IDS = (process.env.CRM_IMPORT_ACCOUNT_IDS || "3")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
/** Masked names (first four, last four) of the technology team's test contacts. */
const TEST_CONTACTS = ["Sam %sefi", "Jasl%yeed", "Samn%amad", "Muqa%hman", "Moe %Reza", "Kali%Haq", "Taim%rwar", "Usma%amil", "Saji%aved"];

/** Join that brings in the contact card a lead belongs to — pair with LEAD_SCOPE. */
export const LEAD_SCOPE_JOIN = "JOIN customers c ON c.id = l.customer_id";
/**
 * The lead scope as a WHERE fragment over `leads l` and `customers c`.
 * Null-safe throughout: a NULL in any tested column must keep the row, never
 * silently drop it.
 */
export const LEAD_SCOPE = [
  `(l.input_source <> 'GoYzer' OR l.input_source IS NULL)`,
  `NOT (COALESCE(l.creator_id, 0) IN (${IMPORT_ACCOUNT_IDS.join(",") || "0"}) AND l.enquiry_source IS NULL AND l.input_source IS NULL)`,
  `COALESCE(c.type, '') <> 'Internal'`,
  `NOT (${TEST_CONTACTS.map((n) => `COALESCE(c.name, '') LIKE '${n}'`).join(" OR ")})`,
  `NOT (COALESCE(c.email, '') LIKE '%@bhomes.com' OR COALESCE(c.email, '') LIKE '%engageplatform%')`,
].join(" AND ");

/** UTM campaigns that are form tests, not campaigns ("test_campaign_…", "bh-test", "…formtest…").
 *  Real ads with "-ai-test-" or "-dt-test-" mid-name are creative tests and stay. */
const TEST_CAMPAIGN = `'^test|[-_]test$|formtest'`;

/** When Engage took over from GoYzer: the earliest a first touch can be. */
const ENGAGE_START = "2024-12-01 00:00:00";
const DEAL_VALID = `d.status IN ('Reserved','Closed','Completed') AND d.state <> 'Withdrawn'`;

// Session token from username/password, cached in-process, coalesced across
// concurrent callers, and refreshed on a 401.
let mbSession: { token: string; exp: number } | null = null;
let mbSessionInFlight: Promise<string | null> | null = null;

async function mbSessionToken(): Promise<string | null> {
  const url = process.env.METABASE_URL;
  const user = process.env.METABASE_USERNAME;
  const pass = process.env.METABASE_PASSWORD;
  if (!url || !user || !pass) return null;
  if (mbSession && mbSession.exp > Date.now()) return mbSession.token;
  if (mbSessionInFlight) return mbSessionInFlight;
  mbSessionInFlight = (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: user, password: pass }),
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (!res.ok) {
        console.error(`[metabase] session login failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
        return null;
      }
      const j = await res.json();
      if (!j?.id) {
        console.error("[metabase] session login: no token in response");
        return null;
      }
      mbSession = { token: String(j.id), exp: Date.now() + 13 * 864e5 }; // tokens last ~14d
      return mbSession.token;
    } catch (e) {
      console.error(`[metabase] session login error: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      clearTimeout(t);
    }
  })();
  try {
    return await mbSessionInFlight;
  } finally {
    mbSessionInFlight = null;
  }
}

export type MbResult = { rows: any[][] } | { error: string };

/**
 * Run native SQL and return either rows or the reason it failed.
 *
 * Metabase answers a FAILED native query with HTTP **202** and a body of
 * `{status:"failed", error:"<the real message>"}`. 202 is a 2xx, so `res.ok` is
 * true and the only hint of trouble is a missing `data.rows`. Callers that got
 * back a bare `null` therefore couldn't tell a broken query from a slow one and
 * reported everything as a timeout — while discarding the exact message Metabase
 * had already written down. So the payload is inspected here and the reason is
 * handed back.
 */
export async function mbQueryEx(sql: string, retry = true, timeoutMs = 20000): Promise<MbResult> {
  const r = await mbQueryRaw(sql, retry, timeoutMs);
  // One hook covers every caller, so a new query cannot forget to report.
  // Deliberately fire-and-forget: a slow feed must not slow the dashboard.
  if ("error" in r) {
    void notify("error", "metabase", "Metabase query failed", r.error, `metabase:${classifyMb(r.error)}`);
  } else {
    void clearNotification("metabase:timeout");
  }
  return r;
}

/** Group failures so a repeated timeout is one line, not one per query. */
function classifyMb(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("timed out")) return "timeout";
  if (m.includes("401") || m.includes("authenticate")) return "auth";
  if (m.includes("http 5")) return "server";
  return "other";
}

async function mbQueryRaw(sql: string, retry = true, timeoutMs = 20000): Promise<MbResult> {
  const url = process.env.METABASE_URL;
  if (!url) return { error: "METABASE_URL is not set" };
  const apiKey = process.env.METABASE_API_KEY;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  } else {
    const token = await mbSessionToken();
    if (!token) return { error: "could not authenticate" };
    headers["X-Metabase-Session"] = token;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/dataset`, {
      method: "POST",
      headers,
      body: JSON.stringify({ database: DB_ID, type: "native", native: { query: sql } }),
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (res.status === 401 && !apiKey && retry) {
      mbSession = null; // expired session — re-auth once
      clearTimeout(t);
      return mbQueryRaw(sql, false, timeoutMs);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      console.error(`[metabase] dataset HTTP ${res.status}: ${body}`);
      return { error: `HTTP ${res.status}${body ? ` — ${body}` : ""}` };
    }
    const j = await res.json();
    // The 202-with-failure case described above.
    if (j?.status === "failed" || (j?.error && !j?.data)) {
      const msg = String(j?.error ?? "query failed").slice(0, 300);
      console.error(`[metabase] query failed: ${msg}`);
      return { error: msg };
    }
    const rows = j?.data?.rows;
    if (!Array.isArray(rows)) {
      console.error(`[metabase] unexpected response shape: ${JSON.stringify(j).slice(0, 200)}`);
      return { error: "Metabase returned no data.rows (unexpected response shape)" };
    }
    return { rows };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    const msg = aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : e instanceof Error ? e.message : String(e);
    console.error(`[metabase] dataset error: ${msg}`);
    return { error: msg };
  } finally {
    clearTimeout(t);
  }
}

/** Rows, or null when it failed. For callers that only need "did it work". */
export async function mbQuery(sql: string, retry = true, timeoutMs = 20000): Promise<any[][] | null> {
  const r = await mbQueryEx(sql, retry, timeoutMs);
  return "rows" in r ? r.rows : null;
}

/**
 * CRM leads grouped by their UTM tags and pipeline position — the join surface
 * between paid campaigns and the CRM.
 *
 * One row per (utm_campaign, utm_source, utm_medium, stage, state) with a count.
 * Only leads that carry a utm_campaign are included: those are the ones that can
 * be attributed to a campaign at all. The Digital tab joins these to Supermetrics
 * rows by campaign name (and Meta campaign id), filters them by the UTM values,
 * and folds the stage counts into a funnel.
 *
 * Stage is a snapshot of where each lead sits NOW, so the funnel built from it
 * is current pipeline composition, not cohort progression over time.
 */
export interface CampaignLeadCell {
  campaign: string;
  source: string;
  medium: string;
  content: string;
  stage: string;
  state: string;
  n: number;
}
/**
 * One row per (lead, campaign-entity) membership. Engage attaches leads to
 * campaign ENTITIES via lead_campaigns, and an entity's `reference` is the
 * campaign_code. A lead typically links both to the entity mirroring its
 * utm_campaign and to an umbrella project code, so these rows deliberately
 * count a lead once per code — correct when reading one code, and exactly why
 * the page-wide totals come from `rows` (one row per lead) instead.
 */
export interface CodeLeadCell {
  code: string;
  campaign: string;
  stage: string;
  state: string;
  n: number;
}
export interface CampaignLeadsData {
  connected: boolean;
  label: string;
  /** Per-lead groups over the utm tags — the page-wide truth. */
  rows: CampaignLeadCell[];
  /** Per-(lead × code) groups — the campaign_code facet and the tree. */
  codeRows: CodeLeadCell[];
  /** Hit the row cap — smallest groups are missing. */
  truncated: boolean;
  error?: string;
}

export async function getCampaignLeads(fromRaw: string, toRaw: string): Promise<CampaignLeadsData> {
  const connected = !!(
    process.env.METABASE_URL &&
    (process.env.METABASE_API_KEY || (process.env.METABASE_USERNAME && process.env.METABASE_PASSWORD))
  );
  const base: CampaignLeadsData = { connected, label: `${fromRaw} → ${toRaw}`, rows: [], codeRows: [], truncated: false };
  if (!connected) return base;
  if (!isDate(fromRaw) || !isDate(toRaw)) return { ...base, error: "bad date range" };
  if (!process.env.METABASE_API_KEY) {
    const tok = await mbSessionToken();
    if (!tok) {
      return { ...base, error: "Metabase login failed — check METABASE_URL / METABASE_USERNAME / METABASE_PASSWORD." };
    }
  }
  const j = (key: string) => `NULLIF(CASE WHEN JSON_VALID(l.utm) THEN LOWER(JSON_UNQUOTE(JSON_EXTRACT(l.utm,'$.${key}'))) END, 'null')`;
  const clean = (e: string) => `COALESCE(NULLIF(TRIM(${e}), ''), '(none)')`;
  // Real enquiries only (LEAD_SCOPE), and no form-test campaigns: in the 90 days
  // to 20 Oct 2026 "test_campaign_wessam" was the second-largest "campaign" at
  // 227 leads, all of them on one day.
  const range =
    `l.created_at >= '${fromRaw} 00:00:00' AND l.created_at <= '${toRaw} 23:59:59' AND ${LEAD_SCOPE} ` +
    `AND NOT (COALESCE(${j("campaign")}, '') REGEXP ${TEST_CAMPAIGN})`;

  // Two grouped reads of the same range, in parallel:
  //  1. per-lead utm groups — page-wide totals, one row per lead, so nothing is
  //     double-counted;
  //  2. per-(lead × campaign-entity) groups via lead_campaigns → campaigns,
  //     whose `reference` is the campaign_code. The LEFT JOINs keep utm-tagged
  //     leads with no entity link, filed under '(unlinked)'.
  const [utmRes, codeRes] = await Promise.all([
    mbQueryEx(
      `SELECT ${clean(j("campaign"))} camp, ${clean(j("source"))} src, ${clean(j("medium"))} med, ${clean(j("content"))} content, ` +
        `CAST(l.status AS CHAR) stage, CAST(l.state AS CHAR) st, COUNT(*) n ` +
        `FROM leads l ${LEAD_SCOPE_JOIN} WHERE ${range} AND ${j("campaign")} IS NOT NULL AND TRIM(${j("campaign")}) <> '' ` +
        `GROUP BY 1,2,3,4,5,6 ORDER BY n DESC LIMIT 6000`,
      true,
      60000,
    ),
    mbQueryEx(
      `SELECT COALESCE(NULLIF(TRIM(LOWER(cp.reference)), ''), '(unlinked)') code, ${clean(j("campaign"))} camp, ` +
        `CAST(l.status AS CHAR) stage, CAST(l.state AS CHAR) st, COUNT(*) n ` +
        `FROM leads l ${LEAD_SCOPE_JOIN} ` +
        `LEFT JOIN lead_campaigns lc ON lc.lead_id = l.id ` +
        // `cp`, not `c`: LEAD_SCOPE_JOIN has already taken `c` for the contact card.
        `LEFT JOIN campaigns cp ON cp.id = lc.campaign_id ` +
        `WHERE ${range} AND (lc.lead_id IS NOT NULL OR ${j("campaign")} IS NOT NULL) ` +
        `GROUP BY 1,2,3,4 ORDER BY n DESC LIMIT 6000`,
      true,
      60000,
    ),
  ]);
  if ("error" in utmRes) return { ...base, error: `Metabase reachable, but the campaign-leads query failed: ${utmRes.error}` };
  base.rows = utmRes.rows.map((r) => ({
    campaign: String(r[0] ?? ""),
    source: String(r[1] ?? ""),
    medium: String(r[2] ?? ""),
    content: String(r[3] ?? ""),
    stage: String(r[4] ?? ""),
    state: String(r[5] ?? ""),
    n: Number(r[6] ?? 0),
  }));
  if ("error" in codeRes) {
    // The utm half is still useful on its own; say what's missing instead of
    // failing the whole payload.
    base.error = `Campaign-code mapping unavailable: ${codeRes.error}`;
  } else {
    base.codeRows = codeRes.rows.map((r) => ({
      code: String(r[0] ?? ""),
      campaign: String(r[1] ?? ""),
      stage: String(r[2] ?? ""),
      state: String(r[3] ?? ""),
      n: Number(r[4] ?? 0),
    }));
  }
  base.truncated = base.rows.length >= 6000 || base.codeRows.length >= 6000;
  return base;
}

export interface ChannelDeals {
  ai: number;
  organic: number;
}

/**
 * Deals credited to the AI and organic channels, for several windows in one pass.
 *
 * Credited to the PERSON a channel brought in, not to the lead row. Agents
 * record a win on a fresh lead row for the same contact — often a portal or
 * hand-typed one — so crediting only the row the enquiry arrived on missed
 * them. A deal counts for a channel when the contact's first enquiry through
 * it came before both the deal and the lead the deal sits on (bh-crm-metabase,
 * campaign workflow). Checked on 20 Oct 2026: August 2026 read 6 organic deals
 * by row and 10 by person; since January, AI read 0 by row and 1 by person — a
 * ChatGPT visitor who later rented through a Property Finder enquiry
 * (January to 20 October 2026).
 *
 * A person reached through both channels counts in both. Deals keyed into
 * GoYzer and synced into Engage count like any other: they are real outcomes.
 */
export async function getChannelDeals(windows: { from: string; to: string }[]): Promise<ChannelDeals[] | { error: string }> {
  if (!windows.length || windows.some((w) => !isDate(w.from) || !isDate(w.to))) return { error: "bad date range" };
  const first = windows.reduce((m, w) => (w.from < m ? w.from : m), windows[0].from);
  const last = windows.reduce((m, w) => (w.to > m ? w.to : m), windows[0].to);
  const inWindow = (w: { from: string; to: string }) => `dc >= '${w.from} 00:00:00' AND dc <= '${w.to} 23:59:59'`;
  const cols = windows.flatMap((w, i) => [
    `COALESCE(SUM(ai_hit AND ${inWindow(w)}), 0) ai${i}`,
    `COALESCE(SUM(org_hit AND ${inWindow(w)}), 0) org${i}`,
  ]);
  const res = await mbQueryEx(
    `WITH tl AS (` +
      `SELECT l.customer_id cid, l.created_at at_, ${SEG} seg FROM leads l ${LEAD_SCOPE_JOIN} ` +
      `WHERE l.created_at >= '${ENGAGE_START}' AND l.created_at <= '${last} 23:59:59' AND ${LEAD_SCOPE}` +
    `), touch AS (` +
      `SELECT cid, MIN(CASE WHEN seg = 'ai' THEN at_ END) ai_at, MIN(CASE WHEN seg = 'organic' THEN at_ END) org_at ` +
      `FROM tl WHERE seg IN ('ai','organic') GROUP BY cid` +
    `), hits AS (` +
      `SELECT d.id, MIN(d.created_at) dc, ` +
      `MAX(t.ai_at IS NOT NULL AND d.created_at >= t.ai_at AND l2.created_at >= t.ai_at) ai_hit, ` +
      `MAX(t.org_at IS NOT NULL AND d.created_at >= t.org_at AND l2.created_at >= t.org_at) org_hit ` +
      `FROM deals d JOIN leads l2 ON l2.id = d.lead_id JOIN touch t ON t.cid = l2.customer_id ` +
      `WHERE d.created_at >= '${first} 00:00:00' AND d.created_at <= '${last} 23:59:59' AND ${DEAL_VALID} ` +
      `GROUP BY d.id` +
    `) SELECT ${cols.join(", ")} FROM hits`,
    true,
    55000, // one scan of every scoped lead since the Engage cutover; the route allows 90s
  );
  if ("error" in res) return { error: res.error };
  const row = res.rows[0] ?? [];
  return windows.map((_, i) => ({ ai: Number(row[i * 2] ?? 0), organic: Number(row[i * 2 + 1] ?? 0) }));
}

export async function getLeadsData(
  fromRaw: string,
  toRaw: string,
  opts?: { audit?: boolean; /** false when the caller fetches deals itself, for several windows at once */ deals?: boolean },
): Promise<LeadsData> {
  const connected = !!(
    process.env.METABASE_URL &&
    (process.env.METABASE_API_KEY || (process.env.METABASE_USERNAME && process.env.METABASE_PASSWORD))
  );
  const label = `${fromRaw} → ${toRaw}`;
  const base: LeadsData = {
    connected, label, aiLeads: 0, organicLeads: 0, websiteNoUtm: 0, popup: 0,
    aiBySource: [], stage: [], status: [], leadType: [], deals: { ai: 0, organic: 0 }, excluded: 0, sourceAudit: [],
  };
  if (!connected) return base;
  if (!isDate(fromRaw) || !isDate(toRaw)) return { ...base, error: "bad date range" };
  // Precise auth check first, so a login problem reads clearly instead of a
  // generic "query failed".
  if (!process.env.METABASE_API_KEY) {
    const tok = await mbSessionToken();
    if (!tok) {
      return { ...base, error: "Metabase login failed — check METABASE_URL / METABASE_USERNAME / METABASE_PASSWORD (SSO or 2FA logins can't authenticate with a password)." };
    }
  }
  const range = `l.created_at >= '${fromRaw} 00:00:00' AND l.created_at <= '${toRaw} 23:59:59'`;

  // JSON_UNQUOTE turns a JSON null into the literal string 'null', so both that
  // and '' have to be folded to a readable placeholder.
  const audit = (expr: string) => `COALESCE(NULLIF(NULLIF(${expr}, ''), 'null'), '(none)')`;

  // ONE scan. This used to be four concurrent queries (segment totals, AI by
  // source, stage, state) plus the audit — five full passes over `leads` in the
  // same range, each re-evaluating the same per-row JSON extraction, which is
  // what pushed it past the 20s ceiling.
  //
  // They all aggregate the same rows, so a single pass grouped by the four
  // low-cardinality dimensions carries everything, and the roll-ups are done in
  // JS below. `aisrc` is NULL for non-AI rows on purpose: it keeps the free-text
  // source out of the grouping key except where it's actually needed, so the
  // result stays a few hundred rows rather than one per campaign.
  //
  // The landing-page roll-up that used to run alongside this is gone: the card it
  // fed now reports views from PostHog, which has no coverage gap, so this is
  // once again a single scan of the view per load.
  // Lead type joins the grouping key rather than getting its own pass: it is
  // low-cardinality, and a second scan of this view is the expensive thing.
  // `ins` carries the lead scope through the same pass, so the rows it leaves
  // out are counted rather than silently missing.
  const [scanRes, dealsRes] = await Promise.all([
    mbQueryEx(
      `SELECT sub, aisrc, stage, st, lt, ins, count(*) n FROM (` +
        `SELECT ${SUB} sub, ` +
        `CASE WHEN ${IS_AI} THEN COALESCE(NULLIF(${utmSource}, ''), LOWER(l.enquiry_source)) END aisrc, ` +
        `CAST(l.status AS CHAR) stage, CAST(l.state AS CHAR) st, CAST(l.type AS CHAR) lt, ` +
        `CASE WHEN ${LEAD_SCOPE} THEN 1 ELSE 0 END ins ` +
        `FROM leads l ${LEAD_SCOPE_JOIN} WHERE ${range}` +
        `) t GROUP BY 1,2,3,4,5,6`,
      true,
      60000, // the main scan over the `leads` VIEW; the route allows 90s
    ),
    opts?.deals === false ? null : getChannelDeals([{ from: fromRaw, to: toRaw }]),
  ]);
  if ("error" in scanRes) {
    return { ...base, error: `Metabase reachable, but the leads query failed: ${scanRes.error}` };
  }

  const aiSrc = new Map<string, number>();
  const stageAcc = new Map<string, number>(); // "seg|stage" → n
  const statusAcc = new Map<string, number>();
  const typeAcc = new Map<string, number>();
  for (const r of scanRes.rows) {
    const sub = String(r[0] ?? "");
    const src = r[1] == null ? "" : String(r[1]);
    const stage = String(r[2] ?? "");
    const st = String(r[3] ?? "");
    const lt = String(r[4] ?? "");
    const inScope = Number(r[5] ?? 0) === 1;
    const n = Number(r[6] ?? 0);
    if (!inScope) {
      if (segOf(sub) !== "other") base.excluded += n;
      continue;
    }
    if (sub === "ai") base.aiLeads += n;
    else if (sub === "website") base.websiteNoUtm += n;
    else if (sub === "popup") base.popup += n;
    const seg = segOf(sub);
    if (seg === "ai" && src) aiSrc.set(src, (aiSrc.get(src) ?? 0) + n);
    if (seg === "ai" || seg === "organic") {
      stageAcc.set(`${seg}|${stage}`, (stageAcc.get(`${seg}|${stage}`) ?? 0) + n);
      statusAcc.set(`${seg}|${st}`, (statusAcc.get(`${seg}|${st}`) ?? 0) + n);
      if (lt) typeAcc.set(`${seg}|${lt}`, (typeAcc.get(`${seg}|${lt}`) ?? 0) + n);
    }
  }
  base.organicLeads = base.websiteNoUtm + base.popup;
  base.aiBySource = [...aiSrc].map(([source, n]) => ({ source, n })).sort((a, b) => b.n - a.n);
  // Same shape and ordering the four separate queries produced (seg, then n desc).
  const split = (m: Map<string, number>) =>
    [...m].map(([k, n]) => ({ seg: k.slice(0, k.indexOf("|")), label: k.slice(k.indexOf("|") + 1), n }))
      .sort((a, b) => (a.seg === b.seg ? b.n - a.n : a.seg < b.seg ? -1 : 1));
  base.stage = split(stageAcc).map((r) => ({ segment: r.seg, stage: r.label, n: r.n }));
  base.status = split(statusAcc).map((r) => ({ segment: r.seg, status: r.label, n: r.n }));
  base.leadType = split(typeAcc).map((r) => ({ segment: r.seg, type: r.label, n: r.n }));
  // Deals are secondary: if attribution fails the lead figures still stand.
  if (dealsRes && !("error" in dealsRes)) base.deals = dealsRes[0];


  // The audit is a second full scan with five JSON extractions per row, so it
  // only runs when the table is actually opened.
  const auditRows = opts?.audit
    ? await mbQuery(
        `SELECT es, us, um, seg, count(*) n FROM (` +
          `SELECT ${audit(`LOWER(TRIM(l.enquiry_source))`)} es, ${audit(utmSource)} us, ${audit(utmMedium)} um, ${SEG} seg ` +
          `FROM leads l ${LEAD_SCOPE_JOIN} WHERE ${range} AND ${LEAD_SCOPE}` +
          `) t GROUP BY 1,2,3,4 ORDER BY n DESC LIMIT 60`,
        true,
        60000,
      )
    : null;
  base.sourceAudit = (auditRows ?? []).map((r) => ({
    enquirySource: String(r[0] ?? "(none)"),
    utmSource: String(r[1] ?? "(none)"),
    utmMedium: String(r[2] ?? "(none)"),
    segment: String(r[3] ?? ""),
    n: Number(r[4] ?? 0),
  }));
  return base;
}

// ═══════════════════════════════════════════════════════════════════
// Monthly AI vs organic leads, for the SEO & AI Channel report.
//
// The same classification as getLeadsData — IS_AI / IS_WEB_NOUTM / IS_POPUP —
// deliberately reused rather than restated, because the definitions are all
// inference over free text and two copies would eventually disagree while both
// claiming to be "organic leads".
// ═══════════════════════════════════════════════════════════════════

export interface LeadsMonthRow {
  month: string; // YYYY-MM
  aiLeads: number;
  /** The same AI leads by their raw source string (utm source, else enquiry source). */
  aiBySource: { source: string; n: number }[];
  organicLeads: number;
  /** Deals created that month, any channel. Attribution to AI is not available
   *  on `deals`, so this is context for the lead trend, not an AI figure. */
  deals: number;
}

export interface LeadsMonthly {
  connected: boolean;
  rows: LeadsMonthRow[];
  error?: string;
}

export async function getLeadsMonthly(fromRaw: string, toRaw: string): Promise<LeadsMonthly> {
  const connected = !!(
    process.env.METABASE_URL &&
    (process.env.METABASE_API_KEY || (process.env.METABASE_USERNAME && process.env.METABASE_PASSWORD))
  );
  if (!connected) return { connected, rows: [] };
  if (!isDate(fromRaw) || !isDate(toRaw)) return { connected, rows: [], error: "bad date range" };

  const range = `l.created_at >= '${fromRaw} 00:00:00' AND l.created_at <= '${toRaw} 23:59:59' AND ${LEAD_SCOPE}`;

  // One grouped scan of `leads`, and one of `deals`. `leads` is a view with no
  // indexes, so a query per month would re-derive the whole thing each time.
  // The AI source rides in the same grouping — NULL outside AI rows, so it adds
  // a handful of rows, not a pass — and is what lets each assistant say how
  // many leads it has sent this year.
  const [leadsRes, dealsRes] = await Promise.all([
    mbQueryEx(
      `SELECT m, seg, aisrc, count(*) n FROM (` +
        `SELECT DATE_FORMAT(l.created_at, '%Y-%m') m, ${SEG} seg, ` +
        `CASE WHEN ${IS_AI} THEN COALESCE(NULLIF(${utmSource}, ''), LOWER(l.enquiry_source)) END aisrc ` +
        `FROM leads l ${LEAD_SCOPE_JOIN} WHERE ${range}` +
        `) t GROUP BY 1, 2, 3 ORDER BY 1`,
      true,
      60000,
    ),
    mbQueryEx(
      `SELECT DATE_FORMAT(d.created_at, '%Y-%m') m, count(*) n ` +
        `FROM deals d WHERE d.created_at >= '${fromRaw} 00:00:00' AND d.created_at <= '${toRaw} 23:59:59' ` +
        `AND ${DEAL_VALID} ` +
        `GROUP BY 1 ORDER BY 1`,
      true,
      45000,
    ),
  ]);

  if ("error" in leadsRes) {
    return { connected, rows: [], error: `Metabase reachable, but the monthly leads query failed: ${leadsRes.error}` };
  }

  const byMonth = new Map<string, LeadsMonthRow>();
  const row = (m: string) => {
    let r = byMonth.get(m);
    if (!r) {
      r = { month: m, aiLeads: 0, aiBySource: [], organicLeads: 0, deals: 0 };
      byMonth.set(m, r);
    }
    return r;
  };

  for (const r of leadsRes.rows) {
    const m = String(r[0] ?? "");
    if (!m) continue;
    const seg = String(r[1] ?? "");
    const src = r[2] == null ? "" : String(r[2]);
    const n = Number(r[3] ?? 0);
    if (seg === "ai") {
      row(m).aiLeads += n;
      if (src) row(m).aiBySource.push({ source: src, n });
    } else if (seg === "organic") row(m).organicLeads += n;
  }

  // Deals are secondary: if that query fails the lead trend is still worth
  // showing, so it degrades to zero rather than failing the whole section.
  if (!("error" in dealsRes)) {
    for (const r of dealsRes.rows) {
      const m = String(r[0] ?? "");
      if (m) row(m).deals = Number(r[1] ?? 0);
    }
  }

  return { connected, rows: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)) };
}
