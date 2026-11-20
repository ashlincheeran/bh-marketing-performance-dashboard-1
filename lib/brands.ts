// The brands Company and Portals filter by, as rules over the CRM's divisions,
// so a new licence joins without a code change. Prime is reported on its own;
// Betterhomes is every other division that trades, that is, every division
// with a valid deal. A system division with no deals (Admin Control today) is
// in neither, and a new licence joins Betterhomes with its first deal.
import { DEAL_VALID } from "@/lib/metabase";

/** The one division reported on its own. */
const PRIME = "Prime";

export type BrandKey = "betterhomes" | "prime";

/** A brand key from a request, or "" (all brands) for anything else: no request text reaches the SQL. */
export function brandKey(raw: string | null | undefined): BrandKey | "" {
  return raw === "betterhomes" || raw === "prime" ? raw : "";
}

/** The divisions that trade: those with a valid deal. */
const TRADING = `SELECT d.division_id FROM deals d WHERE ${DEAL_VALID}`;

/** SQL narrowing `col` (a division id) to a brand; "" for all brands. */
export function brandFilter(brand: BrandKey | "", col: string): string {
  if (brand === "prime") return ` AND ${col} IN (SELECT id FROM divisions WHERE name = '${PRIME}')`;
  if (brand === "betterhomes") return ` AND ${col} IN (SELECT dv.id FROM divisions dv WHERE dv.name <> '${PRIME}' AND dv.id IN (${TRADING}))`;
  return "";
}

/** The divisions that trade, named: what brandsFrom groups. */
export const TRADING_DIVISIONS_SQL = `SELECT dv.id, dv.name FROM divisions dv WHERE dv.id IN (${TRADING}) ORDER BY dv.name`;

export interface Brand {
  key: BrandKey;
  label: string;
  /** The CRM divisions it holds. */
  entities: string[];
}

/** Each brand and the trading divisions it holds, from the divisions' names. */
export function brandsFrom(tradingNames: string[]): Brand[] {
  const names = tradingNames.map((n) => n.trim()).filter(Boolean);
  const betterhomes = names.filter((n) => n !== PRIME);
  return [
    ...(betterhomes.length ? [{ key: "betterhomes" as const, label: "Betterhomes", entities: betterhomes }] : []),
    ...(names.includes(PRIME) ? [{ key: "prime" as const, label: "Prime", entities: [PRIME] }] : []),
  ];
}
