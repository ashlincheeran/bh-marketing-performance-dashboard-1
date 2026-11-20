// Portals — the listing-portal channel (Property Finder, Bayut, Dubizzle) read
// from the Engage CRM via Metabase. No spend: it is coming to Metabase, and will
// be read from there.
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
// The figures are counted the way the business's own portal table counts them
// (checked against it to the deal and the dirham for Aug and Sep 2026):
//   • Lead         — a portal enquiry, by created_at, in the shared LEAD_SCOPE
//                    (no GoYzer rows, imports, internal or test cards; outside
//                    brokers on "Agent" cards stay in). The scope leaves out
//                    up to 80 of 7,000 to 8,600 portal leads a month: in Oct
//                    2026, Property Finder's 80 were 53 from one test contact,
//                    24 on bhomes or vendor addresses and 3 on internal cards.
//   • Viewing      — an activity of type Viewing, status Completed, on a portal
//                    lead (same scope), dated by when it took place (datetime).
//   • Reservation  — a deal by reserved_at, valued at its RESERVED gross
//                    commission (reserved_gross_commission_amount), by the
//                    shared DEAL_VALID rule (status Reserved, Closed or
//                    Completed, not Withdrawn).
//   Invoiced deals are not shown: the CRM has recorded invoice dates only since
//   30 Mar 2026, so they could not be read for every range.
//   • Channel      — enquiry_source of the lead the viewing or deal hangs on.
//   • Side         — Leasing or Sale, by the same rules as the Side filter: a
//                    lead (and its viewings) by the lead's type, a deal by its
//                    own type. The trend shows the two apart.
import { cacheKey, remembered, type RememberOptions } from "@/lib/cache";
import { dateOrNull, rangeFor, todayIn } from "@/lib/dateRanges";
import { sumOrNull } from "@/lib/format";
import { DEAL_VALID, LEAD_SCOPE, LEAD_SCOPE_JOIN, mbConfigured, mbQuery, mbQueryEx, type MbResult } from "@/lib/metabase";
import { brandFilter, brandKey } from "@/lib/brands";

const PORTALS = ["Property Finder", "Bayut", "Dubizzle"] as const;

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

/** What the tab reports per portal and month (see the definitions at the top of this file). */
export const PORTAL_METRICS = ["leads", "viewings", "reservations", "reservedComm"] as const;
export type PortalMetric = (typeof PORTAL_METRICS)[number];

/** One half of the business: the trend shows each apart. */
export type SideKey = Exclude<Side, "all">;

/** Per metric, per portal, per month. All null when that query failed, so a trend shows a gap rather than a fall to zero. */
export type PortalMonthly = Record<PortalMetric, Record<string, (number | null)[]>>;

/** Each metric over the whole range. null when the query behind it failed — rendered "—", never 0. */
export type PortalRow = { portal: string } & Record<PortalMetric, number | null>;

export interface AreaRow {
  area: string;
  /** Listings on Property Finder, Bayut or Dubizzle at any point in the range, in this area. */
  listings: number;
  /** Portal deals reserved in the period, in this area, and their reserved commission. */
  reservations: number;
  reservedComm: number;
}

export interface PortalsData {
  /** When this answer was worked out (lib/cache.ts), for "Updated … ago". Null or absent when worked out just now and not kept. */
  cachedAt?: string | null;

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
  /** Per metric, per portal, per month, both sides together: the totals. */
  monthly: PortalMonthly;
  /** The same for Sale and for Leasing apart: the trend. A side the filter leaves out is all zero. */
  bySide: Record<SideKey, PortalMonthly>;
  /** Portal leads in the range left out as test forms, staff or internal cards (LEAD_SCOPE), counted by the same query. Null when it failed. */
  leadsLeftOut: number | null;

  /** Areas ordered by reservations, biggest first — "which area got the most deals". */
  areas: AreaRow[];
  /** How the area grouping was reached, so the number can be audited. */
  areaSource: string;
  /** portal_id values with listings in the range that we haven't mapped to a name. */
  unmappedPortalIds: { id: number; published: number }[];
  /** True when the Bayut/Dubizzle assignment is the inferred default. */
  portalIdsAssumed: boolean;
  /** How the CRM's portal numbers are read (portal_id → name), for the notes. */
  portalIds?: Record<number, string>;

  error?: string;
  warnings: string[];
}

/** Today in Dubai. The UTC date stopped the default range at yesterday until 04:00 Dubai time. */
const today = () => rangeFor("today", todayIn("Asia/Dubai")).to;

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

/**
 * Each row's side, by the same rules as the two filters above, so Sale and
 * Leasing add up to All. Every portal deal is Rent or Sale and every portal
 * lead one of the four types (checked 19 Nov 2026), so nothing falls between.
 */
