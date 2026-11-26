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
import { errorMessage } from "@/lib/coerce";
import { clearNotification, notify } from "@/lib/notify";

const DB_ID = Number(process.env.METABASE_DB_ID || 14);

/** Whether Metabase is set up on this deployment: its address, and an API key or a login. */
export const mbConfigured = (): boolean =>
  !!(
    process.env.METABASE_URL &&
    (process.env.METABASE_API_KEY || (process.env.METABASE_USERNAME && process.env.METABASE_PASSWORD))
  );

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
export const utmJson = (key: string) => `NULLIF(CASE WHEN JSON_VALID(l.utm) THEN LOWER(JSON_UNQUOTE(JSON_EXTRACT(l.utm,'$.${key}'))) END, 'null')`;
const utmSource = utmJson("source");
const utmMedium = utmJson("medium");
const llmList = LLM_DOMAINS.map((d) => `'${d}'`).join(",");
export const IS_AI = `(${utmSource} IN (${llmList}) OR LOWER(l.enquiry_source) IN (${llmList}))`;
// Pop-up tags are hand-written and inconsistent — 'pop-up', 'website_pop-up' and
// 'website-popup' all occur. Stripping hyphens first collapses every spelling
// onto one pattern; matching '%pop-up%' alone missed the unhyphenated form.
const noHyphen = (e: string) => `REPLACE(${e}, '-', '')`;
export const IS_POPUP = `(${noHyphen(utmSource)} LIKE '%popup%' OR ${noHyphen(utmMedium)} LIKE '%popup%' OR ${noHyphen("LOWER(l.enquiry_source)")} LIKE '%popup%')`;
const IS_WEB_NOUTM = `(LOWER(l.enquiry_source) = 'website' AND (l.utm IS NULL OR ${utmSource} IS NULL OR ${utmSource} = ''))`;
const SEG = `CASE WHEN ${IS_AI} THEN 'ai' WHEN (${IS_WEB_NOUTM} OR ${IS_POPUP}) THEN 'organic' ELSE 'other' END`;

// ── Lead scope ──────────────────────────────────────────────────────────────
//
// Rows that are not enquiries, kept out of every lead count on every tab. Each
// rule was checked against the CRM on 20 Oct 2026, following the
// bh-crm-metabase rules:
//
//  • GoYzer, the old CRM. Never counted: its rows since the Engage cutover
//    arrive already completed, and the earlier ones are a migrated register.
//  • Bulk imports by the technology account: rows it created with no enquiry
//    source and no input channel at all. 98,648 of them landed in April 2025,
//    95,674 on 19–20 April alone, against about 550 leads on a normal day;
//    smaller batches followed through to February 2026 (8,680 in July–December
//    2025, 98 in 2026), all of them property-attached. Left in, April 2025
//    reads as 113,151 leads and every "No Source" trend spikes. The same
//    account also files real leads through the feeds, so only the source-less
//    rows are dropped.
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


/** When Engage took over from GoYzer: the earliest a first touch can be. */
export const ENGAGE_START = "2024-12-01 00:00:00";
/**
 * A deal counts when it reached reservation and wasn't withdrawn. Company
 * Performance, Portals and the SEO tab all count deals by this one rule.
 */
export const DEAL_VALID = `d.status IN ('Reserved','Closed','Completed') AND d.state <> 'Withdrawn'`;

/**
 * The day a deal counts on: its reservation date, or its agreement date where
 * the reservation date was left blank. Every tab that dates deals uses this.
 *
 * 101 valid deals agreed between 22 Nov 2025 and 26 Mar 2026 have no
 * reservation date (69 reserved, 32 completed, AED 6.58M, all keyed in by
 * hand), so dated by reservation alone they fell out of every range: Company
 * was 35 deals short in January 2026, 39 in February and 9 in March. Each has
 * an agreement date, none shares a listing with a counted deal within 90 days,
 * and no valid deal since 2025 has neither date.
 */
export const DEAL_DATE = "COALESCE(d.reserved_at, d.agreed_at)";

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
      console.error(`[metabase] session login error: ${errorMessage(e)}`);
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
    const msg = aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : errorMessage(e);
    console.error(`[metabase] dataset error: ${msg}`);
    return { error: msg };
  } finally {
    clearTimeout(t);
  }
}

/** Most rows Metabase's dataset API returns for one query, whatever its LIMIT. */
export const MB_ROW_CAP = 2000;

/** Rows, or null when it failed. For callers that only need "did it work". */
export async function mbQuery(sql: string, retry = true, timeoutMs = 20000): Promise<any[][] | null> {
  const r = await mbQueryEx(sql, retry, timeoutMs);
  return "rows" in r ? r.rows : null;
}

