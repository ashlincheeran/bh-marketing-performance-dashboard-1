// Portals — the listing-portal channel (Property Finder, Bayut, Dubizzle) read
// from the Engage CRM via Metabase. Spend comes from lib/portalSpend.ts.
//
// Every join and column below was READ off the live schema, not inferred:
//
//   listing_portals(listing_id, portal_id, status)   publication, status='Published'
//   listings.listable_id → properties (listable_type='Property')
//   properties.community_id → communities.id          building / sub-development
//   communities.location_id → locations.id            THE AREA — "Dubai Marina"
//
// `communities.name` is a building ("Al Meraikhi Tower", "Golf Promenade 4B"),
// so area grouping uses locations.name one level up. Grouping by community would
// have produced a list of towers, not areas.
//
// PORTAL IDs. There is no `portals` lookup table in this database, so portal_id
// is mapped by evidence:
//   1 → Property Finder. Its external_id is a 26-char ULID
//       ("001WTV3FZGYCD3KGPGP6EWG22R"), a format no other portal_id uses, and it
//       shares external_ids with no other portal.
//   2 → Bayut, 3 → Dubizzle. These two carry 8-digit numeric external_ids from
//       the same range and share the SAME external_id on 2,576 listings — the
//       signature of Bayut and dubizzle being one platform (Dubizzle Group).
//       Which of the pair is which is NOT derivable from the data. 2 has more
//       published listings than 3 (3,541 vs 2,523), matching Bayut's 9.5x larger
//       spend, so 2 is taken as Bayut. ASSUMPTION — override with
//       PORTAL_ID_OVERRIDE below if it's the wrong way round.
//   4, 6, 7 → other portals, no external_id ever returned. Left unmapped rather
//       than guessed, and reported so they aren't silently dropped.
//
// Definitions inherited from lib/company.ts so the tabs can't disagree:
//   • Lead    — a portal enquiry in the Engage CRM, by the shared LEAD_SCOPE
//               (no GoYzer rows, imports, internal or test cards; outside
//               brokers on "Agent" cards stay in). Portal leads are Engage's own
//               feed in any case: 5 of 270,738 since 2025 carry GoYzer.
//   • Deal    — status Reserved/Closed/Completed, state <> 'Withdrawn', by
//               reserved_at. Every deal Engage holds, including those keyed
//               into GoYzer and synced across — all portal deals until spring
//               2026 were, even when the lead came from the Engage feed.
//   • Revenue — final_gross_commission_amount, AED.
//   • Channel — enquiry_source of the deal's ORIGINATING lead.
import { rangeFor, todayIn } from "@/lib/dateRanges";
import { LEAD_SCOPE, LEAD_SCOPE_JOIN, mbQuery, mbQueryEx } from "@/lib/metabase";

export const PORTALS = ["Property Finder", "Bayut", "Dubizzle"] as const;
export type Portal = (typeof PORTALS)[number];

/** portal_id → portal name. Env override: "1=Property Finder,2=Dubizzle,3=Bayut". */
const PORTAL_ID_OVERRIDE = process.env.ENGAGE_PORTAL_IDS;

function portalIdMap(): Record<number, string> {
  if (PORTAL_ID_OVERRIDE) {
    const out: Record<number, string> = {};
    for (const pair of PORTAL_ID_OVERRIDE.split(",")) {
      const [k, v] = pair.split("=");
      const id = Number(k?.trim());
      if (Number.isFinite(id) && v?.trim()) out[id] = v.trim();
    }
    if (Object.keys(out).length) return out;
  }
  return { 1: "Property Finder", 2: "Bayut", 3: "Dubizzle" };
}

/** Which half of the business. Leasing = rentals; Sale = everything else. */
export type Side = "all" | "leasing" | "sale";

export interface PortalRow {
  portal: string;
  /** null when the query behind it failed — rendered "—", never 0. */
  leads: number | null;
  deals: number | null;
  commission: number | null;
  /** Listings currently published to this portal. */
  listings: number | null;
}

export interface AreaRow {
  area: string;
  /** Listings published to any mapped portal, in this area. */
  listings: number;
  deals: number;
  commission: number;
}

export interface PortalsData {
  connected: boolean;
  from: string;
  to: string;
  label: string;
  months: string[];
  portals: string[];
  brands: { key: string; label: string }[];
  brand: string;
  side: Side;
  generatedAt: string;

