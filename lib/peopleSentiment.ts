// Which stored social mentions the people-sentiment figures count, and how:
// the rules the People sentiment tab (components/PeopleSentiment.tsx) uses,
// shared so the Dashboard's figures are the tab's own.
import { mentionsBetterhomes } from "@/lib/match";
import type { SocialConfig, SocialMention } from "@/lib/socialTypes";

/**
 * Which stored rows the figures may count.
 *
 * On 20 Oct 101 of 272 kept rows had never been scored (the run's score cap
 * kept the rest unchecked), and search hits that named nobody had been filed
 * under betterhomes: 15 of 19 kept Reddit "betterhomes" posts never mentioned
 * the brand. Unscored rows are shown as pending; search hits that name no
 * tracked subject are hidden. The brand's own Instagram, Facebook and Glassdoor
 * pages are about it by definition.
 */
const SEARCH_CHANNELS = new Set(["reddit", "linkedin"]);
export function namesSubject(m: SocialMention, handle: string): boolean {
  if (!SEARCH_CHANNELS.has(m.channel)) return true;
  const text = m.content ?? "";
  if (m.subject_kind === "person") return text.toLowerCase().includes(m.subject.toLowerCase());
  return mentionsBetterhomes(text) || (!!handle && text.toLowerCase().includes(handle));
}
export const isScored = (m: SocialMention) => m.sentiment != null || typeof m.sentiment_score === "number";
// One post is stored once per subject it names, so it is counted by its own key.
export const postKey = (m: SocialMention) => `${m.channel}|${m.url ?? m.content?.slice(0, 60) ?? m.id}`;
export const distinctPosts = (items: SocialMention[]) => new Set(items.map(postKey)).size;

/** One post, however many subjects it names. */
export interface Post {
  key: string;
  /** Its stored rows, one per subject it names. */
  rows: SocialMention[];
  subjects: string[];
  /** Its tone: the one its subjects share, or mixed when they differ; null when none is scored. */
  sentiment: SocialMention["sentiment"];
  /** The average of its subjects' scores, -1 to +1; null when none is scored. */
  score: number | null;
}

/**
 * Stored rows as posts, so every figure counts in one unit.
 *
 * A post naming betterhomes and one of its people is stored twice, once per
 * subject. On 26 Nov 2026 the tab's headline counted 130 posts while its feed,
 * footer and net score counted the 155 rows behind them (pending 68 against
 * 72, net +27 per post against +26 per row). Of 31 posts filed under two
 * subjects, 4 had a different tone for each.
 */
export function toPosts(items: SocialMention[]): Post[] {
  const byKey = new Map<string, SocialMention[]>();
  for (const m of items) {
    const k = postKey(m);
    const rows = byKey.get(k);
    if (rows) rows.push(m);
    else byKey.set(k, [m]);
  }
  return [...byKey.entries()].map(([key, rows]) => {
    const tones = [...new Set(rows.map((m) => m.sentiment).filter((t) => t != null))];
    const scores = rows.map((m) => m.sentiment_score).filter((n): n is number => typeof n === "number");
    return {
      key,
      rows,
      subjects: [...new Set(rows.map((m) => m.subject))],
      sentiment: tones.length > 1 ? "mixed" : (tones[0] ?? null),
      score: scores.length ? scores.reduce((a, n) => a + n, 0) / scores.length : null,
    };
  });
}

/**
 * Average tone per post, -1 to +1; null with none scored. Shown as an index
 * from -100 to +100. A post filed under two subjects counts once, at the
 * average of its two scores; a subject's own rows are one per post anyway.
 */
export function netScore(items: SocialMention[]): number | null {
  const scores = toPosts(items).map((p) => p.score).filter((n): n is number => n != null);
  if (!scores.length) return null;
  return scores.reduce((a, n) => a + n, 0) / scores.length;
}

/** The brand's Instagram handle, lower case and without its @: a search hit naming it is about the brand. */
export const brandHandle = (cfg: SocialConfig) => (cfg.platforms.instagram.username ?? "").trim().replace(/^@/, "").toLowerCase();

/** The subjects in Tracking (betterhomes and the people added), lower case. */
export const trackedNames = (cfg: Pick<SocialConfig, "subjects">) =>
  new Set(cfg.subjects.map((s) => s.name.trim().toLowerCase()).filter(Boolean));

/**
 * Whether a stored row's subject is still in Tracking. Rows are kept under the
 * subject a run searched for, so someone taken off Tracking left their posts
 * behind: on 24 Nov 2026, 25 rows (14 checked) of a person no longer tracked
 * still showed as a subject and counted in every figure. They stay stored,
 * hidden, and count again if that person is added back.
 */
export const isTracked = (m: SocialMention, names: Set<string>) => names.has(m.subject.trim().toLowerCase());

/**
 * The tab's two headline figures for posts dated from → to (YYYY-MM-DD, both
 * days in), or for every post when no range is given: the distinct posts the
 * AI has checked about a tracked subject, and their net sentiment.
 */
export function sentimentSummary(mentions: SocialMention[], cfg: SocialConfig, from?: string, to?: string): { posts: number; net: number | null } {
  const handle = brandHandle(cfg), names = trackedNames(cfg);
  const inRange = (m: SocialMention) => !from || !to || (!!m.posted_at && m.posted_at.slice(0, 10) >= from && m.posted_at.slice(0, 10) <= to);
  const checked = mentions.filter((m) => isTracked(m, names) && inRange(m) && namesSubject(m, handle) && isScored(m));
  return { posts: distinctPosts(checked), net: netScore(checked) };
}