// ═══════════════════════════════════════════════════════════════════
// Organic growth — the SEO tab's CRM half, month by month.
//
// Organic is SEO and AI together: website enquiries with no UTM source,
// website pop-ups, and enquiries an AI assistant sent (SEG above). Leads are
// counted as people, once per month and service line. What they went on to do
// is counted for those people from their first organic enquiry on, as the
// campaign rules do (bh-crm-metabase): listings they placed with us, and deals
// on their own enquiries or on the listings they placed.
// ═══════════════════════════════════════════════════════════════════

/**
 * An enquiry from the property management page: the site's property
 * management form tags its campaign so, and since July 2026 the site also
 * sends the page an enquiry came from.
 */
const IS_PM =
  `(COALESCE(${utmJson("campaign")}, '') LIKE '%property-management%' ` +
  `OR LOWER(COALESCE(l.tracking_link, '')) LIKE '%/property-management%')`;

/** The service line an enquiry belongs to: property management and off-plan first, then sale or rent by the lead's type. */
const LINE =
  `CASE WHEN ${IS_PM} THEN 'pm' WHEN op.lead_id IS NOT NULL THEN 'offplan' ` +
  `WHEN l.type IN ('Buyer','Seller') THEN 'sale' WHEN l.type IN ('Tenant','Landlord') THEN 'rent' ELSE 'other' END`;

export type ServiceLine = "sale" | "rent" | "offplan" | "pm" | "other";
export const SERVICE_LINES: ServiceLine[] = ["sale", "rent", "offplan", "pm", "other"];

export interface GrowthCrmMonth {
  month: string; // YYYY-MM
  /** People with an organic or AI enquiry that month, by service line, and in all (each person once). */
  leads: Record<ServiceLine | "total", number>;
  /** The same, enquiring through an AI assistant. */
  aiLeads: Record<ServiceLine | "total", number>;
  /** Listings those people placed with us, by the month the listing was made. */
  listed: { sale: number; rent: number };
  /** Deals recorded that month (reservations), and of them the ones completed since. */
  reserved: { sale: number; rent: number };
  completed: { sale: number; rent: number };
  /** Gross commission: on completed deals, and on reservations still open, awaiting completion. */
  commission: { completedSale: number; completedRent: number; awaiting: number };
}

export interface GrowthCrm {
  connected: boolean;
  months: GrowthCrmMonth[];
  error?: string;
}

/** The two questions behind getGrowthCrm, for a window of whole months. Exported so a test can read them. */
export function growthCrmSql(from: string, to: string): { leads: string; outcomes: string } {
  const window = (col: string) => `${col} >= '${from} 00:00:00' AND ${col} <= '${to} 23:59:59'`;
  // Off-plan: the client asked about a listing the CRM files as off-plan.
  const offPlan =
    `LEFT JOIN (SELECT DISTINCT r.lead_id FROM lead_requirements r JOIN listings li ON li.id = r.listing_id ` +
    `WHERE li.sub_type = 'Off Plan' AND ${window("r.created_at")}) op ON op.lead_id = l.id`;
  const leads =
    `SELECT m, line, COUNT(DISTINCT cid) people, COUNT(DISTINCT CASE WHEN seg = 'ai' THEN cid END) ai_people FROM (` +
    `SELECT DATE_FORMAT(l.created_at, '%Y-%m') m, l.customer_id cid, ${SEG} seg, ${LINE} line ` +
    `FROM leads l ${LEAD_SCOPE_JOIN} ${offPlan} ` +
    `WHERE ${window("l.created_at")} AND ${LEAD_SCOPE}` +
    `) t WHERE seg IN ('ai','organic') GROUP BY m, line WITH ROLLUP`;
  // Each person's first organic or AI enquiry since the Engage cutover.
  const touch =
    `SELECT l.customer_id cid, MIN(l.created_at) first_at FROM leads l ${LEAD_SCOPE_JOIN} ` +
    `WHERE l.created_at >= '${ENGAGE_START}' AND l.created_at <= '${to} 23:59:59' AND ${LEAD_SCOPE} ` +
    `AND (${IS_AI} OR ${IS_WEB_NOUTM} OR ${IS_POPUP}) GROUP BY l.customer_id`;
  const outcomes =
    `WITH touch AS (${touch}) ` +
    `SELECT 'listed' k, DATE_FORMAT(li.created_at, '%Y-%m') m, CAST(li.type AS CHAR) t, COUNT(DISTINCT li.id) n, 0 comm ` +
    `FROM listings li JOIN leads l2 ON l2.id = li.lead_id JOIN touch tc ON tc.cid = l2.customer_id ` +
    `WHERE ${window("li.created_at")} AND li.created_at >= tc.first_at GROUP BY 1, 2, 3 ` +
    `UNION ALL ` +
    `SELECT CASE WHEN status = 'Completed' THEN 'completed' WHEN status = 'Reserved' AND state = 'Open' THEN 'awaiting' ELSE 'ended' END k, ` +
    `m, t, COUNT(*) n, SUM(comm) comm FROM (` +
    `SELECT DATE_FORMAT(d.created_at, '%Y-%m') m, CAST(d.type AS CHAR) t, CAST(d.status AS CHAR) status, CAST(d.state AS CHAR) state, ` +
    // A deal carries its final or its reserved commission, never both (bh-crm-metabase).
    `GREATEST(COALESCE(d.final_gross_commission_amount, 0), COALESCE(d.reserved_gross_commission_amount, 0)) comm ` +
    `FROM deals d ` +
    `LEFT JOIN leads dl ON dl.id = d.lead_id LEFT JOIN touch td ON td.cid = dl.customer_id ` +
    `LEFT JOIN listings li ON li.id = d.listing_id LEFT JOIN leads ll ON ll.id = li.lead_id LEFT JOIN touch ts ON ts.cid = ll.customer_id ` +
    `WHERE ${window("d.created_at")} AND ${DEAL_VALID} ` +
    `AND ((td.cid IS NOT NULL AND d.created_at >= td.first_at AND dl.created_at >= td.first_at) ` +
    `OR (ts.cid IS NOT NULL AND d.created_at >= ts.first_at AND li.created_at >= ts.first_at))` +
    `) x GROUP BY 1, 2, 3`;
  return { leads, outcomes };
}

