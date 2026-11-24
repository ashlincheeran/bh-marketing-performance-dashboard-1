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

/** Average tone of the scored mentions, -1 to +1; null with none scored. Shown as an index from -100 to +100. */
export function netScore(items: SocialMention[]): number | null {
  const scored = items.filter((m) => typeof m.sentiment_score === "number");
  if (!scored.length) return null;
  return scored.reduce((a, m) => a + (m.sentiment_score as number), 0) / scored.length;
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
