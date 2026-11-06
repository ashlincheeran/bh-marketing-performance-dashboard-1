// Google Gemini, which the dashboard still asks for two things: the People
// Sentiment tone (lib/sentiment.ts) and the takeaways behind the Receive
// insights buttons on Socials Performance and Website (app/actions.ts).
// Server-only, since the key goes in the request's URL.

/** The Gemini API key, under either of the names a deployment may give it. */
export const geminiKey = (): string | undefined => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

/**
 * Ask Gemini once and return its answer's text, with any ``` fences taken
 * off. A request that never reaches Gemini, or a reply that isn't JSON,
 * throws, for the caller's own catch to answer.
 */
export async function askGemini(
  key: string,
  prompt: string,
  generationConfig: { temperature: number; maxOutputTokens: number },
): Promise<string> {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
    cache: "no-store",
  });
  const json = await res.json();
  const raw = String(json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
  return raw.replace(/```json/gi, "").replace(/```/g, "").trim();
}
