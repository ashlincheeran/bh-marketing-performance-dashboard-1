// Shared, framework-free types for the People Sentiment tab. No server imports
// here so both the client component and the server modules can use them.
import type { Sentiment } from "@/lib/types";

export type SocialChannel = "instagram" | "linkedin" | "reddit" | "glassdoor" | "facebook";
export type SubjectKind = "company" | "person";
export type TimeWindow = "month" | "quarter" | "year";

export interface Subject {
  name: string;
  kind: SubjectKind;
}

// Per-platform source settings. `actor` is the Apify actor id (owner/name).
// The proven ones come from todo.md; glassdoor/facebook are best-guess defaults
// and are editable in the tab's Advanced panel so they can be fixed without a deploy.
export interface PlatformConfig {
  enabled: boolean;
  actor: string;
  /** instagram: the brand IG handle to read tagged/owned posts for. */
  username?: string;
  /** glassdoor: the company's Glassdoor reviews URL. */
  companyUrl?: string;
  /** facebook: the brand's public page URL. */
  pageUrl?: string;
  /** reddit: extra company query variants (people use their own name as the query). */
  queries?: string[];
  /** reddit: also search comments (slower; off by default to stay within the run budget). */
  includeComments?: boolean;
}

export interface SocialConfig {
  subjects: Subject[];
  platforms: Record<SocialChannel, PlatformConfig>;
  defaults: { window: TimeWindow; maxItems: number };
}

export interface SocialMention {
  id: string;
  channel: SocialChannel | string;
  subject: string;
  subject_kind: SubjectKind | string;
  url: string | null;
  author: string | null;
  posted_at: string | null;
  content: string | null;
  rating: number | null;
  likes: number;
  comments: number;
  shares: number;
  sentiment: Sentiment;
  sentiment_score: number | null;
  sentiment_reason: string | null;
  status: string;
}

export interface SocialRun {
  ran_at: string;
  trigger: string;
  ok: boolean;
  found: number;
  considered: number;
  inserted: number;
  skipped: number;
  error: string | null;
}

export const CHANNELS: { key: SocialChannel; name: string; icon: string; coversPeople: boolean; note: string }[] = [
  { key: "instagram", name: "Instagram", icon: "📸", coversPeople: false, note: "Owned + tagged posts for the brand handle." },
  { key: "linkedin",  name: "LinkedIn",  icon: "💼", coversPeople: true,  note: "Post search by company and by each person's name." },
  { key: "reddit",    name: "Reddit",    icon: "👽", coversPeople: true,  note: "Posts & comments by company and by each person's name." },
  { key: "glassdoor", name: "Glassdoor", icon: "🏢", coversPeople: true,  note: "Company reviews; people picked up by name in review text." },
  { key: "facebook",  name: "Facebook",  icon: "👍", coversPeople: true,  note: "Brand page posts/comments; people picked up by name." },
];

export const WINDOW_LABEL: Record<TimeWindow, string> = {
  month: "Last month",
  quarter: "Last 3 months",
  year: "Last 12 months",
};

// Number of days each window covers (for post-filtering — actor date filters are
// unreliable per todo.md, so we always filter by date ourselves).
export const WINDOW_DAYS: Record<TimeWindow, number> = { month: 31, quarter: 92, year: 366 };

export const DEFAULT_SOCIAL_CONFIG: SocialConfig = {
  subjects: [
    { name: "betterhomes", kind: "company" },
    { name: "Rupert Simmonds", kind: "person" },
    { name: "Richard Waind", kind: "person" },
  ],
  platforms: {
    instagram: { enabled: true, actor: "data-slayer/instagram-tagged-posts", username: "betterhomesuae" },
    linkedin:  { enabled: true, actor: "harvestapi/linkedin-post-search" },
    reddit:    { enabled: true, actor: "trudax/reddit-scraper-lite", queries: ["betterhomes dubai", "better homes dubai", "bhomes dubai"] },
    glassdoor: { enabled: true, actor: "bebity/glassdoor-reviews-scraper", companyUrl: "" },
    facebook:  { enabled: true, actor: "apify/facebook-posts-scraper", pageUrl: "https://www.facebook.com/betterhomesuae" },
  },
  defaults: { window: "quarter", maxItems: 15 },
};

/** Merge a stored (possibly partial) config over the defaults so new fields always exist. */
export function mergeConfig(stored: Partial<SocialConfig> | null | undefined): SocialConfig {
  if (!stored) return DEFAULT_SOCIAL_CONFIG;
  const d = DEFAULT_SOCIAL_CONFIG;
  const platforms = { ...d.platforms };
  for (const k of Object.keys(d.platforms) as SocialChannel[]) {
    platforms[k] = { ...d.platforms[k], ...(stored.platforms?.[k] ?? {}) };
  }
  return {
    subjects: stored.subjects?.length ? stored.subjects : d.subjects,
    platforms,
    defaults: { ...d.defaults, ...(stored.defaults ?? {}) },
  };
}
