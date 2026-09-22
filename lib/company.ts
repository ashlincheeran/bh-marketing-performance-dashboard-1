// Company Performance — leads, deals and gross commission by channel, straight
// from the Engage CRM via Metabase. Server-only.
//
// VERIFIED against the "Leads & deals by channel" report (build v10, prepared
// 22 Jul 2026) that this tab replaces. The definitions below reproduce that
// report's monthly figures to the rounding digit, e.g.
//   2025-01  970 deals / AED 9,502,546      2025-06  831 deals / AED 19,021,390
//   2025-03  883 deals / AED 14,399,957     2025-07  919 deals / AED 23,368,128
// and its off-plan split (579 deals / AED 75.5M here vs 576 / AED 76.0M in the
// report — the drift is data added since it was prepared).
//
// Definitions, mirroring that report exactly:
//   • Deal     — status Reserved/Closed/Completed, state <> 'Withdrawn', dated
//                by reserved_at (reservation date).
//   • Revenue  — final_gross_commission_amount, AED.
//   • Channel  — enquiry_source of the deal's ORIGINATING lead. Deals with no
//                linked lead, or a lead with no source, fall in "No Source".
//                Instagram sits in "Other", not Meta/Facebook — the report
//                groups it that way and we keep the definitions aligned.
//   • Division — deals: Rent → Leasing; Sale → Off-plan when the linked
//                property is flagged "Off Plan", else Secondary (which is why
//                sales with no linked listing land in Secondary).
//                leads: Buyer/Seller → Sales, Tenant/Landlord → Leasing.
//                Enquiries carry NO off-plan flag, so leads — and therefore
//                conversion — cannot be split off-plan vs secondary.
//   • Brand    — deals.division_id / leads.division_id is the trading brand
//                (Betterhomes, Prime, BH Elite, BH Exclusive, Local), NOT the
//                Sales/Leasing division. Exposed as a filter.
//
// Portal spend, cost per deal and return on spend are deliberately absent: the
// CRM holds no spend data (the old report hardcoded it from a spreadsheet).
import { mbQuery } from "@/lib/metabase";

/** Fixed start of the reporting window — the tab covers Jan 2025 onwards. */
export const START_MONTH = "2025-01";

export const CHANNELS = [
  "Property Finder",
  "Bayut",
  "Client Referral",
  "Previous Tenant/Buyer",
  "Meta/Facebook",
  "Agent External",
  "Dubizzle",
  "No Source",
  "Other",
] as const;
export type Channel = (typeof CHANNELS)[number];

export const DEAL_DIVISIONS = ["Offplan", "Secondary", "Leasing"] as const;
export const LEAD_DIVISIONS = ["Sales", "Leasing"] as const;
export type DealDivision = (typeof DEAL_DIVISIONS)[number];
export type LeadDivision = (typeof LEAD_DIVISIONS)[number];

/**
 * Trading entities are reported as two brands: the Betterhomes family (the main
 * book plus the Local bucket and the Elite/Exclusive licences) and Prime, which
 * is kept separate. Matching is by entity NAME rather than division_id so the
 * grouping survives id changes, and any entity we don't recognise surfaces as
 * its own brand instead of being silently folded into a total.
 */
export const BRAND_GROUPS: { key: string; label: string; names: string[] }[] = [
  { key: "betterhomes", label: "Betterhomes", names: ["Betterhomes", "Local", "BH Elite", "BH Exclusive"] },
  { key: "prime", label: "Prime", names: ["Prime"] },
];

/** Entities excluded everywhere — system rows with no trading activity. */
const EXCLUDED_ENTITIES = ["Admin Control"];

export interface Brand {
  key: string;
  label: string;
  /** The underlying CRM entities folded into this brand. */
  entities: string[];
}

/** Month-indexed series: series[channel][monthIndex]. */
type Series = Record<string, number[]>;

export interface CompanyData {
  connected: boolean;
  from: string;
  to: string;
  label: string;
  months: string[];
  channels: string[];
  brands: Brand[];
  /** Brand group key the figures are filtered to; "" = all brands. */
  brand: string;
  /** When the CRM was queried, ISO — surfaced as the "updated" stamp. */
  generatedAt: string;
  leads: Record<LeadDivision, Series>;
  deals: Record<DealDivision, Series>;
  comm: Record<DealDivision, Series>;
  error?: string;
}

