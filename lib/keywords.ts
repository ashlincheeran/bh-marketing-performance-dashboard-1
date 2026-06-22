// betterhomes search keywords for the news bot.
// Primary source is the `tracked_keywords` table (editable from the dashboard);
// falls back to PR_QUERIES env, then these defaults — so the bot keeps working
// even before the table exists.
import { readClient } from "@/lib/supabase";

export const DEFAULT_QUERIES = [
  "betterhomes dubai",
  "betterhomes dubai property market",
  "betterhomes real estate",
  "PRIME by betterhomes",
  "Richard Waind betterhomes",
  "CEO betterhomes",
  "property market updates",
  "webinar",
  "dubai real estate",
  "dubai property markets",
  "dubai mortgage",
  "dubai offplan",
  "dubai secondary market",
  "dubai communities",
];

export async function getKeywords(): Promise<string[]> {
  const db = readClient();
  if (db) {
    try {
      const { data, error } = await db
        .from("tracked_keywords")
        .select("query")
        .eq("kind", "pr")
        .eq("active", true)
        .order("created_at", { ascending: true });
      if (!error && data && data.length) return data.map((r) => r.query as string);
    } catch {
      /* table may not exist yet — fall back */
    }
  }
  const env = (process.env.PR_QUERIES || "").split(",").map((s) => s.trim()).filter(Boolean);
  return env.length ? env : DEFAULT_QUERIES;
}
