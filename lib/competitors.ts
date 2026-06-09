// Brands tracked for news Share of Voice. One "<brand> dubai" query each so the
// comparison is fair. betterhomes is flagged so the UI can highlight it.
// Override via SOV_BRANDS env (JSON: [{"name":"...","query":"..."}]).
export interface SovBrand {
  name: string;
  query: string;
  isUs?: boolean;
}

export const DEFAULT_SOV_BRANDS: SovBrand[] = [
  { name: "betterhomes", query: "betterhomes dubai", isUs: true },
  { name: "Haus & Haus", query: "haus and haus dubai" },
  { name: "Engel & Völkers", query: "engel volkers dubai" },
  { name: "Allsopp & Allsopp", query: "allsopp and allsopp dubai" },
  { name: "Sotheby's", query: "sothebys realty dubai" },
  { name: "Driven Properties", query: "driven properties dubai" },
  { name: "White & Co", query: "white and co real estate dubai" },
];

export function getSovBrands(): SovBrand[] {
  const raw = process.env.SOV_BRANDS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as SovBrand[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      /* fall through to default */
    }
  }
  return DEFAULT_SOV_BRANDS;
}
