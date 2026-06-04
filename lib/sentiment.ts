// Optional sentiment tagging via Claude. Returns null when ANTHROPIC_API_KEY
// isn't set, so ingestion still works before the AI key is added.
import type { Sentiment } from "@/lib/types";

export async function classifySentiment(headline: string): Promise<Sentiment> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !headline) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 8,
        messages: [
          {
            role: "user",
            content:
              `You rate how a news headline reflects on the Dubai real-estate company "betterhomes". ` +
              `Reply with exactly one word: positive, neutral, negative, or mixed.\n\nHeadline: "${headline}"`,
          },
        ],
      }),
    });
    const data = await res.json();
    const out = String(data?.content?.[0]?.text ?? "").toLowerCase();
    if (out.includes("positive")) return "positive";
    if (out.includes("negative")) return "negative";
    if (out.includes("mixed")) return "mixed";
    if (out.includes("neutral")) return "neutral";
    return null;
  } catch {
    return null;
  }
}
