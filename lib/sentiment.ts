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
                    `These headlines came from a Google News search for the Dubai real-estate brokerage "betterhomes" ` +
                    `(also "Betterhomes"; brands include "PRIME by betterhomes"; people include CEO Louis Harding and founder Linda Mahoney). ` +
                    `Most genuinely involve betterhomes even if the company is only quoted in the body, not named in the headline. ` +
                    `Reply "no" if the article is NOT about this company. In particular, "Better Homes & Gardens" — including "Better Homes and Gardens Real Estate" — is a DIFFERENT US brand and is NEVER our betterhomes; always reject it. Also reject generic home-décor/gardening/shopping content and unrelated firms. ` +
                    `Otherwise reply with the sentiment toward betterhomes: positive, neutral, negative, or mixed.\n\n` +
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
