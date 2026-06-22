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
                    `"betterhomes" (also "Betterhomes"; sub-brand "PRIME by betterhomes"; people: Richard Waind, Louis Harding, Linda Mahoney) is a real-estate brokerage based in DUBAI, UAE. ` +
                    `Decide if this news article is relevant to betterhomes. Reply "no" UNLESS at least one is true: ` +
                    `(a) it names or quotes betterhomes, "PRIME by betterhomes", or one of its people; OR ` +
                    `(b) it is about the Dubai or UAE property / real-estate market (where betterhomes is a leading broker and is routinely quoted in the body). ` +
                    `Reply "no" for property-market news about other countries or cities (UK, USA, Australia, India, Sydney, Perth, Seattle, etc.) that does not mention betterhomes; ` +
                    `for "Better Homes & Gardens" / "Better Homes and Gardens Real Estate" (a different US brand — always reject); and for generic home-décor, gardening, shopping, or unrelated firms. ` +
                    `If relevant, instead reply with the sentiment toward betterhomes: positive, neutral, negative, or mixed.\n\n` +
                    `Headline: "${title}"\nSource: "${source}"`,
                },
              ],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 64 },
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
