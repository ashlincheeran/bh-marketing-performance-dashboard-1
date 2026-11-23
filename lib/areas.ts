// The business's areas, every channel together: where its leads, viewings,
// deals and commission come from, and where its listings are, for the
// Dashboard's best areas.
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
//
// Every figure is also split into sales and leasing by the Company tab's rules
// (lib/company.ts): a lead by its type (Buyer and Seller are sales, Tenant and
// Landlord leasing), a deal and a listing by whether it is a rental.
//
// Listings are the stock held today, whatever the range: every listing the CRM
// has as Active (public, private or offline) on a property, in its property's
// area. Drafts, listings in review, reserved, withdrawn and closed ones are
// not stock. Those first made in GoYzer count too: every Active one was
// activated again in 2025 or 2026, and about 300 of the 745 have had enquiries
// since August (23 Nov 2026).
import { cacheKey, remembered, type RememberOptions } from "@/lib/cache";
import { companyRange } from "@/lib/company";
import { daysInMonth, rangeFor, todayIn } from "@/lib/dateRanges";
import { DEAL_VALID, LEAD_SCOPE, LEAD_SCOPE_JOIN, mbConfigured, mbQueryEx, type MbResult } from "@/lib/metabase";
import { AREA_JOIN, AREA_NAME, LEAD_AREA, LEAD_PLACE, LISTING_AREA_JOIN } from "@/lib/portals";

export const AREA_FIGURES = ["leads", "viewings", "deals", "commission", "listings"] as const;
export type AreaFigureKey = (typeof AREA_FIGURES)[number];
export type AreaFigures = Record<AreaFigureKey, number>;

export const AREA_SIDES = ["sales", "leasing"] as const;
export type AreaSide = (typeof AREA_SIDES)[number];

/** One area's figures in all, and split into sales and leasing (the two add up to the whole). */
export type BusinessArea = { area: string } & AreaFigures & { sides: Record<AreaSide, AreaFigures> };

/** Sales or leasing, by the Company tab's rules (lib/company.ts). */
export const LEAD_SIDE = `CASE WHEN l.type IN ('Buyer','Seller') THEN 'sales' ELSE 'leasing' END`;
export const DEAL_SIDE = `CASE WHEN d.type = 'Rent' THEN 'leasing' ELSE 'sales' END`;
export const LISTING_SIDE = `CASE WHEN li.type = 'Rent' THEN 'leasing' ELSE 'sales' END`;

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

/** The listings we hold today, by area. */
export const LISTINGS_SQL = `
  SELECT ${AREA_NAME} AS area, ${LISTING_SIDE} AS side, COUNT(*) AS n
  FROM listings li ${LISTING_AREA_JOIN}
  WHERE li.listable_type = 'Property' AND li.status = 'Active'
  GROUP BY 1, 2`;

/** The three queries for a range (YYYY-MM-DD, both days in): leads, viewings, and deals with their commission. */
export function areasSql(from: string, to: string): { leads: string; viewings: string; deals: string } {
  const until = `DATE_ADD('${to}', INTERVAL 1 DAY)`;
  const leadTypes = `l.type IN ('Buyer','Seller','Tenant','Landlord')`;
  return {
    leads: `
      SELECT ${LEAD_AREA} AS area, ${LEAD_SIDE} AS side, COUNT(*) AS n
      FROM leads l ${LEAD_SCOPE_JOIN}${placeLeadsCreated(from, until)}
      WHERE l.created_at >= '${from}' AND l.created_at < ${until} AND lloc.id IS NOT NULL
        AND ${leadTypes} AND ${LEAD_SCOPE}
      GROUP BY 1, 2`,
    // A viewing's lead can be older than the range, so its place is asked lead by lead: a few thousand viewings, fast.
    viewings: `
      SELECT ${LEAD_AREA} AS area, ${LEAD_SIDE} AS side, COUNT(*) AS n
      FROM activities a
      JOIN leads l ON l.id = a.lead_id ${LEAD_SCOPE_JOIN}${LEAD_PLACE}
      WHERE a.type = 'Viewing' AND a.status = 'Completed' AND a.datetime >= '${from}' AND a.datetime < ${until}
        AND lloc.id IS NOT NULL AND ${leadTypes} AND ${LEAD_SCOPE}
      GROUP BY 1, 2`,
    deals: `
      SELECT ${AREA_NAME} AS area, ${DEAL_SIDE} AS side, COUNT(*) AS n, SUM(COALESCE(d.final_gross_commission_amount,0)) AS comm
      FROM deals d
      ${AREA_JOIN}
      WHERE d.reserved_at >= '${from}' AND d.reserved_at < ${until} AND ${DEAL_VALID}
      GROUP BY 1, 2`,
  };
}