const LEAD_SIDE = `CASE WHEN l.type IN ('Tenant','Landlord') THEN 'leasing' WHEN l.type IN ('Buyer','Seller') THEN 'sale' END`;
const DEAL_SIDE = `CASE WHEN d.type = 'Rent' THEN 'leasing' WHEN d.type <> 'Rent' THEN 'sale' END`;

/** Listings: `listings.type` is exactly 'Rent' or 'Sale' — no other value exists. */
const listingSide = (side: Side) =>
  side === "leasing" ? ` AND li.type = 'Rent'` : side === "sale" ? ` AND li.type = 'Sale'` : "";

function portalsRange(fromRaw?: string, toRaw?: string): { from: string; to: string } {
  const floor = "2025-01-01";
  let to = dateOrNull(toRaw) ?? today();
  // By default the year to date, from 1 January in Dubai, as the picker shows it.
  let from = dateOrNull(fromRaw) ?? `${today().slice(0, 4)}-01-01`;
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

const AREA_SOURCE = "top-level locations.name (properties → communities → locations, rolled up)";

/**
 * The Portals tab's figures, remembered (lib/cache.ts): its CRM queries take up
 * to half a minute. Kept only when every query answered (no error, and no
 * warning that a part is unavailable).
 */
export async function getPortalsData(
  fromRaw?: string,
  toRaw?: string,
  brandRaw?: string,
  sideRaw?: string,
  opts: RememberOptions = {},
): Promise<PortalsData> {
  const { from, to } = portalsRange(fromRaw, toRaw);
  const brand = brandKey(brandRaw);
  const side = sideRaw === "leasing" || sideRaw === "sale" ? sideRaw : "all";
  return remembered(
    // Named apart from answers kept before the trend split Sale and Leasing, which lack it.
    cacheKey("portalsBySide", { from, to, brand, side }),
    () => computePortalsData(from, to, brand || undefined, side),
    // A warning that a part is unavailable is a failed query; the others are notes (deals with no area, say).
    (d) => d.connected && !d.error && !d.warnings.some((w) => /unavailable/i.test(w)),
    opts,
  );
}

async function computePortalsData(
  fromRaw?: string,
  toRaw?: string,
  brandRaw?: string,
  sideRaw?: string,
): Promise<PortalsData> {
  const { from, to } = portalsRange(fromRaw, toRaw);
  const months = monthList(from, to);
  const idx = new Map(months.map((m, i) => [m, i]));
  const brand = brandKey(brandRaw);
  const side: Side = sideRaw === "leasing" || sideRaw === "sale" ? sideRaw : "all";

  const connected = mbConfigured();

  const zero = () => Object.fromEntries(PORTALS.map((p) => [p, new Array(months.length).fill(0)])) as Record<string, number[]>;
  /** A failed query's series: null, so the trend shows a gap rather than a fall to zero. */
  const blank = () => Object.fromEntries(PORTALS.map((p) => [p, new Array(months.length).fill(null)])) as Record<string, null[]>;
  const zeroMonthly = () => Object.fromEntries(PORTAL_METRICS.map((m) => [m, zero()])) as PortalMonthly;
  const blankMonthly = () => Object.fromEntries(PORTAL_METRICS.map((m) => [m, blank()])) as PortalMonthly;
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
    rows: PORTALS.map((p) => ({ portal: p, ...Object.fromEntries(PORTAL_METRICS.map((m) => [m, 0])) }) as PortalRow),
    monthly: zeroMonthly(),
    bySide: { sale: zeroMonthly(), leasing: zeroMonthly() },
    leadsLeftOut: null,
    areas: [],
    areaSource: AREA_SOURCE,
    unmappedPortalIds: [],
    portalIdsAssumed: !PORTAL_ID_OVERRIDE,
    portalIds: ids,
    warnings: [],
  };
  if (!connected) return base;

  const until = `DATE_ADD('${to}', INTERVAL 1 DAY)`;
  const P_LEAD = portalSql("l.enquiry_source");

  // Leads in the shared scope (n), and every portal lead row (all_rows), in one
  // scan: the difference is the test, staff and internal leads left out, shown
  // on the tab as a count rather than typed into a note.
  const leadsSql = `
    SELECT DATE_FORMAT(l.created_at,'%Y-%m') AS mth, ${P_LEAD} AS portal, ${LEAD_SIDE} AS side,
           SUM(CASE WHEN ${LEAD_SCOPE} THEN 1 ELSE 0 END) AS n, COUNT(*) AS all_rows
    FROM leads l ${LEAD_SCOPE_JOIN}
    WHERE l.created_at >= '${from}' AND l.created_at < ${until}
      AND ${P_LEAD} IS NOT NULL${leadSide(side)}${brandFilter(brand, "l.division_id")}
    GROUP BY 1,2,3`;

  // Viewings that took place, by the day they took place, on portal leads in
  // the same scope as the lead count they are set against.
  const viewingsSql = `
    SELECT DATE_FORMAT(a.datetime,'%Y-%m') AS mth, ${P_LEAD} AS portal, ${LEAD_SIDE} AS side, COUNT(*) AS n
    FROM activities a
    JOIN leads l ON l.id = a.lead_id ${LEAD_SCOPE_JOIN}
    WHERE a.type = 'Viewing' AND a.status = 'Completed'
      AND a.datetime >= '${from}' AND a.datetime < ${until}
      AND ${P_LEAD} IS NOT NULL AND ${LEAD_SCOPE}${leadSide(side)}${brandFilter(brand, "l.division_id")}
    GROUP BY 1,2,3`;

  /** Portal deals by one of their dates, valued at one commission column. */
  const dealsSql = (dateCol: string, commCol: string) => `
    SELECT DATE_FORMAT(d.${dateCol},'%Y-%m') AS mth, ${P_LEAD} AS portal, ${DEAL_SIDE} AS side,
           COUNT(*) AS n, SUM(COALESCE(d.${commCol},0)) AS comm
    FROM deals d
    JOIN leads l ON l.id = d.lead_id
    WHERE d.${dateCol} >= '${from}' AND d.${dateCol} < ${until}
      AND ${DEAL_VALID} AND ${P_LEAD} IS NOT NULL${dealSide(side)}${brandFilter(brand, "d.division_id")}
    GROUP BY 1,2,3`;
  const reservedSql = dealsSql("reserved_at", "reserved_gross_commission_amount");

  // Which area produced the most reservations. Only deals reachable through a property
  // appear — a deal with no linked listing has no area, and is reported below
  // rather than being quietly dropped from the ranking.
  //
  // Every area, no LIMIT. A LIMIT 60 dropped 87 areas holding 372 deals (Jan
  // 2025 – Oct 2026) without a word, and 56 of them came back through the
  // listings merge below showing 0 deals. An area is one of 523 top-level
  // locations, so this stays far under Metabase's 2,000-row cap.
  const areaDealsSql = `
    SELECT ${AREA_NAME} AS area, COUNT(*) AS deals, SUM(COALESCE(d.reserved_gross_commission_amount,0)) AS comm
    FROM deals d
    JOIN leads l ON l.id = d.lead_id
    ${AREA_JOIN}
    WHERE d.reserved_at >= '${from}' AND d.reserved_at < ${until}
      AND ${DEAL_VALID} AND ${P_LEAD} IS NOT NULL${dealSide(side)}${brandFilter(brand, "d.division_id")}
    GROUP BY 1 ORDER BY deals DESC`;

  // Reservations in range that have a portal lead but no reachable area — the
  // gap between the area table's total and the headline reservation count.
  const areaMissSql = `
    SELECT COUNT(*) FROM deals d
    JOIN leads l ON l.id = d.lead_id
    LEFT JOIN listings li ON li.id = d.listing_id AND li.listable_type = 'Property'
    LEFT JOIN properties p ON p.id = li.listable_id
    LEFT JOIN communities c ON c.id = p.community_id
    WHERE d.reserved_at >= '${from}' AND d.reserved_at < ${until}
      AND ${DEAL_VALID} AND ${P_LEAD} IS NOT NULL${dealSide(side)}${brandFilter(brand, "d.division_id")}
      AND c.location_id IS NULL`;

  // Listings on a portal at any point in the range, so they follow the date
  // filter like every other figure. Each listing_portals row is one spell on a
  // portal: published_at, and unpublished_at once it came down (every row has
  // the one it needs). The brand filter applies: listings.division_id is the
  // trading brand, as on leads and deals.
  const idList = Object.keys(ids).join(",");
  const onPortalInRange = `lp.published_at < ${until} AND (lp.unpublished_at IS NULL OR lp.unpublished_at >= '${from}')`;

  // No LIMIT, for the same reason as the deals by area: at most 523 rows.
  const areaListingsSql = `
    SELECT ${AREA_NAME} AS area, COUNT(DISTINCT lp.listing_id) AS n
    FROM listing_portals lp
    JOIN listings li ON li.id = lp.listing_id AND li.listable_type = 'Property'
    JOIN properties p ON p.id = li.listable_id
    JOIN communities c ON c.id = p.community_id${AREA_LOC}
    WHERE lp.portal_id IN (${idList}) AND ${onPortalInRange}${listingSide(side)}${brandFilter(brand, "li.division_id")}
    GROUP BY 1 ORDER BY n DESC`;

  const unmappedIdsSql = `
    SELECT lp.portal_id, COUNT(DISTINCT lp.listing_id) AS n
    FROM listing_portals lp
    WHERE lp.portal_id NOT IN (${idList}) AND ${onPortalInRange}
    GROUP BY 1 ORDER BY 2 DESC`;

  const [leadsRes, viewingsRes, reservedRes, areaDealRows, areaMissRows, areaListRows, unmappedIdRows] =
    await Promise.all([
      // The leads scan alone took 15.8 s on an idle server and 29.8 s beside the
      // home page's other CRM queries, so 30 s left "Portal leads" blank under load.
      mbQueryEx(leadsSql, true, 50000),
      mbQueryEx(viewingsSql, true, 45000),
      mbQueryEx(reservedSql, true, 45000),
      mbQuery(areaDealsSql, true, 30000),
      mbQuery(areaMissSql, true, 25000),
      mbQuery(areaListingsSql, true, 30000),
      mbQuery(unmappedIdsSql, true, 15000),
    ]);

  // A failed query's figures are null, rendered "—", never 0, and say why.
  const parts = [
    { res: leadsRes, name: "Lead counts" },
    { res: viewingsRes, name: "Viewings" },
    { res: reservedRes, name: "Reservations and reserved commission" },
  ];
  const failed = parts.filter((x) => !("rows" in x.res));
  if (failed.length === parts.length) {
    return {
      ...base,
      rows: base.rows.map((r) => ({ ...r, ...Object.fromEntries(PORTAL_METRICS.map((m) => [m, null])) })),
      monthly: blankMonthly(),
      bySide: { sale: blankMonthly(), leasing: blankMonthly() },
      error: `Metabase didn't return portal figures — ${"error" in leadsRes ? leadsRes.error : "unknown"}`,
    };
  }
  for (const x of failed) {
    base.warnings.push(`${x.name} unavailable (${"error" in x.res ? x.res.error : "failed"}) — the other figures are still live.`);
  }

  /**
   * One query's rows as per-portal monthly figures from column `col`, for one
   * side (column 2) or both; null throughout when the query failed.
   */
  const series = (res: MbResult, col: number, sd?: SideKey): Record<string, (number | null)[]> => {
    if (!("rows" in res)) return blank();
    const out = zero();
    for (const r of res.rows) {
      if (sd && r[2] !== sd) continue;
      const i = idx.get(String(r[0] ?? ""));
      const p = String(r[1] ?? "");
      if (i === undefined || !out[p]) continue;
      out[p][i] += Number(r[col] ?? 0);
    }
    return out;
  };
  const monthlyFor = (sd?: SideKey): PortalMonthly => ({
    leads: series(leadsRes, 3, sd),
    viewings: series(viewingsRes, 3, sd),
    reservations: series(reservedRes, 3, sd),
    reservedComm: series(reservedRes, 4, sd),
  });
  base.monthly = monthlyFor();
  base.bySide = { sale: monthlyFor("sale"), leasing: monthlyFor("leasing") };

  base.leadsLeftOut =
    "rows" in leadsRes ? leadsRes.rows.reduce((s, r) => s + Number(r[4] ?? 0) - Number(r[3] ?? 0), 0) : null;

  base.rows = PORTALS.map(
    (p) =>
      ({
        portal: p,
        ...Object.fromEntries(PORTAL_METRICS.map((m) => [m, sumOrNull(base.monthly[m][p])])),
      }) as PortalRow,
  );



  // Merge reservations-by-area with listings-by-area, ordered by reservations.
  const areaMap = new Map<string, AreaRow>();
  for (const r of areaDealRows ?? []) {
    const a = String(r[0] ?? "").trim() || "(no area)";
    areaMap.set(a, { area: a, listings: 0, reservations: Number(r[1] ?? 0), reservedComm: Number(r[2] ?? 0) });
  }
  for (const r of areaListRows ?? []) {
    const a = String(r[0] ?? "").trim() || "(no area)";
    const cur = areaMap.get(a) ?? { area: a, listings: 0, reservations: 0, reservedComm: 0 };
    cur.listings = Number(r[1] ?? 0);
    areaMap.set(a, cur);
  }
  base.areas = [...areaMap.values()].sort((a, b) => b.reservations - a.reservations || b.listings - a.listings);
  if (!areaDealRows) base.warnings.push("Reservations by area unavailable — the area query failed or timed out.");
  if (!areaListRows) base.warnings.push("Listings by area unavailable — the listing_portals query failed or timed out.");

  const missed = Number(areaMissRows?.[0]?.[0] ?? 0);
  if (missed > 0) {
    base.warnings.push(
      `${missed.toLocaleString()} portal reservation${missed === 1 ? "" : "s"} in this period have no linked property, so they carry no area and are absent from the area table (they ARE in the totals above).`,
    );
  }

  base.unmappedPortalIds = (unmappedIdRows ?? []).map((r) => ({ id: Number(r[0] ?? 0), published: Number(r[1] ?? 0) }));

  return base;
}
