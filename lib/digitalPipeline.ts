// The Digital tab's pipeline scorecard: what the people our paid campaigns
// brought in went on to do, read from the CRM (Engage, through Metabase) in one
// query.
//
// A paid lead is a lead created in the range, in the shared scope (LEAD_SCOPE),
// whose utm_campaign is one of the ad campaigns in the tab's ad data: its name,
// or its Meta campaign id. The tab sends those names; nothing here reads the ad
// platforms or Supermetrics.
//
// Each person is counted once, under the campaign of their first paid lead in
// the range. Everything they did from that lead on counts, on any of their lead
// rows, because agents open a new lead row for a viewing, a listing or a deal
// (bh-crm-metabase):
//   viewed     a completed Viewing activity after that first paid lead
//   listings   listings taken on their leads after it
//   deals      valid deals (DEAL_VALID) on their leads, or on a listing taken
//              from them, after it. Commission is the deal's gross commission:
//              the final figure once the CRM has one, the reserved one until then.
//   direct     a deal on a paid lead itself, or on a listing taken on one. The
//              rest are indirect, and the enquiry source of the lead they sit
//              on says where the person came back through.
// Outcomes count up to today: the range picks the people, not the end date.
//
// Campaign codes are not used here: the tab shows each campaign's own codes
// beside it, one by one, from the CRM's campaign links.
import { createHash } from "node:crypto";
import { cacheKey, remembered, type RememberOptions } from "@/lib/cache";
import { DEAL_VALID, LEAD_SCOPE, LEAD_SCOPE_JOIN, MB_ROW_CAP, mbConfigured, mbQueryEx } from "@/lib/metabase";

/** One ad campaign in one month. Leads by the month they came in; people and what they did by the month of their first paid lead. */
export interface PipelineCell {
  /** The CRM's utm_campaign, in lower case: an ad campaign's name or Meta campaign id. */
  campaign: string;
  /** YYYY-MM. */
  month: string;
  leads: number;
  people: number;
  /** People with a completed viewing. */
  viewed: number;
  listings: number;
  deals: number;
  directDeals: number;
  commission: number;
  directCommission: number;
  /** Commission on deals still at Reserved: not invoiced yet. */
  reservedCommission: number;
  /** The deals' prices: sale prices and yearly rents together. */
  dealValue: number;
}

/** Indirect deals by the enquiry source of the lead they sit on, per campaign. */
export interface PipelineSource {
  campaign: string;
  source: string;
  deals: number;
  commission: number;
}

