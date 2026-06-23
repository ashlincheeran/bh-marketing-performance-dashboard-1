// AI assessment via Google Gemini. The bot only calls this AFTER its own code
// has confirmed the article text contains a brand name, so Gemini's job is:
//   (1) confirm the match is really that DUBAI brokerage — not a coincidence,
//       a different US brand, or an unrelated business that shares a word in the
//       name (e.g. a café/restaurant called "Haus", "white collar", etc.), and
//   (2) score the sentiment FROM THE ARTICLE BODY.
//
// Fails open (keeps, null sentiment) if no key or an error occurs, so the bot
// keeps working when Gemini is unavailable.
import type { Sentiment } from "@/lib/types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

export interface Assessment {
  relevant: boolean;
  sentiment: Sentiment;
}

function parseAssessment(out: string): Assessment {
  const t = out.toLowerCase();
  if (t.includes("positive")) return { relevant: true, sentiment: "positive" };
  if (t.includes("negative")) return { relevant: true, sentiment: "negative" };
  if (t.includes("mixed")) return { relevant: true, sentiment: "mixed" };
  if (t.includes("neutral")) return { relevant: true, sentiment: "neutral" };
  if (t.includes("no")) return { relevant: false, sentiment: null };
  return { relevant: true, sentiment: null };
}

// One Gemini call. Returns relevant:true / sentiment:null when no key or error
// (fail-open) so a missing key or outage never drops articles.
async function ask(prompt: string): Promise<Assessment> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return { relevant: true, sentiment: null };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 64 },
        }),
        cache: "no-store",
      },
    );
    const data = await res.json();
    return parseAssessment(String(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ""));
  } catch {
    return { relevant: true, sentiment: null };
  }
}

/** Confirm + score an article that our matcher thinks mentions betterhomes. */
export async function assessMention(title: string, source: string, body = ""): Promise<Assessment> {
  if (!title) return { relevant: true, sentiment: null };
  const article = body ? `\nArticle text:\n${body.slice(0, 6000)}` : "";
  return ask(
    `"betterhomes" (also "Betterhomes"; sub-brand "PRIME by betterhomes"; people: Richard Waind, Louis Harding, Linda Mahoney) is a real-estate BROKERAGE in DUBAI, UAE. ` +
      `This article was flagged because its text contains "betterhomes". First decide whether it is genuinely about, or quotes, that Dubai brokerage. ` +
      `Reply exactly "no" if it is actually "Better Homes & Gardens" (a different US brand) or a coincidental/unrelated use of the words "better homes". ` +
      `Otherwise reply with the sentiment toward betterhomes in ONE word: positive, neutral, negative, or mixed.\n\n` +
      `Title: "${title}"\nSource: "${source}"${article}`,
  );
}

/**
 * Confirm + score an article that our matcher thinks mentions a competitor.
 * Catches the "café named Haus", "white collar", "metropolitan area",
 * "data-driven" style coincidences that the deterministic matcher can't tell
 * apart from the real Dubai brokerage.
 */
export async function assessCompetitor(brand: string, title: string, source: string, body = ""): Promise<Assessment> {
  if (!title || !brand) return { relevant: true, sentiment: null };
  const article = body ? `\nArticle text:\n${body.slice(0, 6000)}` : "";
  return ask(
    `"${brand}" is a real-estate BROKERAGE operating in DUBAI, UAE. ` +
      `This article was flagged because its text appears to contain "${brand}". Decide whether it genuinely refers to that Dubai real-estate brokerage. ` +
      `Reply exactly "no" if the match is a coincidence or a DIFFERENT business/place that merely shares a word in the name ` +
      `(for example a café, restaurant, salon, hotel, building or unrelated company — "Haus of …", "Capital Haus", "Piehaus", "Jacob & Co", "white collar", "metropolitan area", "data-driven"), ` +
      `or if the article is not about this brokerage or the Dubai property market at all. ` +
      `Otherwise reply with the sentiment toward "${brand}" in ONE word: positive, neutral, negative, or mixed.\n\n` +
      `Title: "${title}"\nSource: "${source}"${article}`,
  );
}
