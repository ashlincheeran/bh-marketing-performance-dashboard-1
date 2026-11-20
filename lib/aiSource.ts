// Which AI assistant a visit or a lead came from, by one rule for every
// assistant, so a new one is named without a code change. Shared by PostHog's
// queries (assistantKeySql) and the CRM's lead sources (assistantKey), so the
// SEO tab can set an assistant's visitors beside its leads. Change both together.

/**
 * The first real word of the source's name: chatgpt.com is "chatgpt", and
 * gemini.google.com and a link tagged plain "gemini" are both "gemini".
 * "www" and one-letter link prefixes (l.meta.ai is "meta") are skipped.
 * Empty when nothing is left.
 */
export function assistantKey(source: string): string {
  return (
    source
      .trim()
      .toLowerCase()
      .split(".")
      .find((p) => p.length > 1 && p !== "www") ?? ""
  );
}

/** assistantKey in HogQL, over an expression already lower-cased. */
export const assistantKeySql = (expr: string): string =>
  `arrayFirst(p -> length(p) > 1 AND p != 'www', splitByChar('.', ${expr}))`;