const emptyLines = (): Record<ServiceLine | "total", number> => ({ sale: 0, rent: 0, offplan: 0, pm: 0, other: 0, total: 0 });

/**
 * Organic and AI leads by service line, and the listings, reservations,
 * completions and commission behind them, for each month from → to (whole
 * months). Two questions, asked together; either failing fails the lot, so a
 * month never shows its leads without what they led to.
 */
export async function getGrowthCrm(from: string, to: string): Promise<GrowthCrm> {
  const connected = mbConfigured();
  if (!connected) return { connected, months: [] };
  if (!isDate(from) || !isDate(to)) return { connected, months: [], error: "bad date range" };
  const sql = growthCrmSql(from, to);
  const [leadsRes, outRes] = await Promise.all([mbQueryEx(sql.leads, true, 60000), mbQueryEx(sql.outcomes, true, 60000)]);
  if ("error" in leadsRes) return { connected, months: [], error: `Metabase reachable, but the leads query failed: ${leadsRes.error}` };
  if ("error" in outRes) return { connected, months: [], error: `Metabase reachable, but the listings and deals query failed: ${outRes.error}` };

  const byMonth = new Map<string, GrowthCrmMonth>();
  const month = (m: string) => {
    let r = byMonth.get(m);
    if (!r) {
      r = {
        month: m, leads: emptyLines(), aiLeads: emptyLines(),
        listed: { sale: 0, rent: 0 }, reserved: { sale: 0, rent: 0 }, completed: { sale: 0, rent: 0 },
        commission: { completedSale: 0, completedRent: 0, awaiting: 0 },
      };
      byMonth.set(m, r);
    }
    return r;
  };
  // WITH ROLLUP: a NULL line is the month's own row, every person once; a NULL month is the grand total.
  for (const r of leadsRes.rows) {
    if (r[0] == null) continue;
    const line = r[1] == null ? "total" : (String(r[1]) as ServiceLine);
    if (!(line in emptyLines())) continue;
    month(String(r[0])).leads[line] = Number(r[2] ?? 0);
    month(String(r[0])).aiLeads[line] = Number(r[3] ?? 0);
  }
  for (const r of outRes.rows) {
    const k = String(r[0] ?? ""), m = String(r[1] ?? ""), side = String(r[2] ?? "") === "Sale" ? "sale" : "rent";
    if (!m) continue;
    const n = Number(r[3] ?? 0), comm = Number(r[4] ?? 0);
    const row = month(m);
    if (k === "listed") {
      row.listed[side] += n;
      continue;
    }
    row.reserved[side] += n;
    if (k === "completed") {
      row.completed[side] += n;
      if (side === "sale") row.commission.completedSale += comm;
      else row.commission.completedRent += comm;
    } else if (k === "awaiting") row.commission.awaiting += comm;
  }
  return { connected, months: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)) };
}
