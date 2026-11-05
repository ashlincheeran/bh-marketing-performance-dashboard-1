// Brands tracked for news Share of Voice + the competitor-news feed.
// betterhomes is always included (isUs) and isn't user-editable. Competitors
// come from the `tracked_keywords` table (kind='competitor'), the list the PR
// tab's editor shows, and from nowhere else.
import { readClient } from "@/lib/supabase";

export interface SovBrand {
  name: string;
  query: string;
  isUs?: boolean;
}

export const US_BRAND: SovBrand = { name: "betterhomes", query: "betterhomes dubai", isUs: true };

/**
 * The seven rivals the table started with (migration 0006). The bot never
 * reads these: lib/data.ts still shows them in the editor when the table can't
 * be read.
 */
export const DEFAULT_COMPETITORS: SovBrand[] = [
  { name: "Haus & Haus", query: "haus and haus dubai" },
  { name: "Engel & Völkers", query: "engel volkers dubai" },
  { name: "Allsopp & Allsopp", query: "allsopp and allsopp dubai" },
  { name: "Sotheby's", query: "sothebys realty dubai" },
  { name: "Driven Properties", query: "driven properties dubai" },
  { name: "White & Co", query: "white and co real estate dubai" },
  { name: "Metropolitan", query: "metropolitan premium properties dubai" },
];

/**
 * betterhomes, then every active rival in tracked_keywords, oldest first.
 *
 * Exactly what the table holds: with no active rival, betterhomes alone. This
 * used to fall back to SOV_BRANDS or the seven defaults whenever the read
 * failed or found no rows. The defaults lack Knight Frank and fäm Properties
 * and the editor never showed them, so one failed read cost Knight Frank its
 * stories, and emptying the list made the bot track rivals nobody could see or
 * remove. A read that fails now throws, so no caller takes it for "no rivals".
 */
export async function getSovBrands(): Promise<SovBrand[]> {
  const fail = (why: string) => new Error(`The rival list could not be read: ${why}`);
  const db = readClient();
  if (!db) throw fail("Supabase is not configured");
  try {
    const { data, error } = await db
      .from("tracked_keywords")
      .select("query,label")
      .eq("kind", "competitor")
      .eq("active", true)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return [US_BRAND, ...(data ?? []).map((r) => ({ name: (r.label as string) || (r.query as string), query: r.query as string }))];
  } catch (e) {
    throw fail(e instanceof Error ? e.message : String(e));
  }
}
