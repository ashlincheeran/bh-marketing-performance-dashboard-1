// One row per placement: the rule that decides when two stored rows are the
// same story, so the PR tab, Share of Voice and the competitor feed count it
// once. Pure and free of the database, so the server reads (lib/data.ts) and
// the browser can both use it.
import { outletKey } from "@/lib/match";

/** A headline as compared: lower case, letters and digits only, single spaces. */
export const headline = (t: string | null | undefined): string =>
  String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** True when two dates are at most a week apart. Two missing dates count as the same day; one missing date matches nothing. */
export const withinAWeek = (a: string | null, b: string | null): boolean =>
  a == null || b == null ? a == b : Math.abs(Date.parse(a) - Date.parse(b)) <= 7 * 86_400_000;

/** "Khaleej Times" rather than "khaleejtimes.com": the name the outlets' rate card knows. */
export const named = (outlet: string | null): boolean => !!outlet && !/\.[a-z]{2,}$/i.test(outlet.trim());

/** What onePerPlacement compares two rows by. */
export interface Placement {
  /** Whose story it is: betterhomes, or a rival's label. The same headline for two brands is two stories. */
  brand: string;
  date: string | null;
  title: string | null;
  outlet: string | null;
  url: string | null;
}

/**
 * One row per placement: the same headline from the same publication, for the
 * same brand, within a week is one story, whatever name the feed gave the
 * publication.
 *
 * The news feed names an outlet by its title one day and its web address the
 * next, and copies also came in through the import and the backfill, so 11
 * stories sat in the table two or three times: 14 extra press mentions in the
 * twelve months to Oct 2026. A headline carried by two DIFFERENT publications
 * stays two placements, as the PR team counts syndication.
 *
 * Of two twins the first is kept, unless only the later one names the
 * publication the way the rate card does. A row with no headline is never
 * folded: there is nothing to compare it by.
 *
 * `onMerge(kept, dropped)` is called each time a row is folded into its twin,
 * with the row that stays and the one that goes, so a caller can carry what
 * the dropped row knew (such as that the bot found the story) over to the one
 * that is counted. When a later row takes its twin's place, `kept` is the
 * later row and `dropped` the earlier one, with whatever was carried into it.
 */
export function onePerPlacement<T>(
  rows: T[],
  pick: (r: T) => Placement,
  onMerge?: (kept: T, dropped: T) => void,
): T[] {
  const kept: T[] = [];
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const r = pick(row);
    const title = headline(r.title);
    if (!title) {
      kept.push(row);
      continue;
    }
    const key = `${r.brand}|${title}|${outletKey(r.outlet, r.url)}`;
    const at = groups.get(key) ?? [];
    const twin = at.find((i) => withinAWeek(pick(kept[i]).date, r.date));
    if (twin === undefined) {
      at.push(kept.length);
      groups.set(key, at);
      kept.push(row);
    } else if (!named(pick(kept[twin]).outlet) && named(r.outlet)) {
      const earlier = kept[twin];
      kept[twin] = row;
      onMerge?.(row, earlier);
    } else {
      onMerge?.(kept[twin], row);
    }
  }
  return kept;
}
