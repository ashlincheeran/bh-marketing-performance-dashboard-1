// The cached PR insights as stored in insights_cache, read without the
// database or the AI, so both the page's data layer (lib/data.ts) and the
// insights module (lib/insights.ts) can use it without importing each other.
import type { Insight } from "@/lib/pr";

/**
 * The insights_cache row the Claude insights live in. Not "pr", the row the
 * Gemini insights used: that row holds a bare array of cards, and the code on
 * main reads it as one, so writing { insights, evidence } there from a preview
 * would have blanked the live PR tab's insights before this branch is merged.
 */
export const INSIGHTS_SCOPE = "pr_claude";

/** What a run read: the headlines it was given, and whether any rival story was among them. */
export interface InsightEvidence {
  text: string;
  hasRivalStories: boolean;
}

/**
 * The insights_cache payload in either of its shapes. Sets cached before Nov
 * 2026 are a bare array of cards with no evidence; newer ones are
 * { insights, evidence }.
 */
export function readInsightsCache(payload: unknown): { insights: Insight[]; evidence: InsightEvidence | null } | null {
  const raw = Array.isArray(payload)
    ? { insights: payload, evidence: null }
    : payload && typeof payload === "object"
      ? (payload as { insights?: unknown; evidence?: unknown })
      : null;
  if (!raw || !Array.isArray(raw.insights)) return null;
  const insights = raw.insights.filter(
    (i): i is Insight =>
      !!i && typeof i === "object" && typeof (i as Insight).label === "string" && typeof (i as Insight).text === "string",
  );
  if (!insights.length) return null;
  const ev = raw.evidence as Partial<InsightEvidence> | null | undefined;
  const evidence =
    ev && typeof ev.text === "string" && typeof ev.hasRivalStories === "boolean"
      ? { text: ev.text, hasRivalStories: ev.hasRivalStories }
      : null;
  return { insights, evidence };
}
