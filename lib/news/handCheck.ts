// What is left to decide of an article the bot could not read, company by
// company. Check by hand (lib/data.ts handCheckList) lists an article while a
// company of it is still open, and the morning's re-queue for Apify
// (lib/news/run.ts apifyTryDue) pays Apify to read only such an article, or
// one the old bot's row still counts with no person's word on it. Both read it
// here, so the re-queue never spends money on an article a person has decided
// on one of its rows, which Check by hand no longer lists. Pure.
import { oneLine } from "@/lib/coerce";
import { US, companyNamed } from "@/lib/news/registry";
import { ownSiteIn } from "@/lib/news/ownSite";
import { searchedFor } from "@/lib/news/search";
import { rejectedByHand, type MentionRef } from "@/lib/news/store";
import type { ArticleRow, Registry } from "@/lib/news/types";

/** A mentions row of a stored article: ours, a rival's, or the old bot's row it was imported from. */
export interface ArticleMentionRow {
  id: string;
  isUs: boolean;
  /** betterhomes, or the rival's label as the row gives it. */
  company: string;
  /** Counts on the PR tab: anything but rejected. */
  counting: boolean;
  personVerdict: "kept" | "rejected" | null;
}

/** The sources the bots write. A row from the historical import is "reviewed" from the start, which says nothing about a person. */
const BOT_SOURCES = new Set(["googlenews", "competitor_news"]);

/**
 * A mentions row read the way Bot Activity needs it. The company follows the
 * PR page's rule (getMentions, getSov): competitor_news is a rival's, anything
 * else ours. A bot's row reviewed without a verdict was kept by the old Bot
 * Activity, which set the status and nothing else, and a row rejected by hand
 * in the old rival feed's cleanup was a person's Reject (rejectedByHand).
 *
 * A rival's row is named and counted as the competitor feed and Share of
 * Voice count it (competitorStories): by the label of the rival `reg` tracks
 * now, whatever spelling it was stored under ("Engel & Volkers" is Engel &
 * Völkers), and not at all for a rival no longer tracked. Bot Activity said
 * such a row was still counted on the PR tab, which leaves it out.
 */
export function toArticleMentionRow(r: Omit<MentionRef, "articleId">, reg: Registry): ArticleMentionRow {
  const verdict =
    r.personVerdict === "kept" || r.personVerdict === "rejected"
      ? r.personVerdict
      : rejectedByHand({ status: r.status, metadata: { rejected_by: r.rejectedBy } })
        ? "rejected"
        : r.status === "reviewed" && BOT_SOURCES.has(r.source ?? "")
          ? "kept"
          : null;
  const isUs = r.source !== "competitor_news";
  const rival = isUs ? null : companyNamed(reg, r.competitor);
  const tracked = isUs || (!!rival && !rival.isUs);
  return {
    id: r.id,
    isUs,
    company: isUs ? US.label : rival && !rival.isUs ? rival.label : oneLine(r.competitor) || "a rival",
    counting: r.status !== "rejected" && tracked,
    personVerdict: verdict,
  };
}

/** An unreadable article's companies, as Check by hand splits them. */
export interface CompanySplit {
  /** The companies nobody has decided yet, betterhomes first: no row for one counts, and no person has said it is not about it. */
  open: string[];
  /** The companies it counts for already, betterhomes first: by a person's Count, or as the old bot left it. */
  counted: string[];
  /** One of `counted` counts by a row with no person's word on it: the old bot's, as it left it. */
  countedUnchecked: boolean;
  /** A search for a tracked company found it, or a row of it is one's: false for what only general market searches found. */
  tied: boolean;
}

/**
 * An unreadable article's companies, from its searches and its rows: its own,
 * the old bot's row it was imported from, and its copies' old rows.
 *
 * The article is for the companies its searches were for (lib/news/search.ts
 * searchedFor) and the companies the old bot's rows for it were for, since the
 * old bot found it by searching for that company. Each of them is counted
 * when a row for it counts (a person's Count, or the old bot's row as it left
 * it), decided when none does and a person has said so on one (Not about, a
 * Reject on the old screen, the rival feed's cleanup, the audit of 6 Nov
 * 2026), and open otherwise. The company whose own website it is on is none of
 * them, since the page can never count for it (lib/news/ownSite.ts).
 *
 * `searchedBy` is searchedFor, which a caller going through many articles may
 * remember for each search.
 */
export function companySplit(
  a: Pick<ArticleRow, "found_by" | "url" | "outlet">,
  rows: ArticleMentionRow[],
  reg: Registry,
  searchedBy: (search: string) => string[] = (search) => searchedFor(search, reg),
): CompanySplit {
  const labels = reg.companies.map((c) => c.label);
  const tracked = new Set(labels);
  const ours = rows.filter((r) => tracked.has(r.company));
  const searches = (Array.isArray(a.found_by) ? a.found_by : []).filter((s): s is string => typeof s === "string");
  const searched = new Set([...searches.flatMap(searchedBy), ...ours.map((r) => r.company)]);
  const owner = ownSiteIn(a, reg);
  const open: string[] = [];
  const counted: string[] = [];
  let countedUnchecked = false;
  for (const label of labels) {
    if (!searched.has(label) || label === owner) continue;
    const theirs = ours.filter((r) => r.company === label);
    if (theirs.some((r) => r.counting)) {
      counted.push(label);
      if (theirs.some((r) => r.counting && !r.personVerdict)) countedUnchecked = true;
    } else if (!theirs.some((r) => r.personVerdict)) {
      open.push(label);
    }
  }
  return { open, counted, countedUnchecked, tied: searched.size > 0 };
}

/**
 * True while something of an unreadable article is left for a read to settle:
 * a company still open, or one only the old bot's row counts, with no
 * person's word on it, which the AI would confirm or take out of the count.
 * False once a person has decided each of its companies, and for what nothing
 * ties to a tracked company.
 */
export const leftToDecide = (split: CompanySplit): boolean => split.open.length > 0 || split.countedUnchecked;
