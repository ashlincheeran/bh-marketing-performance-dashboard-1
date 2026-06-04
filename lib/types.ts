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
}