  rows: PortalRow[];
  /** Per portal, per month. All null when that query failed, so a trend shows a gap rather than a fall to zero. */
  leadsByMonth: Record<string, (number | null)[]>;
  dealsByMonth: Record<string, (number | null)[]>;
  commByMonth: Record<string, (number | null)[]>;

  /** Areas ordered by deals, biggest first — "which area got the most deals". */
  areas: AreaRow[];
  /** How the area grouping was reached, so the number can be audited. */
  areaSource: string;
  /** portal_id values present in listing_portals that we haven't mapped to a name. */
  unmappedPortalIds: { id: number; published: number }[];
  /** True when the Bayut/Dubizzle assignment is the inferred default. */
  portalIdsAssumed: boolean;

  error?: string;
  warnings: string[];
}

const isDate = (s?: string): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
/** Today in Dubai. The UTC date stopped the default range at yesterday until 04:00 Dubai time. */
const today = () => rangeFor("today", todayIn("Asia/Dubai")).to;
/**
 * A single-quoted SQL string. Backslashes are escaped as well as quotes: the
 * server runs without NO_BACKSLASH_ESCAPES, so a value ending in `\'` closed
 * the string early and ran the rest of it as SQL.
 */
const sqlStr = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

function monthList(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** enquiry_source → portal name. Anything else is NULL and excluded. */
function portalSql(col: string): string {
  const s = `LOWER(TRIM(${col}))`;
  return `CASE
    WHEN ${s} IN ('pf','property finder','propertyfinder','property-finder') THEN 'Property Finder'
    WHEN ${s} IN ('bayut','bayut.com') THEN 'Bayut'
    WHEN ${s} IN ('dubizzle','dubizzle.com') THEN 'Dubizzle'
    END`;
}

const DEAL_VALID = `d.status IN ('Reserved','Closed','Completed') AND d.state <> 'Withdrawn'`;

/** Deals: rentals are Leasing. Matches lib/company.ts. */
const dealSide = (side: Side) =>
  side === "leasing" ? ` AND d.type = 'Rent'` : side === "sale" ? ` AND d.type <> 'Rent'` : "";

/** Leads: Tenant/Landlord are Leasing, Buyer/Seller are Sale. */
const leadSide = (side: Side) =>
  side === "leasing"
    ? ` AND l.type IN ('Tenant','Landlord')`
    : side === "sale"
      ? ` AND l.type IN ('Buyer','Seller')`
      : ` AND l.type IN ('Buyer','Seller','Tenant','Landlord')`;

/** Listings: `listings.type` is exactly 'Rent' or 'Sale' — no other value exists. */
const listingSide = (side: Side) =>
  side === "leasing" ? ` AND li.type = 'Rent'` : side === "sale" ? ` AND li.type = 'Sale'` : "";

const BRAND_GROUPS: Record<string, string[]> = {
  betterhomes: ["Betterhomes", "Local", "BH Elite", "BH Exclusive"],
  prime: ["Prime"],
};

/**
 * Entity names a brand key selects; empty means "all brands". Only the named
 * groups: the page offers nothing else, and the old "entity:<name>" passthrough
 * put request text straight into the SQL.
 */
function brandNames(brand: string): string[] {
  return Object.hasOwn(BRAND_GROUPS, brand) ? BRAND_GROUPS[brand] : [];
}

function brandFilter(names: string[], col: string): string {
  if (!names.length) return "";
  return ` AND ${col} IN (SELECT id FROM divisions WHERE name IN (${names.map(sqlStr).join(",")}))`;
}

export function portalsRange(fromRaw?: string, toRaw?: string): { from: string; to: string } {
  const floor = "2025-01-01";
  let to = isDate(toRaw) ?? today();
  let from = isDate(fromRaw) ?? floor;
  // Order first, then clamp both ends. Clamping `from` before the swap turned a
  // range wholly before 2025 (2024-03-01 → 2024-06-30) into 2024-06-30 → 2025-01-01.
  if (to < from) [from, to] = [to, from];
  if (from < floor) from = floor;
  if (to < floor) to = floor;
  return { from, to };
}

/**
 * The AREA of a property: community → location, rolled up to the top of the
 * locations tree.
 *
 * `communities.location_id` does not point at one level. Of 5,412 portal deals
 * since 2025 that reach a location, only 1,972 sat on a top-level area; 3,228
 * sat one level below (a sub-community such as "02 Residence by Ned Al
 * Ghurair" inside Jumeirah Village Triangle) and 212 two levels below ("Act
 * Towers" in Opera District, Downtown Dubai). Grouped on the raw location the
 * table mixed buildings with areas. An area has at most two levels beneath it,
 * so grandparent, else parent, else itself is the area.
 */
const AREA_LOC = `
  JOIN locations loc ON loc.id = c.location_id
  LEFT JOIN locations loc1 ON loc1.id = loc.location_id
  LEFT JOIN locations loc2 ON loc2.id = loc1.location_id`;
const AREA_NAME = "COALESCE(loc2.name, loc1.name, loc.name)";
const AREA_JOIN = `
  JOIN listings li ON li.id = d.listing_id AND li.listable_type = 'Property'
  JOIN properties p ON p.id = li.listable_id
  JOIN communities c ON c.id = p.community_id${AREA_LOC}`;

export const AREA_SOURCE = "top-level locations.name (properties → communities → locations, rolled up)";

export async function getPortalsData(
  fromRaw?: string,
  toRaw?: string,
  brandRaw?: string,
  sideRaw?: string,
): Promise<PortalsData> {
  const { from, to } = portalsRange(fromRaw, toRaw);
  const months = monthList(from, to);
  const idx = new Map(months.map((m, i) => [m, i]));
  const brand = brandRaw && brandNames(brandRaw).length ? String(brandRaw) : "";
  const names = brandNames(brand);
  const side: Side = sideRaw === "leasing" || sideRaw === "sale" ? sideRaw : "all";

  const connected = !!(
    process.env.METABASE_URL &&
    (process.env.METABASE_API_KEY || (process.env.METABASE_USERNAME && process.env.METABASE_PASSWORD))
  );

  const zero = () => Object.fromEntries(PORTALS.map((p) => [p, new Array(months.length).fill(0)])) as Record<string, number[]>;
  /** A failed query's series: null, so the trend shows a gap rather than a fall to zero. */
  const blank = () => Object.fromEntries(PORTALS.map((p) => [p, new Array(months.length).fill(null)])) as Record<string, null[]>;
  const ids = portalIdMap();

  const base: PortalsData = {
    connected,
    from,
    to,
    label: `${from} → ${to}`,
    months,
    portals: [...PORTALS],
    brands: [
      { key: "", label: "All brands" },
      { key: "betterhomes", label: "Betterhomes" },
      { key: "prime", label: "Prime" },
    ],
    brand,
    side,
    generatedAt: new Date().toISOString(),
    rows: PORTALS.map((p) => ({ portal: p, leads: 0, deals: 0, commission: 0, listings: null })),
    leadsByMonth: zero(),
    dealsByMonth: zero(),
    commByMonth: zero(),
    areas: [],
    areaSource: AREA_SOURCE,
    unmappedPortalIds: [],
    portalIdsAssumed: !PORTAL_ID_OVERRIDE,
    warnings: [],
  };
  if (!connected) return base;

  const until = `DATE_ADD('${to}', INTERVAL 1 DAY)`;
  const P_LEAD = portalSql("l.enquiry_source");

  const leadsSql = `
    SELECT DATE_FORMAT(l.created_at,'%Y-%m') AS mth, ${P_LEAD} AS portal, COUNT(*) AS n
    FROM leads l ${LEAD_SCOPE_JOIN}
    WHERE l.created_at >= '${from}' AND l.created_at < ${until}
      AND ${P_LEAD} IS NOT NULL AND ${LEAD_SCOPE}${leadSide(side)}${brandFilter(names, "l.division_id")}
    GROUP BY 1,2`;

  const dealsSql = `
    SELECT DATE_FORMAT(d.reserved_at,'%Y-%m') AS mth, ${P_LEAD} AS portal,
           COUNT(*) AS n, SUM(COALESCE(d.final_gross_commission_amount,0)) AS comm
    FROM deals d
    LEFT JOIN leads l ON l.id = d.lead_id
    WHERE d.reserved_at >= '${from}' AND d.reserved_at < ${until}
      AND ${DEAL_VALID} AND ${P_LEAD} IS NOT NULL${dealSide(side)}${brandFilter(names, "d.division_id")}
    GROUP BY 1,2`;

  // Which area produced the most deals. Only deals reachable through a property
  // appear — a deal with no linked listing has no area, and is reported below
  // rather than being quietly dropped from the ranking.
  //
  // Every area, no LIMIT. A LIMIT 60 dropped 87 areas holding 372 deals (Jan
  // 2025 – Oct 2026) without a word, and 56 of them came back through the
  // listings merge below showing 0 deals. An area is one of 523 top-level
  // locations, so this stays far under Metabase's 2,000-row cap.
  const areaDealsSql = `
    SELECT ${AREA_NAME} AS area, COUNT(*) AS deals, SUM(COALESCE(d.final_gross_commission_amount,0)) AS comm
    FROM deals d
    JOIN leads l ON l.id = d.lead_id
    ${AREA_JOIN}
    WHERE d.reserved_at >= '${from}' AND d.reserved_at < ${until}
      AND ${DEAL_VALID} AND ${P_LEAD} IS NOT NULL${dealSide(side)}${brandFilter(names, "d.division_id")}
    GROUP BY 1 ORDER BY deals DESC`;

  // Deals in range that have a portal lead but no reachable area — the gap
  // between the area table's total and the headline deal count.
  const areaMissSql = `
    SELECT COUNT(*) FROM deals d
    JOIN leads l ON l.id = d.lead_id
    LEFT JOIN listings li ON li.id = d.listing_id AND li.listable_type = 'Property'
    LEFT JOIN properties p ON p.id = li.listable_id
    LEFT JOIN communities c ON c.id = p.community_id
    WHERE d.reserved_at >= '${from}' AND d.reserved_at < ${until}
      AND ${DEAL_VALID} AND ${P_LEAD} IS NOT NULL${dealSide(side)}${brandFilter(names, "d.division_id")}
      AND c.location_id IS NULL`;

  // Live published listings per portal. A snapshot of now: listing_portals has no
  // historical state, so this can't be filtered by the selected period. The
  // brand filter does apply: listings.division_id is the trading brand, as on
  // leads and deals (published now: Betterhomes group 3,194, Prime 63).
  const idList = Object.keys(ids).join(",");
  const portalCase = `CASE ${Object.entries(ids).map(([id, nm]) => `WHEN lp.portal_id = ${Number(id)} THEN ${sqlStr(nm)}`).join(" ")} END`;
  const listingsSql = `
    SELECT ${portalCase} AS portal, COUNT(DISTINCT lp.listing_id) AS n
    FROM listing_portals lp
    JOIN listings li ON li.id = lp.listing_id AND li.listable_type = 'Property'
    WHERE lp.status = 'Published' AND lp.portal_id IN (${idList})${listingSide(side)}${brandFilter(names, "li.division_id")}
    GROUP BY 1`;

  // No LIMIT, for the same reason as the deals by area: at most 523 rows.
  const areaListingsSql = `
    SELECT ${AREA_NAME} AS area, COUNT(DISTINCT lp.listing_id) AS n
    FROM listing_portals lp
    JOIN listings li ON li.id = lp.listing_id AND li.listable_type = 'Property'
    JOIN properties p ON p.id = li.listable_id
    JOIN communities c ON c.id = p.community_id${AREA_LOC}
    WHERE lp.status = 'Published' AND lp.portal_id IN (${idList})${listingSide(side)}${brandFilter(names, "li.division_id")}
    GROUP BY 1 ORDER BY n DESC`;

  const unmappedIdsSql = `
    SELECT lp.portal_id, COUNT(DISTINCT lp.listing_id) AS n
    FROM listing_portals lp
    WHERE lp.status = 'Published' AND lp.portal_id NOT IN (${idList})
    GROUP BY 1 ORDER BY 2 DESC`;

  const [leadsRes, dealsRes, areaDealRows, areaMissRows, listingRows, areaListRows, unmappedIdRows] = await Promise.all([
    // The leads scan alone took 15.8 s on an idle server and 29.8 s beside the
    // home page's other CRM queries, so 30 s left "Portal leads" blank under load.
    mbQueryEx(leadsSql, true, 50000),
    mbQueryEx(dealsSql, true, 45000),
    mbQuery(areaDealsSql, true, 30000),
    mbQuery(areaMissSql, true, 25000),
    mbQuery(listingsSql, true, 25000),
    mbQuery(areaListingsSql, true, 30000),
    mbQuery(unmappedIdsSql, true, 15000),
  ]);

  const leadRows = "rows" in leadsRes ? leadsRes.rows : null;
  const dealRows = "rows" in dealsRes ? dealsRes.rows : null;

  // A failed half is null, rendered "—", never 0: a zero deal count beside live
  // spend read as Net −AED 20M and 0.0× return on spend, with the reason a
  // bullet at the foot of the page.
  if (!leadRows && !dealRows) {
    return {
      ...base,
      rows: base.rows.map((r) => ({ ...r, leads: null, deals: null, commission: null })),
      leadsByMonth: blank(),
      dealsByMonth: blank(),
      commByMonth: blank(),
      error: `Metabase didn't return portal figures — ${"error" in leadsRes ? leadsRes.error : "unknown"}`,
    };
  }
  if (!leadRows) base.warnings.push(`Lead counts unavailable (${"error" in leadsRes ? leadsRes.error : "failed"}) — deals and commission are still live.`);
  if (!dealRows) base.warnings.push(`Deal and commission figures unavailable (${"error" in dealsRes ? dealsRes.error : "failed"}) — lead counts are still live.`);

  const leadsByMonth = zero();
  const dealsByMonth = zero();
  const commByMonth = zero();
  for (const r of leadRows ?? []) {
    const i = idx.get(String(r[0] ?? ""));
    const p = String(r[1] ?? "");
    if (i === undefined || !leadsByMonth[p]) continue;
    leadsByMonth[p][i] += Number(r[2] ?? 0);
  }
  for (const r of dealRows ?? []) {
    const i = idx.get(String(r[0] ?? ""));
    const p = String(r[1] ?? "");
    if (i === undefined || !dealsByMonth[p]) continue;
    dealsByMonth[p][i] += Number(r[2] ?? 0);
    commByMonth[p][i] += Number(r[3] ?? 0);
  }
  base.leadsByMonth = leadRows ? leadsByMonth : blank();
  base.dealsByMonth = dealRows ? dealsByMonth : blank();
  base.commByMonth = dealRows ? commByMonth : blank();

  const listed = new Map<string, number>();
  if (listingRows) {
    for (const r of listingRows) {
      const p = String(r[0] ?? "");
      listed.set(p, (listed.get(p) ?? 0) + Number(r[1] ?? 0));
    }
  } else {
    base.warnings.push("Published-listing counts unavailable — the listing_portals query failed or timed out.");
  }

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  base.rows = PORTALS.map((p) => ({
    portal: p,
    leads: leadRows ? sum(leadsByMonth[p]) : null,
    deals: dealRows ? sum(dealsByMonth[p]) : null,
    commission: dealRows ? sum(commByMonth[p]) : null,
    listings: listed.get(p) ?? null,
  }));

  // Merge deals-by-area with listings-by-area, ordered by deals.
  const areaMap = new Map<string, AreaRow>();
  for (const r of areaDealRows ?? []) {
    const a = String(r[0] ?? "").trim() || "(no area)";
    areaMap.set(a, { area: a, listings: 0, deals: Number(r[1] ?? 0), commission: Number(r[2] ?? 0) });
  }
  for (const r of areaListRows ?? []) {
    const a = String(r[0] ?? "").trim() || "(no area)";
    const cur = areaMap.get(a) ?? { area: a, listings: 0, deals: 0, commission: 0 };
    cur.listings = Number(r[1] ?? 0);
    areaMap.set(a, cur);
  }
  base.areas = [...areaMap.values()].sort((a, b) => b.deals - a.deals || b.listings - a.listings);
  if (!areaDealRows) base.warnings.push("Deals by area unavailable — the area query failed or timed out.");

  const missed = Number(areaMissRows?.[0]?.[0] ?? 0);
  if (missed > 0) {
    base.warnings.push(
      `${missed.toLocaleString()} portal deal${missed === 1 ? "" : "s"} in this period have no linked property, so they carry no area and are absent from the area table (they ARE in the totals above).`,
    );
  }

  base.unmappedPortalIds = (unmappedIdRows ?? []).map((r) => ({ id: Number(r[0] ?? 0), published: Number(r[1] ?? 0) }));

  return base;
}
