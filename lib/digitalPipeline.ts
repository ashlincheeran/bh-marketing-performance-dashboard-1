// The CRM half of the Digital Pipeline Scorecard (the Digital tab), read from
// the CRM (Engage, through Metabase) with one plain query that works the same
// way for every campaign.
//
// A paid lead is a lead created in the range, in the shared scope (LEAD_SCOPE),
// whose utm_campaign is one of the ad campaigns in the tab's ad data: its name,
// or its Meta campaign id. The tab sends those names; nothing here reads the ad
// platforms or Supermetrics.
//
// Everything is counted on the paid leads themselves, and only there:
//   leads       the paid leads, by the month they were created
//   viewed      paid leads with a viewing logged on them, scheduled or completed
//               (not cancelled) and dated up to now; agents often leave a
//               viewing that took place at Scheduled. activities.datetime holds
//               UTC time, so "now" is UTC_TIMESTAMP().
//   viewedDone  of those, the leads with a viewing marked Completed
//   listings    listings whose lead is a paid lead
//   deals       valid deals (DEAL_VALID) whose lead is a paid lead. Commission is
//               the deal's gross commission: the final figure once the CRM has
//               one, the reserved one until then.
// A deal or listing recorded on another lead of the same person is not counted:
// the CRM does not record that it came from the campaign, so no rule that holds
// for every campaign could credit it.
//
// The Engage campaign codes each campaign's paid leads are linked to come back
// too ('code' rows), each as it is: the tab lists them and filters by them, and
// never adds one code's figures to another's.
import { createHash } from "node:crypto";
import { cacheKey, remembered, type RememberOptions } from "@/lib/cache";
import { DEAL_VALID, LEAD_SCOPE, LEAD_SCOPE_JOIN, MB_ROW_CAP, mbConfigured, mbQueryEx } from "@/lib/metabase";

/** One ad campaign in one month: its paid leads created that month, and what happened on them. */
export interface PipelineCell {
  /** The CRM's utm_campaign, in lower case: an ad campaign's name or Meta campaign id. */
  campaign: string;
  /** YYYY-MM. */
  month: string;
  leads: number;
  /** Leads with a viewing logged, scheduled or completed, dated up to now. */
  viewed: number;
  /** Leads with a viewing marked Completed. */
  viewedDone: number;
  listings: number;
  deals: number;
  commission: number;
  /** Commission on deals still at Reserved. */
  reservedCommission: number;
  /** The deals' prices: sale prices and yearly rents together. */
  dealValue: number;
}

/** How many of a campaign's paid leads Engage links to one campaign code. */
export interface PipelineCode {
  campaign: string;
  code: string;
  leads: number;
}

