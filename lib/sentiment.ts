// Social sentiment for the People Sentiment tab, through Google Gemini.
//
// The press checks that used to live here (assessMention, verifyMention,
// assessCompetitor) went with the old news bot: the news bot and the PR
// insights ask Claude now (lib/news/classify.ts, lib/insights.ts). They failed
// open when Gemini ran out of credit, counting rival stories nobody had checked.
import type { Sentiment } from "@/lib/types";
import { askGemini, geminiKey } from "@/lib/gemini";

// ── Social sentiment (People Sentiment tab) ─────────────────────
// Richer than the PR one-word call: returns relevance, a noise class, a tone,
// and a numeric score on a FIXED rubric so month-over-month deltas are
// meaningful. Fails open (relevant, null tone) on no key / error.
export interface SocialAssessment {
  relevant: boolean;
  sentiment: Sentiment;
  score: number | null; // -1..1
  reason: string | null;
  noise: string | null; // recruitment_noise | namesake | job_bot | null
}

const NEUTRAL_SOCIAL: SocialAssessment = { relevant: true, sentiment: null, score: null, reason: null, noise: null };

export async function assessSocialMention(
  subject: string,
  kind: "company" | "person",
  channel: string,
  text: string,
): Promise<SocialAssessment> {
  const key = geminiKey();
  if (!key || !text) return NEUTRAL_SOCIAL;
  const who =
    kind === "company"
      ? `"${subject}", a real-estate brokerage in DUBAI, UAE`
      : `${subject}, a senior executive at betterhomes (a Dubai real-estate brokerage)`;
  const prompt =
    `You are scoring online sentiment about ${who}. A ${channel} post/review is below.\n` +
    `Decide:\n` +
    `1) relevant: is this genuinely about ${who}? false if it is a namesake / different brand or person, an unrelated coincidence, or pure recruitment / job-board spam.\n` +
    `2) noise: one of "recruitment_noise", "namesake", "job_bot", or null.\n` +
    `3) sentiment: positive | neutral | negative | mixed (tone toward ${subject}).\n` +
    `4) score: a number from -1.0 (very negative) to 1.0 (very positive); 0 = neutral. Use this FIXED rubric so months are comparable: ` +
    `praise / recommendation > 0.5; satisfied or mildly positive 0.1..0.5; factual / neutral -0.1..0.1; complaint / disappointed -0.5..-0.1; serious grievance or warning < -0.5.\n` +
    `Reply ONLY with compact JSON: {"relevant":boolean,"noise":string|null,"sentiment":"...","score":number,"reason":"<=12 words"}\n\n` +
    `Text:\n${text.slice(0, 4000)}`;
  try {
    const cleaned = await askGemini(key, prompt, { temperature: 0, maxOutputTokens: 140 });
    const s = cleaned.indexOf("{");
    const e = cleaned.lastIndexOf("}");
    if (s === -1 || e === -1 || e <= s) return NEUTRAL_SOCIAL;
    const j = JSON.parse(cleaned.slice(s, e + 1));
    const allowed = ["positive", "neutral", "negative", "mixed"];
    const sentiment = (allowed.includes(j?.sentiment) ? j.sentiment : null) as Sentiment;
    let score = typeof j?.score === "number" ? j.score : null;
    if (score != null) score = Math.max(-1, Math.min(1, score));
    const noise = j?.noise && j.noise !== "null" ? String(j.noise).slice(0, 40) : null;
    return {
      relevant: j?.relevant !== false,
      sentiment,
      score,
      reason: j?.reason ? String(j.reason).slice(0, 140) : null,
      noise,
    };
  } catch {
    return NEUTRAL_SOCIAL;
  }
}