export interface PipelineData {
  /** When this answer was worked out (lib/cache.ts). */
  cachedAt?: string | null;
  connected: boolean;
  from: string;
  to: string;
  cells: PipelineCell[];
  sources: PipelineSource[];
  /** Hit Metabase's row cap: the smallest groups are missing. */
  truncated: boolean;
  error?: string;
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const sqlStr = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

/** The campaign names as the query matches them: lower case, trimmed, once each. */
export function campaignKeys(names: Iterable<string>): string[] {
  return [...new Set([...names].map((n) => n.toLowerCase().trim()).filter(Boolean))].sort();
}

/** The one query: a row per campaign and month ('cell'), and per campaign and source of its indirect deals ('source'). */
export function pipelineSql(from: string, to: string, keys: string[]): string {
  const camp = `CASE WHEN JSON_VALID(l.utm) THEN LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(l.utm,'$.campaign')))) END`;
  // The final figure once the CRM has one, the reserved one until then: over half
  // the deals since 2025 carry both, and the final one is what was invoiced.
  const comm = "COALESCE(NULLIF(d.final_gross_commission_amount,0), d.reserved_gross_commission_amount, 0)";
  const value = "COALESCE(NULLIF(d.final_price,0), d.reserved_price, 0)";
  // DISTINCT keeps `paid` worked out once: MySQL folds a plain CTE into every
  // place that uses it, and this one scans the leads table, about 6 s a time.
  return `
WITH paid AS (
  SELECT DISTINCT l.id lid, l.customer_id cid, l.created_at at_, ${camp} camp
  FROM leads l ${LEAD_SCOPE_JOIN}
  WHERE l.created_at >= '${from}' AND l.created_at < DATE_ADD('${to}', INTERVAL 1 DAY)
    AND ${LEAD_SCOPE} AND ${camp} IN (${keys.map(sqlStr).join(",")})
),
people AS (
  SELECT cid, at_ first_at, camp FROM (
    SELECT cid, at_, camp, ROW_NUMBER() OVER (PARTITION BY cid ORDER BY at_, lid) n FROM paid
  ) f WHERE n = 1
),
theirs AS (
  SELECT pe.cid, pe.first_at, l.id lid, l.enquiry_source src
  FROM people pe JOIN leads l ON l.customer_id = pe.cid AND l.created_at >= pe.first_at
),
viewed AS (
  SELECT DISTINCT t.cid FROM theirs t JOIN activities a ON a.lead_id = t.lid
  WHERE a.type = 'Viewing' AND a.status = 'Completed' AND a.datetime >= t.first_at
),
won AS (
  SELECT t.cid, t.lid, t.src, li.id listing_id
  FROM theirs t JOIN listings li ON li.lead_id = t.lid AND li.created_at >= t.first_at
),
dealt AS (
  SELECT cid, did, MAX(direct) direct, MAX(src) src, MAX(reserved) reserved, MAX(comm) comm, MAX(value) value FROM (
    SELECT t.cid, d.id did, t.lid IN (SELECT lid FROM paid) direct, t.src, d.status = 'Reserved' reserved, ${comm} comm, ${value} value
    FROM theirs t JOIN deals d ON d.lead_id = t.lid
    WHERE ${DEAL_VALID} AND d.created_at >= t.first_at
    UNION ALL
    SELECT w.cid, d.id, w.lid IN (SELECT lid FROM paid), w.src, d.status = 'Reserved', ${comm}, ${value}
    FROM won w JOIN deals d ON d.listing_id = w.listing_id
    WHERE ${DEAL_VALID}
  ) x GROUP BY cid, did
),
outcome AS (
  SELECT pe.camp, DATE_FORMAT(pe.first_at,'%Y-%m') mth, COUNT(*) people, COUNT(v.cid) viewed,
         SUM(COALESCE(w.n,0)) listings, SUM(COALESCE(dl.n,0)) deals, SUM(COALESCE(dl.direct,0)) direct_deals,
         SUM(COALESCE(dl.comm,0)) comm, SUM(COALESCE(dl.direct_comm,0)) direct_comm,
         SUM(COALESCE(dl.res_comm,0)) res_comm, SUM(COALESCE(dl.value,0)) value
  FROM people pe
  LEFT JOIN viewed v ON v.cid = pe.cid
  LEFT JOIN (SELECT cid, COUNT(DISTINCT listing_id) n FROM won GROUP BY cid) w ON w.cid = pe.cid
  LEFT JOIN (
    SELECT cid, COUNT(*) n, SUM(direct) direct, SUM(comm) comm, SUM(direct * comm) direct_comm,
           SUM(reserved * comm) res_comm, SUM(value) value
    FROM dealt GROUP BY cid
  ) dl ON dl.cid = pe.cid
  GROUP BY 1,2
)
SELECT 'cell' kind, lc.camp, lc.mth, lc.leads, COALESCE(o.people,0) people, COALESCE(o.viewed,0) viewed,
       COALESCE(o.listings,0) listings, COALESCE(o.deals,0) deals, COALESCE(o.direct_deals,0) direct_deals,
       COALESCE(o.comm,0) comm, COALESCE(o.direct_comm,0) direct_comm, COALESCE(o.res_comm,0) res_comm,
       COALESCE(o.value,0) value
FROM (SELECT camp, DATE_FORMAT(at_,'%Y-%m') mth, COUNT(*) leads FROM paid GROUP BY 1,2) lc
LEFT JOIN outcome o ON o.camp = lc.camp AND o.mth = lc.mth
UNION ALL
SELECT 'source', pe.camp, COALESCE(NULLIF(TRIM(dl.src),''),'(not recorded)'), COUNT(*), 0, 0, 0, 0, 0, SUM(dl.comm), 0, 0, 0
FROM dealt dl JOIN people pe ON pe.cid = dl.cid
WHERE dl.direct = 0
GROUP BY 2,3`;
}

/** The query's rows, read into cells and sources. */
export function readPipelineRows(rows: unknown[][]): Pick<PipelineData, "cells" | "sources"> {
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const cells: PipelineCell[] = [];
  const sources: PipelineSource[] = [];
  for (const r of rows) {
    if (r[0] === "source") {
      sources.push({ campaign: String(r[1] ?? ""), source: String(r[2] ?? ""), deals: n(r[3]), commission: n(r[9]) });
      continue;
    }
    cells.push({
      campaign: String(r[1] ?? ""),
      month: String(r[2] ?? ""),
      leads: n(r[3]),
      people: n(r[4]),
      viewed: n(r[5]),
      listings: n(r[6]),
      deals: n(r[7]),
      directDeals: n(r[8]),
      commission: n(r[9]),
      directCommission: n(r[10]),
      reservedCommission: n(r[11]),
      dealValue: n(r[12]),
    });
  }
  return { cells, sources };
}

/** The scorecard for the people `campaigns` brought in between `from` and `to`, remembered (lib/cache.ts). Kept only when whole. */
export async function getDigitalPipeline(from: string, to: string, campaigns: string[], opts: RememberOptions = {}): Promise<PipelineData> {
  const keys = campaignKeys(campaigns);
  // The names are many and long, so the key carries a fingerprint of them.
  const names = createHash("sha1").update(keys.join("\n")).digest("hex").slice(0, 16);
  return remembered(
    cacheKey("digitalPipeline", { from, to, names }),
    () => computePipeline(from, to, keys),
    (d) => d.connected && !d.error && !d.truncated,
    opts,
  );
}

async function computePipeline(from: string, to: string, keys: string[]): Promise<PipelineData> {
  const base: PipelineData = { connected: mbConfigured(), from, to, cells: [], sources: [], truncated: false };
  if (!base.connected) return base;
  if (!isDate(from) || !isDate(to)) return { ...base, error: "bad date range" };
  if (!keys.length) return base; // no ad campaigns in the range: no paid leads to follow
  const res = await mbQueryEx(pipelineSql(from, to, keys), true, 60000);
  if ("error" in res) return { ...base, error: `The CRM pipeline query failed: ${res.error}` };
  return { ...base, ...readPipelineRows(res.rows), truncated: res.rows.length >= MB_ROW_CAP };
}
