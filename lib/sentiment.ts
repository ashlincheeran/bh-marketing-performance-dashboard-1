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
import { findBrandSentences } from "@/lib/match";

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

/**
 * Confirm + score an article our matcher flagged as mentioning betterhomes.
 *
 * The instructions below are deliberately explicit about ONE thing the old
 * prompt got wrong: it asked whether the article "is about, or quotes"
 * betterhomes. Most real coverage is neither. It is a market story that cites
 * our data — "according to analysis by Betterhomes", "Betterhomes figures
 * show" — with the brand named once, in the body, never in the headline. That
 * is the coverage the PR team logs, so it has to count here too.
 *
 * `bodyAvailable` matters just as much. When the body could not be fetched,
 * Gemini is told so and told not to reject on absence, because "the brand does
 * not appear" and "I was handed nothing to look at" are indistinguishable from
 * the model's side — and treating the second as the first is precisely how
 * months of coverage were dropped.
 */
export async function assessMention(
  title: string,
  source: string,
  body = "",
  bodyAvailable = true,
): Promise<Assessment> {
  if (!title) return { relevant: true, sentiment: null };

  const who =
    `"betterhomes" (also written "Betterhomes" or "Better Homes"; short form "bhomes"; ` +
    `sub-brand "PRIME by betterhomes") is a real-estate BROKERAGE in DUBAI, UAE. ` +
    `Its people include Richard Waind (CEO), Alex Leigh (Director of Operations), ` +
    `Louis Harding and Linda Mahoney.`;

  const counts =
    `COUNT AS RELEVANT — any of these, even if betterhomes is named only once and ` +
    `the headline never mentions it:\n` +
    `  - the article cites betterhomes data, analysis, research, a report or figures\n` +
    `  - it quotes a betterhomes spokesperson\n` +
    `  - it describes a betterhomes listing, launch, award or announcement\n` +
    `  - betterhomes is named as a source, agency or market commentator\n`;

  const rejects =
    `REPLY EXACTLY "no" ONLY IF:\n` +
    `  - the match is "Better Homes & Gardens", a different US brand, or\n` +
    `  - "better homes" is used as ordinary words, not a company name, or\n` +
    `  - the company named is a different firm that merely shares the words.\n`;

  const evidence = bodyAvailable
    ? `Article text follows. Judge from it.\n\nArticle text:\n${body.slice(0, 8000)}`
    : `NOTE: the article body could NOT be retrieved — you are seeing the headline ` +
      `and outlet only. Do NOT reply "no" merely because betterhomes is absent from ` +
      `the headline; most of our coverage names us only in the body. Reply "no" only ` +
      `if the headline makes it positively clear this is a different brand or an ` +
      `unrelated subject. Otherwise judge sentiment from the headline.`;

  return ask(
    `${who}\n\n${counts}\n${rejects}\n` +
      `If relevant, reply with the sentiment TOWARD betterhomes in ONE word: ` +
      `positive, neutral, negative, or mixed.\n\n` +
      `Title: "${title}"\nSource: "${source}"\n\n${evidence}`,
  );
}

/** How an article uses our name. */
export type MentionRole = "spokesperson" | "data" | "news" | "passing";

/** A fact-checked verdict: counted only with a sentence from the article that proves it. */
export interface Verdict extends Assessment {
  role: MentionRole | null;
  /** The proving sentence, word for word from the article; or what the AI offered when it failed the check. */
  quote: string | null;
  /** Why it doesn't count, when it doesn't. */
  why: string | null;
}

const ROLES = new Set<string>(["spokesperson", "data", "news", "passing"]);
const SENTIMENTS = new Set<string>(["positive", "neutral", "negative", "mixed"]);
/** Straight quotes, single spaces, one case: a sentence copied out of the article compares as written. */
const flat = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();

/** The verdict as one object, not one per sentence. Gemini enforces the shape. */
const VERDICT_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_betterhomes: { type: "BOOLEAN" },
    role: { type: "STRING" },
    quote: { type: "STRING" },
    sentiment: { type: "STRING" },
  },
  required: ["is_betterhomes", "role", "quote", "sentiment"],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One JSON answer from Gemini, or why there is none.
 *
 * A busy server or a per-minute limit clears in seconds, so those are asked
 * again twice, after Gemini's own retry delay when it gives one (up to 20 s). A
 * daily quota does not clear, so it is reported at once: the caller stops
 * spending article reads on answers that cannot come.
 */
