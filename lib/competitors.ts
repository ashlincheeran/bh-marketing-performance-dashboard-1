// Brands tracked for news Share of Voice + the competitor-news feed.
// betterhomes is always included (isUs) and isn't user-editable. Competitors
// come from the `tracked_keywords` table (kind='competitor'); falls back to
// SOV_BRANDS env (JSON), then these defaults.
import { readClient } from "@/lib/supabase";

export interface SovBrand {
  name: string;
  query: string;
  isUs?: boolean;
}

export const US_BRAND: SovBrand = { name: "betterhomes", query: "betterhomes dubai", isUs: true };

export const DEFAULT_COMPETITORS: SovBrand[] = [
  { name: "Haus & Haus", query: "haus and haus dubai" },
  { name: "Engel & Völkers", query: "engel volkers dubai" },
  { name: "Allsopp & Allsopp", query: "allsopp and allsopp dubai" },
  { name: "Sotheby's", query: "sothebys realty dubai" },
  { name: "Driven Properties", query: "driven properties dubai" },
  { name: "White & Co", query: "white and co real estate dubai" },
  { name: "Metropolitan", query: "metropolitan premium properties dubai" },
];

export async function getSovBrands(): Promise<SovBrand[]> {
  const db = readClient();
  if (db) {
    try {
      const { data, error } = await db
        .from("tracked_keywords")
        .select("query,label")
        .eq("kind", "competitor")
        .eq("active", true)
        .order("created_at", { ascending: true });
      if (!error && data && data.length) {
        return [US_BRAND, ...data.map((r) => ({ name: (r.label as string) || (r.query as string), query: r.query as string }))];
      }
    } catch {
      /* table may not exist yet — fall back */
    }
  }
  const raw = process.env.SOV_BRANDS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as SovBrand[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      /* ignore bad env */
    }
  }
  return [US_BRAND, ...DEFAULT_COMPETITORS];
}
