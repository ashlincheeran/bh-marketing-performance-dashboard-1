// Optional sentiment tagging via Google Gemini. Returns null when GEMINI_API_KEY
// isn't set, so ingestion still works before the AI key is added.
//
// Model: gemini-2.0-flash by default — fast + cheap, ideal for short one-word
// classification. Override with GEMINI_MODEL if needed.
import type { Sentiment } from "@/lib/types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

export async function classifySentiment(headline: string): Promise<Sentiment> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key || !headline) return null;
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
                    `You rate how a news headline reflects on the Dubai real-estate company "betterhomes". ` +
                    `Reply with exactly one word: positive, neutral, negative, or mixed.\n\nHeadline: "${headline}"`,
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
    if (out.includes("positive")) return "positive";
    if (out.includes("negative")) return "negative";
    if (out.includes("mixed")) return "mixed";
    if (out.includes("neutral")) return "neutral";
    return null;
  } catch {
    return null;
  }
}