async function askJson(
  key: string,
  prompt: string,
  schema: object,
  maxOutputTokens: number,
): Promise<{ out: unknown } | { error: string }> {
  const waits = [4_000, 12_000];
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens, responseMimeType: "application/json", responseSchema: schema },
        }),
        cache: "no-store",
      });
    } catch (e) {
      if (attempt < waits.length) {
        await sleep(waits[attempt]);
        continue;
      }
      return { error: `Gemini unreachable: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).replace(/key=[^&\s"]+/g, "key=…").replace(/\s+/g, " ");
      const retryable = (res.status === 429 && !/PerDay/i.test(detail)) || res.status >= 500;
      if (retryable && attempt < waits.length) {
        const hinted = Number(detail.match(/"retryDelay":\s*"(\d+)/)?.[1]) * 1000;
        await sleep(Math.min(hinted || waits[attempt], 20_000));
        continue;
      }
      return { error: `Gemini HTTP ${res.status}: ${detail.slice(0, 300)}` };
    }
    const data = await res.json().catch(() => null);
    const text = String(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
    try {
      return { out: JSON.parse(text) };
    } catch {
      return { error: `unreadable answer (finish ${data?.candidates?.[0]?.finishReason ?? "none"}): ${text.slice(0, 160)}` };
    }
  }
}

/**
 * The second step of the fact check: the AI sees only the sentences that name
 * us (findBrandSentences) and must quote the one that proves the article is
 * about the Dubai brokerage.
 *
 * assessMention handed over the whole article, told the AI that "Better Homes"
 * was one of our spellings, and answered with one word, so nothing showed WHY a
 * story counted, and a Dubai rent story that said tenants could "find better
 * homes" passed. Here the answer is JSON with a role and a quote, and the quote
 * must appear in the article word for word and name us: an AI cannot vouch
 * with a sentence it made up.
 *
 * Fails closed: null when the AI gave no usable answer, so the caller leaves
 * the story for the next run instead of counting it unchecked.
 */
export async function verifyMention(
  title: string,
  source: string,
  sentences: string[],
  article: string,
  /** Told why, when the AI gives no usable answer. */
  onNoAnswer?: (why: string) => void,
): Promise<Verdict | null> {
  const none = (why: string) => {
    onNoAnswer?.(why);
    return null;
  };
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return none("no Gemini key on this deployment");
  if (!sentences.length) return none("no sentence names us");
  const prompt =
    `"betterhomes" (also written "Betterhomes"; short form "bhomes"; sub-brand "PRIME by betterhomes") ` +
    `is a real-estate BROKERAGE in DUBAI, UAE. Its people include Richard Waind (CEO), Alex Leigh ` +
    `(Director of Operations), Rupert Simmonds (Director of Leasing), Louis Harding and Linda Mahoney.\n\n` +
    `These are the only sentences in the article that contain the name. Decide whether the article names ` +
    `the Dubai brokerage AS A COMPANY. It does when a sentence quotes or names one of its people ` +
    `("spokesperson"), cites its data, research, report or figures ("data"), reports its own news, ` +
    `listings, launches, awards or results ("news"), or names it among agencies or companies ("passing"). ` +
    `It does not when "better homes" is an ordinary phrase, when it is Better Homes & Gardens, or when it ` +
    `is a different company with a similar name.\n\n` +
    `Title: "${title}"\nSource: "${source}"\nSentences:\n${sentences.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\n` +
    `Reply with JSON only: {"is_betterhomes": true or false, "role": "spokesperson" | "data" | "news" | ` +
    `"passing" | "not_us", "quote": "the numbered sentence that proves it, copied exactly", ` +
    `"sentiment": "positive" | "neutral" | "negative" | "mixed"}`;
  const answer = await askJson(key, prompt, VERDICT_SCHEMA, 400);
  if ("error" in answer) return none(answer.error);
  // One object per sentence instead of one verdict: the one that says yes decides.
  type Out = { is_betterhomes?: unknown; role?: unknown; quote?: unknown; sentiment?: unknown };
  const list = (Array.isArray(answer.out) ? answer.out : [answer.out]) as (Out | null)[];
  const out = list.find((o) => o?.is_betterhomes === true) ?? list[0];
  if (typeof out?.is_betterhomes !== "boolean") return none(`no yes or no in the answer: ${JSON.stringify(answer.out).slice(0, 160)}`);
  if (!out.is_betterhomes) {
    return { relevant: false, sentiment: null, role: null, quote: null, why: "the AI found no sentence naming the Dubai brokerage" };
  }
  const quote = typeof out.quote === "string" ? out.quote.trim() : "";
  const proven = quote.length >= 20 && flat(article).includes(flat(quote)) && findBrandSentences(quote, 1).length > 0;
  if (!proven) {
    return { relevant: false, sentiment: null, role: null, quote: quote || null, why: "the AI's quote is not in the article word for word" };
  }
  return {
    relevant: true,
    sentiment: typeof out.sentiment === "string" && SENTIMENTS.has(out.sentiment) ? (out.sentiment as Sentiment) : null,
    role: typeof out.role === "string" && ROLES.has(out.role) ? (out.role as MentionRole) : "passing",
    quote,
    why: null,
  };
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
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
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
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 140 },
        }),
        cache: "no-store",
      },
    );
    const data = await res.json();
    const raw = String(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
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
