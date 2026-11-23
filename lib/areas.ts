// The business's areas, every channel together: where its leads, viewings,
// deals and commission come from, for the Dashboard's best areas.
//
// Counted as the Company tab counts the business (lib/company.ts): leads in the
// shared lead scope by the day they arrived, completed viewings by the day
// they took place, deals by reservation date under the shared DEAL_VALID rule
// (so a reservation counts as a deal), and commission as each deal's final
// gross commission. Placed as the Portals tab places its figures
// (lib/portals.ts): a lead and its viewings by the listing the enquiry was
// about, a deal by its own listing, each area the top of the locations tree.
// What names no property has no area, and is left out here; the Dashboard says
// how much.
import { cacheKey, remembered, type RememberOptions } from "@/lib/cache";
import { companyRange } from "@/lib/company";
import { DEAL_VALID, LEAD_SCOPE, LEAD_SCOPE_JOIN, mbConfigured, mbQueryEx, type MbResult } from "@/lib/metabase";
import { AREA_JOIN, AREA_NAME, LEAD_AREA, LEAD_PLACE } from "@/lib/portals";

export const AREA_FIGURES = ["leads", "viewings", "deals", "commission"] as const;
export type AreaFigureKey = (typeof AREA_FIGURES)[number];

export type BusinessArea = { area: string } & Record<AreaFigureKey, number>;

export interface BusinessAreas {
  cachedAt?: string | null;
  from: string;
  to: string;
  /** Every area with any figure, biggest commission first. */
  areas: BusinessArea[];
  /** Figures whose query failed: blank on the Dashboard, never zero. */
  failed: AreaFigureKey[];
  connected: boolean;
  generatedAt: string;
}

/** The three queries for a range (YYYY-MM-DD, both days in): leads, viewings, and deals with their commission. */
export function areasSql(from: string, to: string): { leads: string; viewings: string; deals: string } {
  const until = `DATE_ADD('${to}', INTERVAL 1 DAY)`;
  const leadTypes = `l.type IN ('Buyer','Seller','Tenant','Landlord')`;
  return {
    leads: `
      SELECT ${LEAD_AREA} AS area, COUNT(*) AS n
      FROM leads l ${LEAD_SCOPE_JOIN}${LEAD_PLACE}
      WHERE l.created_at >= '${from}' AND l.created_at < ${until} AND lloc.id IS NOT NULL
        AND ${leadTypes} AND ${LEAD_SCOPE}
      GROUP BY 1`,
    viewings: `
      SELECT ${LEAD_AREA} AS area, COUNT(*) AS n
      FROM activities a
      JOIN leads l ON l.id = a.lead_id ${LEAD_SCOPE_JOIN}${LEAD_PLACE}
      WHERE a.type = 'Viewing' AND a.status = 'Completed' AND a.datetime >= '${from}' AND a.datetime < ${until}
        AND lloc.id IS NOT NULL AND ${leadTypes} AND ${LEAD_SCOPE}
      GROUP BY 1`,
    deals: `
      SELECT ${AREA_NAME} AS area, COUNT(*) AS n, SUM(COALESCE(d.final_gross_commission_amount,0)) AS comm
      FROM deals d
      ${AREA_JOIN}
      WHERE d.reserved_at >= '${from}' AND d.reserved_at < ${until} AND ${DEAL_VALID}
      GROUP BY 1`,
  };
}

/** The queries' rows as one row per area, biggest commission first; a failed query (null) adds nothing. */
export function foldAreas(leads: unknown[][] | null, viewings: unknown[][] | null, deals: unknown[][] | null): BusinessArea[] {
  const byArea = new Map<string, BusinessArea>();
  const row = (raw: unknown) => {
    const area = String(raw ?? "").trim() || "(no area)";
    let r = byArea.get(area);
    if (!r) byArea.set(area, (r = { area, leads: 0, viewings: 0, deals: 0, commission: 0 }));
    return r;
  };
  for (const r of leads ?? []) row(r[0]).leads += Number(r[1] ?? 0);
  for (const r of viewings ?? []) row(r[0]).viewings += Number(r[1] ?? 0);
  for (const r of deals ?? []) {
    const a = row(r[0]);
    a.deals += Number(r[1] ?? 0);
    a.commission += Number(r[2] ?? 0);
  }
  return [...byArea.values()].sort((a, b) => b.commission - a.commission || b.deals - a.deals || b.leads - a.leads);
}

/** The business's areas for a range, remembered (lib/cache.ts) and kept only when every query answered. */
export async function getBusinessAreas(fromRaw?: string, toRaw?: string, opts: RememberOptions = {}): Promise<BusinessAreas> {
  const { from, to } = companyRange(fromRaw, toRaw);
  return remembered(cacheKey("businessAreas", { from, to }), () => computeBusinessAreas(from, to), (d) => d.connected && !d.failed.length, opts);
}

async function computeBusinessAreas(from: string, to: string): Promise<BusinessAreas> {
  const base = { from, to, areas: [], failed: [], connected: mbConfigured(), generatedAt: new Date().toISOString() };
  if (!base.connected) return base;
  const sql = areasSql(from, to);
  // The leads scan placed every lead in about 14 s for the year to date (23 Nov 2026).
  const [leads, viewings, deals] = await Promise.all([mbQueryEx(sql.leads, true, 50000), mbQueryEx(sql.viewings, true, 45000), mbQueryEx(sql.deals, true, 45000)]);
  const rows = (r: MbResult) => ("rows" in r ? r.rows : null);
  const failed: AreaFigureKey[] = [];
  if (!rows(leads)) failed.push("leads");
  if (!rows(viewings)) failed.push("viewings");
  if (!rows(deals)) failed.push("deals", "commission");
  return { ...base, areas: foldAreas(rows(leads), rows(viewings), rows(deals)), failed };
}
