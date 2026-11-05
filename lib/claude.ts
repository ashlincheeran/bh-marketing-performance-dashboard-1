// The Claude client, and what its errors mean. Server-only.
//
// Everything that asks Claude (the news bot's check step, the PR insights)
// gets its client here, so the key, the retries and the time limit are set in
// one place. A failure is sorted into a few kinds, because what happens next
// depends on the kind: no key, no credit or a refused key fail the same way for
// every article, so the run stops for the day and nothing new counts
// unchecked; so does a model the key can't use. A busy or broken service, or
// one odd answer, is worth another try on a later run.
import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";

/** Why Claude gave no usable answer, and whether asking again today is pointless. */
export type AiFailure = {
  kind: "no_key" | "credit" | "auth" | "model" | "rate" | "server" | "refusal" | "bad_answer" | "network";
  /** Plain words for logs and Bot Activity. Never holds the key. */
  message: string;
  /** True when every later call would fail the same way: stop asking until a later run. */
  stopRun: boolean;
};

let cached: { key: string; client: Anthropic } | null = null;

const configuredKey = () => process.env.ANTHROPIC_API_KEY?.trim() || null;

/**
 * The client, or null when ANTHROPIC_API_KEY is not set. Built once per key,
 * since the key changes only when the deployment's environment does.
 */
export function claudeClient(): Anthropic | null {
  const key = configuredKey();
  if (!key) return null;
  if (cached?.key !== key) {
    // The SDK retries a rate limit, an overload or a dropped connection twice
    // by itself, backing off in between. A minute per try is long for one
    // article's short answer, so a call still waiting after that has hung.
    cached = { key, client: new Anthropic({ apiKey: key, maxRetries: 2, timeout: 60_000 }) };
  }
  return cached.client;
}

/** True when a key is set. Says nothing about whether the key works. */
export function claudeConfigured(): boolean {
  return configuredKey() !== null;
}

/**
 * The API's ways of saying the account can't pay. An empty balance and a
 * reached usage limit come back as a 400, so the class alone can't tell them
 * from a malformed request; only the words can.
 */
const OUT_OF_CREDIT = /credit balance|usage limits?|spend(?:ing)? limits?/i;
/** The same for a 429, which is otherwise an ordinary rate limit that passes. */
const LIMIT_REACHED = /usage limits?|spend(?:ing)? limits?/i;
const SPEND_LIMIT_CODE = "enforced_spend_limit_reached";

/** The body of an API error, as the SDK keeps it: { type, error: { type, message }, request_id }. */
type ErrorBody = { message?: unknown; code?: unknown; error?: { message?: unknown; code?: unknown; type?: unknown } } | undefined;

/** The API's own words for an error. The SDK's message wraps them in the whole body as JSON. */
function apiDetail(e: APIError): string {
  const body = e.error as ErrorBody;
  const words = body?.error?.message ?? body?.message;
  return typeof words === "string" && words.trim() ? words : e.message;
}

/** Every code the error carries, wherever the API put it. */
function errorCodes(e: APIError): unknown[] {
  const body = e.error as ErrorBody;
  return [body?.error?.code, body?.code, body?.error?.type, e.type];
}

/** "fetch failed" is all a dropped connection says at the top; the reason is a cause or two down. */
function connectionDetail(e: APIConnectionError): string {
  const parts = [e.message.replace(/\.$/, "")];
  let cause: unknown = e.cause;
  for (let depth = 0; cause instanceof Error && depth < 3; depth++) {
    parts.push(cause.message.replace(/\.$/, ""));
    cause = cause.cause;
  }
  return parts.filter(Boolean).join(": ");
}

const http = (status: number | undefined) => (typeof status === "number" ? ` (HTTP ${status})` : "");

/**
 * One line, short, and without the key: a message here ends up on screens and
 * in logs, so the key is struck out even though the API never echoes it.
 */
function scrub(text: string): string {
  let out = text.replace(/\s+/g, " ").trim();
  const key = configuredKey();
  if (key) out = out.split(key).join("[key]");
  out = out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[key]");
  return out.length > 300 ? `${out.slice(0, 300)}...` : out;
}

/**
 * What a thrown error means for the run. The SDK's own error classes decide,
 * since each status has one, and the body's words only separate "no credit"
 * from the other errors that share its status.
 */
export function describeAiError(e: unknown): AiFailure {
  const fail = (kind: AiFailure["kind"], message: string, stopRun: boolean): AiFailure => ({
    kind,
    message: scrub(message),
    stopRun,
  });

  if (e instanceof AuthenticationError || e instanceof PermissionDeniedError) {
    return fail("auth", `The Claude key was refused${http(e.status)}: ${apiDetail(e)}`, true);
  }
  if (e instanceof BadRequestError && OUT_OF_CREDIT.test(apiDetail(e))) {
    return fail("credit", `The Claude account is out of credit or at its usage limit${http(e.status)}: ${apiDetail(e)}`, true);
  }
  if (e instanceof RateLimitError) {
    if (errorCodes(e).includes(SPEND_LIMIT_CODE) || LIMIT_REACHED.test(apiDetail(e))) {
      return fail("credit", `The Claude account has reached its spend limit${http(e.status)}: ${apiDetail(e)}`, true);
    }
    return fail("rate", `Claude is limiting how often this account may call it${http(e.status)}: ${apiDetail(e)}`, false);
  }
  // A 402 has no class of its own in the SDK, but it is the plainest "no
  // credit" of all, and every later call would get it too.
  if (e instanceof APIError && (e.status === 402 || e.type === "billing_error")) {
    return fail("credit", `Claude reports a billing problem on the account${http(e.status)}: ${apiDetail(e)}`, true);
  }
  // A 404 from the Messages API is the model: one the key may not use, or one
  // retired since it was chosen in Settings. Every article would get it.
  if (e instanceof NotFoundError || (e instanceof APIError && e.status === 404)) {
    return fail("model", `The Claude model chosen in Settings is not available to this key${http(e.status)}: ${apiDetail(e)}`, true);
  }
  if (e instanceof InternalServerError || (e instanceof APIError && typeof e.status === "number" && e.status >= 500)) {
    return fail("server", `Claude had a problem on its side${http(e.status)}: ${apiDetail(e)}`, false);
  }
  // Before the plain APIError below: in this SDK a connection error is one too, with no status.
  if (e instanceof APIConnectionError) {
    return fail("network", `Claude could not be reached: ${connectionDetail(e)}`, false);
  }
  if (e instanceof APIError) {
    return fail("bad_answer", `Claude refused the request${http(e.status)}: ${apiDetail(e)}`, false);
  }
  // What is left was thrown on this side, most often by the SDK finding that
  // the answer was not the JSON that was asked for.
  return fail("bad_answer", `Claude's answer could not be used: ${e instanceof Error ? e.message : String(e)}`, false);
}
