// Social sentiment for the People Sentiment tab, scored by Claude.
//
// Gemini scored these until it ran out of credit (HTTP 402) in October 2026.
// It failed open: every post came back with no verdict, a post with no verdict
// is not stored, and so nothing new reached the tab after 19 Oct 2026 while
// the weekly runs still looked busy. Claude already checks the news bot's
// articles and writes the PR insights, with the key, the model setting and the
// error handling in lib/claude.ts, so a failure here is named and stops the
// run instead of passing as "no verdict".
import * as z from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Sentiment } from "@/lib/types";
import { claudeClient, describeAiError, type AiFailure } from "@/lib/claude";

// Relevance, a noise class, a tone, and a numeric score on a FIXED rubric so
// month-over-month deltas are meaningful.
export interface SocialAssessment {
  relevant: boolean;
  sentiment: Sentiment;
  score: number | null; // -1..1
  reason: string | null;
  noise: string | null; // recruitment_noise | namesake | job_bot | null
}

const TONES = ["positive", "neutral", "negative", "mixed"] as const;
const NOISE = ["recruitment_noise", "namesake", "job_bot"] as const;

/** A short JSON answer, and the little thinking a low effort allows. A cut-off answer is a failure. */
const MAX_TOKENS = 1000;

const answerSchema = z.object({
  relevant: z.boolean().describe("Whether the post is genuinely about the subject"),
  noise: z.string().nullable().describe(`One of ${NOISE.join(", ")}, or null`),
  sentiment: z.string().describe(`The tone toward the subject: one of ${TONES.join(", ")}`),
  score: z.number().describe("From -1.0 (very negative) to 1.0 (very positive), on the rubric"),
  reason: z.string().describe("Why, in at most 12 words"),
});

/** The instructions: the same subject wording and rubric Gemini had, so scores stay comparable across months. */
export function socialPrompt(subject: string, kind: "company" | "person", channel: string): string {
  const who =
    kind === "company"
      ? `"${subject}", a real-estate brokerage in DUBAI, UAE`
      : `${subject}, a person linked to betterhomes (a Dubai real-estate brokerage)`;
  return (
    `You are scoring online sentiment about ${who}. The user sends one ${channel} post or review.\n` +
    `Decide:\n` +
    `1) relevant: is this genuinely about ${who}? false if it is a namesake / different brand or person, an unrelated coincidence, or pure recruitment / job-board spam.\n` +
    `2) noise: one of "recruitment_noise", "namesake", "job_bot", or null.\n` +
    `3) sentiment: positive | neutral | negative | mixed (tone toward ${subject}).\n` +
    `4) score: a number from -1.0 (very negative) to 1.0 (very positive); 0 = neutral. Use this FIXED rubric so months are comparable: ` +
    `praise / recommendation > 0.5; satisfied or mildly positive 0.1..0.5; factual / neutral -0.1..0.1; complaint / disappointed -0.5..-0.1; serious grievance or warning < -0.5.\n` +
    `5) reason: at most 12 words.`
  );
}

/** Claude's answer as a verdict, or null when it is not one: a tone outside the four, or no score. */
export function readVerdict(raw: unknown): SocialAssessment | null {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  const sentiment = TONES.find((t) => t === a.sentiment.trim().toLowerCase());
  if (!sentiment || !Number.isFinite(a.score)) return null;
  const noise = NOISE.find((n) => n === a.noise?.trim().toLowerCase()) ?? null;
  return {
    relevant: a.relevant,
    sentiment,
    score: Math.max(-1, Math.min(1, a.score)),
    reason: a.reason.trim().slice(0, 140) || null,
    noise,
  };
}

/**
 * Score one post. Anything that keeps Claude from answering comes back as a
 * failure for the run to act on: the post waits for the next run, and a
 * failure every later call would share (no key, no credit, a refused key, a
 * model the key can't use) stops the run with the reason.
 */
export async function assessSocialMention(
  subject: string,
  kind: "company" | "person",
  channel: string,
  text: string,
  model: string,
): Promise<{ verdict: SocialAssessment } | { failure: AiFailure }> {
  if (!text.trim()) return { failure: { kind: "bad_answer", message: "The post has no text to score.", stopRun: false } };
  const client = claudeClient();
  if (!client) {
    return { failure: { kind: "no_key", message: "ANTHROPIC_API_KEY is not set, so posts cannot be scored.", stopRun: true } };
  }
  try {
    // No temperature: the API refuses it now. The low effort keeps thinking
    // short. Two tries of 30 s at most, so a slow answer can't outlast the run.
    const res = await client.messages.parse(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: socialPrompt(subject, kind, channel),
        messages: [{ role: "user", content: text.slice(0, 4000) }],
        output_config: { effort: "low", format: zodOutputFormat(answerSchema) },
      },
      { timeout: 30_000, maxRetries: 1 },
    );
    if (res.stop_reason === "refusal") {
      return { failure: { kind: "refusal", message: "Claude declined to score this post.", stopRun: false } };
    }
    if (res.stop_reason === "max_tokens") {
      return { failure: { kind: "bad_answer", message: `Claude's answer was cut off at ${MAX_TOKENS} tokens.`, stopRun: false } };
    }
    const verdict = readVerdict(res.parsed_output);
    if (!verdict) return { failure: { kind: "bad_answer", message: "Claude's answer could not be read as a score.", stopRun: false } };
    return { verdict };
  } catch (e) {
    return { failure: describeAiError(e) };
  }
}
