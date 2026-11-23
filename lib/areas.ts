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
import { daysInMonth, rangeFor, todayIn } from "@/lib/dateRanges";
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

/**
 * LEAD_PLACE (lib/portals.ts), the same rule, for every lead created from
 * `from` to `until`: the listing the lead first asked about (its first
 * lead_requirements row), else the property an owner's lead carries. Here the
 * first requirement of every lead in the range is found in one grouped pass:
 * asked lead by lead, as LEAD_PLACE asks it, the year to date's leads of every
 * channel ran past the CRM's one-minute limit; grouped, they took 22 s
 * (23 Nov 2026). Same areas either way.
 */
const placeLeadsCreated = (from: string, until: string) => `
  LEFT JOIN (
    SELECT r.lead_id, MIN(r.id) AS id
    FROM lead_requirements r JOIN leads rl ON rl.id = r.lead_id
    WHERE rl.created_at >= '${from}' AND rl.created_at < ${until}
    GROUP BY r.lead_id
  ) fr ON fr.lead_id = l.id
  LEFT JOIN lead_requirements lrq ON lrq.id = fr.id
  LEFT JOIN listings lli ON lli.id = lrq.listing_id AND lli.listable_type = 'Property'
  LEFT JOIN properties lpr ON lpr.id = COALESCE(lli.listable_id, CASE WHEN l.leadable_type = 'Property' THEN l.leadable_id END)
  LEFT JOIN communities lcm ON lcm.id = lpr.community_id
  LEFT JOIN locations lloc ON lloc.id = lcm.location_id
  LEFT JOIN locations lloc1 ON lloc1.id = lloc.location_id
  LEFT JOIN locations lloc2 ON lloc2.id = lloc1.location_id`;

/** The three queries for a range (YYYY-MM-DD, both days in): leads, viewings, and deals with their commission. */
export function areasSql(from: string, to: string): { leads: string; viewings: string; deals: string } {
  const until = `DATE_ADD('${to}', INTERVAL 1 DAY)`;
  const leadTypes = `l.type IN ('Buyer','Seller','Tenant','Landlord')`;
  return {
    leads: `
      SELECT ${LEAD_AREA} AS area, COUNT(*) AS n
      FROM leads l ${LEAD_SCOPE_JOIN}${placeLeadsCreated(from, until)}
      WHERE l.created_at >= '${from}' AND l.created_at < ${until} AND lloc.id IS NOT NULL
        AND ${leadTypes} AND ${LEAD_SCOPE}
      GROUP BY 1`,
    // A viewing's lead can be older than the range, so its place is asked lead by lead: a few thousand viewings, fast.
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

/** A range in month pieces, the first and last cut to the range, each saying whether it is a whole calendar month. */
export function monthPieces(from: string, to: string): { from: string; to: string; whole: boolean }[] {
  const out: { from: string; to: string; whole: boolean }[] = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); ) {
    const first = `${m}-01`, last = `${m}-${String(daysInMonth(m)).padStart(2, "0")}`;
    const a = from > first ? from : first, b = to < last ? to : last;
    out.push({ from: a, to: b, whole: a === first && b === last });
    const [y, mm] = m.split("-").map(Number);
    m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
  }
  return out;
}

/** Run `fn` over `items` with at most `limit` in flight, answers in the items' order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** How long a month that is over keeps its leads by area before they are counted again: they barely move once it ends. */
const SETTLED_MS = 7 * 24 * 60 * 60_000;

/**
 * One month piece's leads by area. The year to date's leads of every channel
 * in one query ran past the CRM's one-minute limit beside the Dashboard's other
 * asks, so they are counted a month at a time (about 3 to 12 s each), three at
 * once. A month that is over is kept for a week and shared by every range it
 * falls in; the month still running, and a part month, are counted each time.
 */
async function leadsByArea(piece: { from: string; to: string }, settled: boolean): Promise<unknown[][] | null> {
  const ask = async () => {
    const r = await mbQueryEx(areasSql(piece.from, piece.to).leads, true, 50000);
    return { rows: "rows" in r ? r.rows : null };
  };
  if (!settled) return (await ask()).rows;
  const kept = await remembered(cacheKey("businessAreaLeads", piece), ask, (d) => d.rows != null, { freshMs: SETTLED_MS });
  return kept.rows;
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
  const today = rangeFor("today", todayIn("Asia/Dubai")).to;
  const [leadPieces, viewings, deals] = await Promise.all([
    mapLimit(monthPieces(from, to), 3, (p) => leadsByArea(p, p.whole && p.to < today)),
    mbQueryEx(sql.viewings, true, 45000),
    mbQueryEx(sql.deals, true, 45000),
  ]);
  const rows = (r: MbResult) => ("rows" in r ? r.rows : null);
  // Leads stand only when every month answered: a month missing would read as an area's fall.
  const leads = leadPieces.some((r) => r == null) ? null : leadPieces.flatMap((r) => r ?? []);
  const failed: AreaFigureKey[] = [];
  if (!leads) failed.push("leads");
  if (!rows(viewings)) failed.push("viewings");
  if (!rows(deals)) failed.push("deals", "commission");
  return { ...base, areas: foldAreas(leads, rows(viewings), rows(deals)), failed };
}