const noFigures = (): AreaFigures => ({ leads: 0, viewings: 0, deals: 0, commission: 0, listings: 0 });

/**
 * The queries' rows (area, side, figure…) as one row per area, biggest
 * commission first, each figure in all and by side; a failed query (null)
 * adds nothing.
 */
export function foldAreas(
  leads: unknown[][] | null,
  viewings: unknown[][] | null,
  deals: unknown[][] | null,
  listings: unknown[][] | null = null,
): BusinessArea[] {
  const byArea = new Map<string, BusinessArea>();
  const row = (raw: unknown) => {
    const area = String(raw ?? "").trim() || "(no area)";
    let r = byArea.get(area);
    if (!r) byArea.set(area, (r = { area, ...noFigures(), sides: { sales: noFigures(), leasing: noFigures() } }));
    return r;
  };
  const add = (r: unknown[], k: AreaFigureKey, v: unknown) => {
    const a = row(r[0]);
    const side: AreaSide = r[1] === "leasing" ? "leasing" : "sales";
    a[k] += Number(v ?? 0);
    a.sides[side][k] += Number(v ?? 0);
  };
  for (const r of leads ?? []) add(r, "leads", r[2]);
  for (const r of viewings ?? []) add(r, "viewings", r[2]);
  for (const r of deals ?? []) {
    add(r, "deals", r[2]);
    add(r, "commission", r[3]);
  }
  for (const r of listings ?? []) add(r, "listings", r[2]);
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
  // "sides": rows carry sales or leasing; those kept before did not.
  const kept = await remembered(cacheKey("businessAreaLeads", { ...piece, sides: 1 }), ask, (d) => d.rows != null, { freshMs: SETTLED_MS });
  return kept.rows;
}

/** The business's areas for a range, remembered (lib/cache.ts) and kept only when every query answered. */
export async function getBusinessAreas(fromRaw?: string, toRaw?: string, opts: RememberOptions = {}): Promise<BusinessAreas> {
  const { from, to } = companyRange(fromRaw, toRaw);
  // "sides": answers kept before had no listings figure, or no sales and leasing split.
  return remembered(cacheKey("businessAreas", { from, to, sides: 1 }), () => computeBusinessAreas(from, to), (d) => d.connected && !d.failed.length, opts);
}

async function computeBusinessAreas(from: string, to: string): Promise<BusinessAreas> {
  const base = { from, to, areas: [], failed: [], connected: mbConfigured(), generatedAt: new Date().toISOString() };
  if (!base.connected) return base;
  const sql = areasSql(from, to);
  const today = rangeFor("today", todayIn("Asia/Dubai")).to;
  const [leadPieces, viewings, deals, listings] = await Promise.all([
    mapLimit(monthPieces(from, to), 3, (p) => leadsByArea(p, p.whole && p.to < today)),
    mbQueryEx(sql.viewings, true, 45000),
    mbQueryEx(sql.deals, true, 45000),
    mbQueryEx(LISTINGS_SQL, true, 45000),
  ]);
  const rows = (r: MbResult) => ("rows" in r ? r.rows : null);
  // Leads stand only when every month answered: a month missing would read as an area's fall.
  const leads = leadPieces.some((r) => r == null) ? null : leadPieces.flatMap((r) => r ?? []);
  const failed: AreaFigureKey[] = [];
  if (!leads) failed.push("leads");
  if (!rows(viewings)) failed.push("viewings");
  if (!rows(deals)) failed.push("deals", "commission");
  if (!rows(listings)) failed.push("listings");
  return { ...base, areas: foldAreas(leads, rows(viewings), rows(deals), rows(listings)), failed };
}
