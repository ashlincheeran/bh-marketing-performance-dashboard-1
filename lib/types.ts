export type Tier = "T1-Global" | "T1-Local" | "T2" | "T3" | "Other";

export type Sentiment = "positive" | "neutral" | "negative" | "mixed" | null;

/** Shape of a mention from data/mentions.json or the Supabase tables. */
export interface RawMention {
  id: string;
  date: string | null;
  year: number | null;
  month: number | null;
  tier: Tier;
  outlet: string | null;
  title: string | null;
  url: string | null;
  eav: number | null;
  reach: number | null;
  brand: string;
  sentiment: Sentiment;
  // optional metadata — present in the JSON seed, omitted from DB reads
  tier_raw?: string | null;
  brand_raw?: string | null;
  media_type?: string | null;
  language?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  source?: string;
  sheet?: string;
  /**
   * The news bot found this story: the row is the bot's own ('googlenews'),
   * or a bot row for the same placement was folded into it (lib/placement.ts).
   * Set by getMentions; left out when false.
   */
  foundByBot?: boolean;
  /**
   * The news bot's article this story is (news_articles.id): its row's
   * metadata.articleId, or that of a bot row folded into it. Set by
   * getMentions; left out when no row says.
   */
  articleId?: string;
  /**
   * The ids of the bot's own rows ('googlenews') folded into this one. An old
   * bot row names no article, but an article imported from it names the row
   * (news_articles.legacy_mention_id), so Press mentions can still find it.
   * Set by getMentions; left out when none was folded in.
   */
  botRowIds?: string[];
}

/** Shape of an outlet from data/outlets.json or the Supabase table. */
export interface Outlet {
  outlet: string;
  tier: Tier;
  default_eav: number | null;
  default_reach: number | null;
  country?: string | null;
  language?: string | null;
  clip_count?: number;
  first_seen?: string | null;
  last_seen?: string | null;
}

/**
 * Enriched mention used by the UI. Raw eav/reach are preserved; eavEff/reachEff
 * fall back to the outlet's rate-card median when the clip itself has no value.
 */
export interface Mention {
  id: string;
  date: string | null;
  year: number | null;
  month: number | null;
  tier: Tier;
  outlet: string | null;
  title: string | null;
  url: string | null;
  eav: number | null;
  reach: number | null;
  eavEff: number;
  reachEff: number;
  modeled: boolean; // true when eav/reach were filled from the outlet table
  brand: string;
  sentiment: Sentiment;
  source: string; // 'historical_import' (manual) | 'googlenews' (AI) | 'manual'
  /**
   * The news bot found this story, though the copy kept may be the archive's.
   * Share of Voice counts our side by it, so a bot find whose archive twin is
   * the row shown still counts as bot-found, like the rivals' stories.
   */
  foundByBot?: boolean;
  /**
   * The news bot's article this story is, when a row says (RawMention.articleId).
   * Press mentions lists the rows of one article, ours and the rivals', as one.
   */
  articleId?: string;
  /** The bot's rows folded into this one (RawMention.botRowIds), for Press mentions. */
  botRowIds?: string[];
}
