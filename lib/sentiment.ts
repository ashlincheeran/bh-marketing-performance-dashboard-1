// AI assessment via Google Gemini: in one call, decide whether an article is
// actually about the Dubai brokerage "betterhomes" (vs generic "better homes"
// noise or another company) AND its sentiment.
//
// Fails open: if no GEMINI_API_KEY or an error occurs, the article is kept
// (relevant) with null sentiment, so we never silently lose coverage.
import type { Sentiment } from "@/lib/types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

export interface Assessment {
  relevant: boolean;
  sentiment: Sentiment;
}

export async function assessMention(title: string, source: string): Promise<Assessment> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key || !title) return { relevant: true, sentiment: null };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text:
                    `You curate a press-monitoring feed for the Dubai real-estate brokerage "betterhomes" ` +
                    `(also written "Betterhomes"; sub-brands include "PRIME by betterhomes"). ` +
                    `Decide if this article is about that company — it mentions, quotes, or cites betterhomes — ` +
                    `and is NOT a generic "better homes" phrase or a different company. ` +
                    `Reply with EXACTLY one word: "no" if it is not about betterhomes; ` +
                    `otherwise the sentiment toward betterhomes as one of: positive, neutral, negative, mixed.\n\n` +
                    `Headline: "${title}"\nSource: "${source}"`,
                },
              ],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 10 },
        }),
      },
    );
    const data = await res.json();
    const out = String(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").toLowerCase();
    if (out.includes("positive")) return { relevant: true, sentiment: "positive" };
    if (out.includes("negative")) return { relevant: true, sentiment: "negative" };
    if (out.includes("mixed")) return { relevant: true, sentiment: "mixed" };
    if (out.includes("neutral")) return { relevant: true, sentiment: "neutral" };
    if (out.includes("no")) return { relevant: false, sentiment: null };
    return { relevant: true, sentiment: null };
  } catch {
    return { relevant: true, sentiment: null };
  }
}
