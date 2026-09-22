// The two parts of the SEO & AI Channel report that cannot be pulled live.
//
// Semrush AI Visibility (mentions, citations, cited pages, top prompts) is not
// exposed by the Semrush connector this app has — its toolkits cover backlinks,
// keywords, organic, projects, site audit and trends, and AI Visibility is a
// separate product with no report in that list. ClickUp content production has
// no connector at all.
//
// So they are stored, not hardcoded. Hardcoding would freeze them into a
// deploy; storing them means the team updates the figures in Settings when the
// monthly Semrush export lands, the page reads whatever is current, and an
// `asOf` stamp travels with the numbers so nobody mistakes a stale figure for a
// live one. Everything else on the page is genuinely live.
//
// Kept in the existing seo_config payload rather than a new table: it is
// already a jsonb singleton for this tab's settings.
import { readClient } from "@/lib/supabase";

export interface AiVisibility {
  /** Month these figures describe, YYYY-MM. Rendered next to them. */
  asOf: string;
  mentions: number;
  citations: number;
  citedPages: number;
  prevMentions: number;
  prevCitations: number;
  prevCitedPages: number;
  visibilityScore: number | null;
  visibilityRating: string | null;
  mentionsByMonth: { month: string; mentions: number }[];
  promptsTracked: number;
  promptsMentioned: number;
  promptsCited: number;
  topPrompts: { prompt: string; platform: string; result: string }[];
}

export interface ContentProduction {
  asOf: string;
  author: string;
  categories: { category: string; current: number; previous: number }[];
}

export interface SeoManual {
  aiVisibility: AiVisibility;
  content: ContentProduction;
  /** False when nothing has been stored yet and the seeded values are showing. */
  stored: boolean;
}

/**
 * Seeded from the August 2026 report so the sections render before anyone has
 * entered anything. The asOf stamp is what stops these reading as current.
 */
const SEED_VISIBILITY: AiVisibility = {
  asOf: "2026-08",
  mentions: 359,
  citations: 3400,
  citedPages: 1100,
  prevMentions: 584,
  prevCitations: 2500,
  prevCitedPages: 692,
  visibilityScore: 41,
  visibilityRating: "Medium",
  mentionsByMonth: [
    { month: "2026-03", mentions: 596 },
    { month: "2026-04", mentions: 645 },
    { month: "2026-05", mentions: 690 },
    { month: "2026-06", mentions: 643 },
    { month: "2026-07", mentions: 584 },
    { month: "2026-08", mentions: 359 },
  ],
  promptsTracked: 3100,
  promptsMentioned: 476,
  promptsCited: 2800,
  topPrompts: [
    { prompt: "house selling companies", platform: "Google AI", result: "Mentioned + Cited" },
    { prompt: "What are the top nearby attractions and dining options around Rose Palace Arjan in Dubai?", platform: "ChatGPT", result: "Cited" },
    { prompt: "top 20 real estate companies in dubai", platform: "Google AI", result: "Mentioned + Cited" },
    { prompt: "top 50 real estate companies in dubai", platform: "Google AI", result: "Mentioned + Cited" },
    { prompt: "Which UAE companies tend to offer the best salary and career growth for sales executives?", platform: "Gemini", result: "Mentioned" },
  ],
};

const SEED_CONTENT: ContentProduction = {
  asOf: "2026-08",
  author: "Asad Sohail",
  categories: [
    { category: "Community / building / location guides", current: 18, previous: 10 },
    { category: "Market / off-plan / investment pieces", current: 13, previous: 1 },
    { category: "Legal / process explainers", current: 6, previous: 4 },
    { category: "School / education content", current: 5, previous: 4 },
    { category: "Other", current: 1, previous: 3 },
  ],
};

export async function getSeoManual(): Promise<SeoManual> {
  const db = readClient();
  if (!db) return { aiVisibility: SEED_VISIBILITY, content: SEED_CONTENT, stored: false };
  try {
    const { data } = await db.from("seo_config").select("payload").eq("id", 1).maybeSingle();
    const p = (data?.payload ?? {}) as { aiVisibility?: Partial<AiVisibility>; content?: Partial<ContentProduction> };
    const stored = !!(p.aiVisibility || p.content);
    return {
      // Merged rather than replaced, so a partially filled entry keeps the rest
      // of the shape instead of rendering blanks.
      aiVisibility: { ...SEED_VISIBILITY, ...(p.aiVisibility ?? {}) },
      content: { ...SEED_CONTENT, ...(p.content ?? {}) },
      stored,
    };
  } catch {
    return { aiVisibility: SEED_VISIBILITY, content: SEED_CONTENT, stored: false };
  }
}
