// betterhomes search keywords for the news bot.
// They come from the `tracked_keywords` table (kind='pr'), the list the PR
// tab's editor shows, and from nowhere else.
import { readClient } from "@/lib/supabase";

/**
 * The list the code used to fall back to. The bot never reads it now:
 * lib/data.ts still shows it in the editor when the table can't be read.
 */
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

/**
 * Every active PR keyword in tracked_keywords, oldest first.
 *
 * Exactly what the table holds, so an emptied list is an empty list. This used
 * to fall back to PR_QUERIES or the list above whenever the read failed or
 * found no rows, and the bot then searched terms the editor did not show and
 * nobody could remove. A read that fails now throws, so no caller takes it for
 * "no keywords".
 */
export async function getKeywords(): Promise<string[]> {
  const fail = (why: string) => new Error(`The PR keyword list could not be read: ${why}`);
  const db = readClient();
  if (!db) throw fail("Supabase is not configured");
  try {
    const { data, error } = await db
      .from("tracked_keywords")
      .select("query")
      .eq("kind", "pr")
      .eq("active", true)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => r.query as string);
  } catch (e) {
    throw fail(e instanceof Error ? e.message : String(e));
  }
}
