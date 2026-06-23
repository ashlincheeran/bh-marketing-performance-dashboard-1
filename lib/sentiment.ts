// AI assessment via Google Gemini. The bot only calls this AFTER its own code
// has confirmed the article text actually contains "betterhomes", so Gemini's
// job is: (1) confirm it's really the Dubai brokerage (not "Better Homes &
// Gardens" or a coincidence) and (2) score the sentiment FROM THE ARTICLE BODY.
//
// Fails open (keeps, null sentiment) if no key or an error occurs.
import type { Sentiment } from "@/lib/types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

export interface Assessment {
  relevant: boolean;
  sentiment: Sentiment;
}

export async function assessMention(title: string, source: string, body = ""): Promise<Assessment> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key || !title) return { relevant: true, sentiment: null };
  const article = body ? `\nArticle text:\n${body.slice(0, 6000)}` : "";
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
                    `"betterhomes" (also "Betterhomes"; sub-brand "PRIME by betterhomes"; people: Richard Waind, Louis Harding, Linda Mahoney) is a real-estate BROKERAGE in DUBAI, UAE. ` +
                    `This article was flagged because its text contains "betterhomes". First decide whether it is genuinely about, or quotes, that Dubai brokerage. ` +
                    `Reply exactly "no" if it is actually "Better Homes & Gardens" (a different US brand) or a coincidental/unrelated use of the words "better homes". ` +
                    `Otherwise reply with the sentiment toward betterhomes in ONE word: positive, neutral, negative, or mixed.\n\n` +
                    `Title: "${title}"\nSource: "${source}"${article}`,
                },
              ],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 64 },
        }),
        cache: "no-store",
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