export interface PipelineData {
  /** When this answer was worked out (lib/cache.ts). */
  cachedAt?: string | null;
  connected: boolean;
  from: string;
  to: string;
  cells: PipelineCell[];
  codes: PipelineCode[];
  /** Hit Metabase's row cap: the smallest groups are missing. */
  truncated: boolean;
  /** A fingerprint of the campaign names the answer was worked out for. */
  names?: string;
  error?: string;
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const sqlStr = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

/** The campaign names as the query matches them: lower case, trimmed, once each. */
export function campaignKeys(names: Iterable<string>): string[] {
  return [...new Set([...names].map((n) => n.toLowerCase().trim()).filter(Boolean))].sort();
}

/**
 * The one query. Rows of two kinds, 11 columns each:
 *   'cell'  campaign, month, leads, viewed, viewed_done, listings, deals, comm, res_comm, value
 *   'code'  campaign, then its Engage campaign codes as a JSON list of
 *           [code, paid leads linked to it]: one row per campaign, so a
 *           campaign with many codes cannot crowd the row cap
 */
export function pipelineSql(from: string, to: string, keys: string[]): string {
  const camp = `CASE WHEN JSON_VALID(l.utm) THEN LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(l.utm,'$.campaign')))) END`;
  // The final figure once the CRM has one, the reserved one until then.
  const comm = "COALESCE(NULLIF(d.final_gross_commission_amount,0), d.reserved_gross_commission_amount, 0)";
  const value = "COALESCE(NULLIF(d.final_price,0), d.reserved_price, 0)";
  // DISTINCT keeps `paid` worked out once: MySQL folds a plain CTE into every
  // place that uses it, and this one scans the leads table, about 6 s a time.
  return `
WITH paid AS (
  SELECT DISTINCT l.id lid, DATE_FORMAT(l.created_at,'%Y-%m') mth, ${camp} camp
  FROM leads l ${LEAD_SCOPE_JOIN}
  WHERE l.created_at >= '${from}' AND l.created_at < DATE_ADD('${to}', INTERVAL 1 DAY)
    AND ${LEAD_SCOPE} AND ${camp} IN (${keys.map(sqlStr).join(",")})
),
viewed AS (
  SELECT a.lead_id lid, MAX(a.status = 'Completed') done
  FROM activities a JOIN paid p ON p.lid = a.lead_id
  WHERE a.type = 'Viewing' AND a.status IN ('Completed','Scheduled') AND a.datetime <= UTC_TIMESTAMP()
  GROUP BY a.lead_id
),
listed AS (
  SELECT li.lead_id lid, COUNT(*) n
  FROM listings li JOIN paid p ON p.lid = li.lead_id
  GROUP BY li.lead_id
),
dealt AS (
  SELECT d.lead_id lid, COUNT(*) n, SUM(${comm}) comm,
         SUM(CASE WHEN d.status = 'Reserved' THEN ${comm} ELSE 0 END) res_comm, SUM(${value}) value
  FROM deals d JOIN paid p ON p.lid = d.lead_id
  WHERE ${DEAL_VALID}
  GROUP BY d.lead_id
)
SELECT 'cell' kind, p.camp, p.mth, COUNT(*) leads, COUNT(v.lid) viewed, COALESCE(SUM(v.done),0) viewed_done,
       COALESCE(SUM(ls.n),0) listings, COALESCE(SUM(dl.n),0) deals, COALESCE(SUM(dl.comm),0) comm,
       COALESCE(SUM(dl.res_comm),0) res_comm, COALESCE(SUM(dl.value),0) value
FROM paid p
LEFT JOIN viewed v ON v.lid = p.lid
LEFT JOIN listed ls ON ls.lid = p.lid
LEFT JOIN dealt dl ON dl.lid = p.lid
GROUP BY p.camp, p.mth
UNION ALL
SELECT 'code', k.camp, JSON_ARRAYAGG(JSON_ARRAY(k.code, k.n)), 0, 0, 0, 0, 0, 0, 0, 0
FROM (
  SELECT p.camp, LOWER(TRIM(cp.reference)) code, COUNT(DISTINCT p.lid) n
  FROM paid p JOIN lead_campaigns lc ON lc.lead_id = p.lid JOIN campaigns cp ON cp.id = lc.campaign_id
  WHERE TRIM(COALESCE(cp.reference,'')) <> ''
  GROUP BY 1,2
) k
GROUP BY k.camp`;
}

/** The query's rows, read into campaign months and each campaign's codes. */
export function readPipelineRows(rows: unknown[][]): Pick<PipelineData, "cells" | "codes"> {
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const cells: PipelineCell[] = [];
  const codes: PipelineCode[] = [];
  for (const r of rows) {
    if (r[0] === "code") {
      let list: unknown = r[2];
      try {
        if (typeof list === "string") list = JSON.parse(list);
      } catch {
        list = [];
      }
      for (const pair of Array.isArray(list) ? list : []) {
        if (Array.isArray(pair) && pair[0] != null) codes.push({ campaign: String(r[1] ?? ""), code: String(pair[0]), leads: n(pair[1]) });
      }
    } else {
      cells.push({
        campaign: String(r[1] ?? ""),
        month: String(r[2] ?? ""),
        leads: n(r[3]),
        viewed: n(r[4]),
        viewedDone: n(r[5]),
        listings: n(r[6]),
        deals: n(r[7]),
        commission: n(r[8]),
        reservedCommission: n(r[9]),
        dealValue: n(r[10]),
      });
    }
  }
  return { cells, codes };
}

/** A short fingerprint of a list of campaign names. */
export const namesFingerprint = (keys: string[]) => createHash("sha1").update(keys.join("\n")).digest("hex").slice(0, 16);

/**
 * The scorecard's CRM half for the leads `campaigns` brought in between `from`
 * and `to`, remembered (lib/cache.ts). Kept only when whole.
 *
 * Kept per range, not per list of names: a campaign that starts spending, or
 * an account ticked, changes the list, and the morning warm-up (lib/warm.ts)
 * only knows the campaigns stored by then. So the kept answer is shown at once
 * as every kept answer is, and a live look (`maxAgeMs`, the page's second ask)
 * asked about other campaigns than it was worked out for works it out again.
 */
export async function getDigitalPipeline(from: string, to: string, campaigns: string[], opts: RememberOptions = {}): Promise<PipelineData> {
  const keys = campaignKeys(campaigns);
  return rememberedForNames(cacheKey("digitalScorecardDirect", { from, to }), namesFingerprint(keys), () => computePipeline(from, to, keys), opts);
}

/** remembered(), where a live look whose names differ from the kept answer's asks again. */
export async function rememberedForNames(
  key: string,
  names: string,
  compute: () => Promise<PipelineData>,
  opts: RememberOptions = {},
): Promise<PipelineData> {
  const work = async () => ({ ...(await compute()), names });
  const whole = (d: PipelineData) => d.connected && !d.error && !d.truncated;
  const answer = await remembered(key, work, whole, opts);
  if (answer.names && answer.names !== names && opts.maxAgeMs !== undefined && !opts.fresh) {
    return remembered(key, work, whole, { ...opts, fresh: true });
  }
  return answer;
}

async function computePipeline(from: string, to: string, keys: string[]): Promise<PipelineData> {
  const base: PipelineData = { connected: mbConfigured(), from, to, cells: [], codes: [], truncated: false };
  // Said as an error, so the page shows dashes and why, never real-looking zeros.
  if (!base.connected) return { ...base, error: "the CRM (Metabase) is not connected on this deployment" };
  if (!isDate(from) || !isDate(to)) return { ...base, error: "bad date range" };
  if (!keys.length) return base; // no ad campaigns in the range: no paid leads to follow
  const res = await mbQueryEx(pipelineSql(from, to, keys), true, 60000);
  if ("error" in res) return { ...base, error: `The CRM pipeline query failed: ${res.error}` };
  return { ...base, ...readPipelineRows(res.rows), truncated: res.rows.length >= MB_ROW_CAP };
}
