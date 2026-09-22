// betterhomes search keywords for the news bot.
// Primary source is the `tracked_keywords` table (editable from the dashboard);
// falls back to PR_QUERIES env, then these defaults — so the bot keeps working
// even before the table exists.
import { readClient } from "@/lib/supabase";

export const DEFAULT_QUERIES = [
  // Brand forms. lib/match.ts already accepts every one of these, but the
  // search list only ever used the first few — so articles naming us as
  // "Better Homes" or "bhomes" were never even offered as candidates.
  "betterhomes",
  "betterhomes dubai",
  "better homes dubai",
  "bhomes",
  "betterhomes real estate",
  "betterhomes dubai property market",
  "PRIME by betterhomes",
  // How we are usually credited: as the source of the figures, in the body.
  "betterhomes data",
  "betterhomes analysis dubai",
  // People. They get quoted in stories whose headline never says "betterhomes".
  "Richard Waind",
  "Richard Waind betterhomes",
  "Alex Leigh betterhomes",
  // Topics our commentary lands on. Kept deliberately narrow: broad terms like
  // "webinar" returned global archive and ate the per-run article budget
  // without ever surfacing a mention. See migration 0016.
  "dubai real estate",
  "dubai property markets",
  "dubai mortgage",
  "dubai offplan",
  "dubai secondary market",
  "dubai prime property",
  "dubai golden visa property",
  "dubai branded residences",
  "dubai residential market report",
  "dubai land department data",
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