const isDate = (s?: string): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Inclusive list of "YYYY-MM" between two dates. */
function monthList(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function emptySeries(months: number): Series {
  const s: Series = {};
  for (const c of CHANNELS) s[c] = new Array(months).fill(0);
  return s;
}

/**
 * Resolve the range. Defaults to START_MONTH → today; `from` is clamped so the
 * tab never reaches back before the window we committed to.
 */
export function companyRange(fromRaw?: string, toRaw?: string): { from: string; to: string } {
  const floor = `${START_MONTH}-01`;
  let to = isDate(toRaw) ?? ymd(new Date());
  let from = isDate(fromRaw) ?? floor;
  if (from < floor) from = floor;
  if (to < from) [from, to] = [to, from];
  if (to < floor) to = floor;
  return { from, to };
}

// The channel bucket, as a SQL expression over an `enquiry_source` column.
function channelSql(col: string): string {
  const s = `LOWER(TRIM(${col}))`;
  return `CASE
    WHEN ${s} IN ('pf','property finder','propertyfinder') THEN 'Property Finder'
    WHEN ${s} = 'bayut' THEN 'Bayut'
    WHEN ${s} = 'client referral' THEN 'Client Referral'
    WHEN ${s} = 'previous tenant/buyer' THEN 'Previous Tenant/Buyer'
    WHEN ${s} = 'facebook' OR ${s} LIKE 'meta-%' THEN 'Meta/Facebook'
    WHEN ${s} = 'agent external' THEN 'Agent External'
    WHEN ${s} = 'dubizzle' THEN 'Dubizzle'
    WHEN ${col} IS NULL OR ${s} = '' THEN 'No Source'
    ELSE 'Other' END`;
}

// A deal counts when it reached reservation and wasn't withdrawn.
const DEAL_VALID = `d.status IN ('Reserved','Closed','Completed') AND d.state <> 'Withdrawn'`;

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Restrict to a brand group by name, via a subquery on `divisions` — avoids
 * hardcoding division ids and keeps it to a single round trip.
 */
function brandFilter(brand: string, col: string): string {
  const names = brandNames(brand);
  if (!names.length) return "";
  return ` AND ${col} IN (SELECT id FROM divisions WHERE name IN (${names.map(sqlStr).join(",")}))`;
}

/** Entity names a brand key selects; empty means "all brands". */
function brandNames(brand: string): string[] {
  const group = BRAND_GROUPS.find((g) => g.key === brand);
  if (group) return group.names;
  // an entity we don't group, addressed directly as "entity:<name>"
  if (brand.startsWith("entity:")) return [brand.slice("entity:".length)];
  return [];
}

export async function getCompanyData(fromRaw?: string, toRaw?: string, brandRaw?: string): Promise<CompanyData> {
  const { from, to } = companyRange(fromRaw, toRaw);
  const months = monthList(from, to);
  const idx = new Map(months.map((m, i) => [m, i]));
  const brand = brandRaw && brandNames(brandRaw).length ? String(brandRaw) : "";

  const connected = !!(
    process.env.METABASE_URL &&
    (process.env.METABASE_API_KEY || (process.env.METABASE_USERNAME && process.env.METABASE_PASSWORD))
  );

  const base: CompanyData = {
    connected,
    from,
    to,
    label: `${from} → ${to}`,
    months,
    channels: [...CHANNELS],
    brands: [],
    brand,
    generatedAt: new Date().toISOString(),
    leads: { Sales: emptySeries(months.length), Leasing: emptySeries(months.length) },
    deals: { Offplan: emptySeries(months.length), Secondary: emptySeries(months.length), Leasing: emptySeries(months.length) },
    comm: { Offplan: emptySeries(months.length), Secondary: emptySeries(months.length), Leasing: emptySeries(months.length) },
  };
  if (!connected) return base;

  // `to` is inclusive, so compare against the following midnight.
  const until = `DATE_ADD('${to}', INTERVAL 1 DAY)`;

  const leadsSql = `
    SELECT DATE_FORMAT(l.created_at,'%Y-%m') AS mth,
           ${channelSql("l.enquiry_source")} AS ch,
           CASE WHEN l.type IN ('Buyer','Seller') THEN 'Sales' ELSE 'Leasing' END AS dv,
           COUNT(*) AS n
    FROM leads l
    WHERE l.created_at >= '${from}' AND l.created_at < ${until}
      AND l.type IN ('Buyer','Seller','Tenant','Landlord')${brandFilter(brand, "l.division_id")}
    GROUP BY 1,2,3`;

  const dealsSql = `
    SELECT DATE_FORMAT(d.reserved_at,'%Y-%m') AS mth,
           ${channelSql("l.enquiry_source")} AS ch,
           CASE WHEN d.type = 'Rent' THEN 'Leasing'
                WHEN p.completion_status = 'Off Plan' THEN 'Offplan'
                ELSE 'Secondary' END AS dv,
           COUNT(*) AS n,
           SUM(COALESCE(d.final_gross_commission_amount,0)) AS comm
    FROM deals d
    LEFT JOIN leads l ON l.id = d.lead_id
    LEFT JOIN listings li ON li.id = d.listing_id AND li.listable_type = 'Property'
    LEFT JOIN properties p ON p.id = li.listable_id
    WHERE d.reserved_at >= '${from}' AND d.reserved_at < ${until}
      AND ${DEAL_VALID}${brandFilter(brand, "d.division_id")}
    GROUP BY 1,2,3`;

  const brandsSql = `SELECT id, name FROM divisions ORDER BY name`;

  // The leads aggregate is the slow one. Measured at ~40s against the live view
  // on 2026-08-20, which is why 30s was failing reliably rather than
  // occasionally — `leads` is a VIEW, so every run re-derives it and no index
  // can be applied. 60s per the operator's call; the routes allow 90s so the
  // function is not killed before the query returns.
  const [leadRows, dealRows, brandRows] = await Promise.all([
    mbQuery(leadsSql, true, 60000),
    mbQuery(dealsSql, true, 45000),
    mbQuery(brandsSql, true, 10000),
  ]);

  // Fold the CRM entities into brand groups. Anything unrecognised becomes its
  // own brand so a newly-added licence shows up rather than vanishing.
  const entityNames = (brandRows ?? [])
    .map((r) => String(r[1] ?? "").trim())
    .filter((n) => n && !EXCLUDED_ENTITIES.includes(n));
  const grouped = new Set(BRAND_GROUPS.flatMap((g) => g.names));
  base.brands = [
    ...BRAND_GROUPS.filter((g) => g.names.some((n) => entityNames.includes(n))).map((g) => ({
      key: g.key,
      label: g.label,
      entities: g.names.filter((n) => entityNames.includes(n)),
    })),
    ...entityNames
      .filter((n) => !grouped.has(n))
      .map((n) => ({ key: `entity:${n}`, label: n, entities: [n] })),
  ];

  if (!leadRows && !dealRows) {
    console.error("[company] both Metabase aggregates failed (timeout or auth)");
    return {
      ...base,
      error:
        "Metabase didn't return data — the CRM aggregates timed out or the account can't read the deals/leads views. Check METABASE_URL / METABASE_USERNAME / METABASE_PASSWORD.",
    };
  }

  for (const r of leadRows ?? []) {
    const i = idx.get(String(r[0] ?? ""));
    const ch = String(r[1] ?? "");
    const dv = String(r[2] ?? "") as LeadDivision;
    if (i === undefined || !base.leads[dv]?.[ch]) continue;
    base.leads[dv][ch][i] += Number(r[3] ?? 0);
  }

  for (const r of dealRows ?? []) {
    const i = idx.get(String(r[0] ?? ""));
    const ch = String(r[1] ?? "");
    const dv = String(r[2] ?? "") as DealDivision;
    if (i === undefined || !base.deals[dv]?.[ch]) continue;
    base.deals[dv][ch][i] += Number(r[3] ?? 0);
    base.comm[dv][ch][i] += Number(r[4] ?? 0);
  }

  if (!leadRows) base.error = "Lead figures unavailable (Metabase leads aggregate timed out) — deals and revenue are still live.";
  else if (!dealRows) base.error = "Deal and revenue figures unavailable (Metabase deals aggregate timed out) — lead counts are still live.";

  return base;
}


/**
 * One month, broken down by DAY instead of by month.
 *
 * The main payload is monthly, which is the right grain for a 19-month trend but
 * collapses a single month into one bar. Selecting a month should show its shape
 * — which days earned, which were flat — so that month is re-queried at day
 * grain.
 *
 * A separate query rather than making the main one daily: the monthly leads
 * aggregate already takes ~40s over the whole range, and day grain across 19
 * months would multiply the rows it groups for data no chart shows. Scoped to
 * one month it reads a thirtieth of the range and returns quickly.
 *
 * Definitions are the ones in this file — same channel mapping, same DEAL_VALID,
 * same brand filter — so a day here always rolls up to the month above it.
 */
export interface CompanyDaily {
  month: string;
  /** Every day in the month up to today, "YYYY-MM-DD". */
  days: string[];
  channels: string[];
  leads: Record<LeadDivision, Series>;
  deals: Record<DealDivision, Series>;
  comm: Record<DealDivision, Series>;
  error?: string;
}

/** Days in `month` ("YYYY-MM"), stopping at today for the month in progress. */
function dayList(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return [];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = new Date();
  const isCurrent = today.getUTCFullYear() === y && today.getUTCMonth() + 1 === m;
  const end = isCurrent ? Math.min(last, today.getUTCDate()) : last;
  const out: string[] = [];
  for (let d = 1; d <= end; d++) out.push(`${month}-${String(d).padStart(2, "0")}`);
  return out;
}

export async function getCompanyDaily(month: string, brandRaw?: string): Promise<CompanyDaily> {
  const valid = /^\d{4}-\d{2}$/.test(month);
  const days = valid ? dayList(month) : [];
  const idx = new Map(days.map((d, i) => [d, i]));
  const brand = brandRaw && brandNames(brandRaw).length ? String(brandRaw) : "";

  const empty = (): Series => {
    const s: Series = {};
    for (const c of CHANNELS) s[c] = new Array(days.length).fill(0);
    return s;
  };
  const base: CompanyDaily = {
    month,
    days,
    channels: [...CHANNELS],
    leads: { Sales: empty(), Leasing: empty() },
    deals: { Offplan: empty(), Secondary: empty(), Leasing: empty() },
    comm: { Offplan: empty(), Secondary: empty(), Leasing: empty() },
  };
  if (!valid || !days.length) return { ...base, error: "Not a valid month." };

  const connected = !!(
    process.env.METABASE_URL &&
    (process.env.METABASE_API_KEY || (process.env.METABASE_USERNAME && process.env.METABASE_PASSWORD))
  );
  if (!connected) return base;

  const from = days[0];
  const until = `DATE_ADD('${days[days.length - 1]}', INTERVAL 1 DAY)`;

  const leadsSql = `
    SELECT DATE_FORMAT(l.created_at,'%Y-%m-%d') AS d,
           ${channelSql("l.enquiry_source")} AS ch,
           CASE WHEN l.type IN ('Buyer','Seller') THEN 'Sales' ELSE 'Leasing' END AS dv,
           COUNT(*) AS n
    FROM leads l
    WHERE l.created_at >= '${from}' AND l.created_at < ${until}
      AND l.type IN ('Buyer','Seller','Tenant','Landlord')${brandFilter(brand, "l.division_id")}
    GROUP BY 1,2,3`;

  const dealsSql = `
    SELECT DATE_FORMAT(d.reserved_at,'%Y-%m-%d') AS d,
           ${channelSql("l.enquiry_source")} AS ch,
           CASE WHEN d.type = 'Rent' THEN 'Leasing'
                WHEN p.completion_status = 'Off Plan' THEN 'Offplan'
                ELSE 'Secondary' END AS dv,
           COUNT(*) AS n,
           SUM(COALESCE(d.final_gross_commission_amount,0)) AS comm
    FROM deals d
    LEFT JOIN leads l ON l.id = d.lead_id
    LEFT JOIN listings li ON li.id = d.listing_id AND li.listable_type = 'Property'
    LEFT JOIN properties p ON p.id = li.listable_id
    WHERE d.reserved_at >= '${from}' AND d.reserved_at < ${until}
      AND ${DEAL_VALID}${brandFilter(brand, "d.division_id")}
    GROUP BY 1,2,3`;

  const [leadRows, dealRows] = await Promise.all([
    mbQuery(leadsSql, true, 45000),
    mbQuery(dealsSql, true, 45000),
  ]);

  for (const r of leadRows ?? []) {
    const i = idx.get(String(r[0] ?? ""));
    const ch = String(r[1] ?? "");
    const dv = String(r[2] ?? "") as LeadDivision;
    if (i === undefined || !base.leads[dv]?.[ch]) continue;
    base.leads[dv][ch][i] += Number(r[3] ?? 0);
  }
  for (const r of dealRows ?? []) {
    const i = idx.get(String(r[0] ?? ""));
    const ch = String(r[1] ?? "");
    const dv = String(r[2] ?? "") as DealDivision;
    if (i === undefined || !base.deals[dv]?.[ch]) continue;
    base.deals[dv][ch][i] += Number(r[3] ?? 0);
    base.comm[dv][ch][i] += Number(r[4] ?? 0);
  }

  // Partial is reported, never silently shown as zero.
  if (!leadRows && !dealRows) base.error = "Daily figures unavailable — the CRM queries timed out.";
  else if (!leadRows) base.error = "Daily lead counts unavailable; deals and revenue are live.";
  else if (!dealRows) base.error = "Daily deal and revenue figures unavailable; lead counts are live.";

  return base;
}
