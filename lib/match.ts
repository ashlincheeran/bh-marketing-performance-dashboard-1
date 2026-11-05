// Deterministic brand detection on article text (title + source + body).
// This is the cheap filter that runs BEFORE Gemini: only articles that
// genuinely contain the brand get routed (betterhomes → Gemini; competitor →
// tagged for Share of Voice; neither → dropped).
import type { SovBrand } from "@/lib/competitors";

// normalize: strip accents, lowercase, drop apostrophes, collapse spaces.
function nf(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Our name as one word, or its short form, in any case: "Betterhomes", "betterhomes", "bhomes.com". */
const BRAND_WORD = /\bbetterhomes\b|\bbhomes(?:\.com)?\b/i;
/** "Better Homes" written as a name, both words capitalised. Lowercase "better homes" is the ordinary phrase. */
const BRAND_PAIR = /\bBetter[ \u00a0]Homes\b/;
/** Other companies whose names contain ours. */
const NOT_US = /\bbetter[ \u00a0]?homes?\s*(?:&|and)\s*gardens\b|\bbetter[ \u00a0]?home\s+group\b/gi;

/** Headline style, where every word is capitalised and "Better Homes" proves nothing. */
function titleCase(sentence: string): boolean {
  const words = sentence.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
  if (words.length < 4) return false;
  return words.filter((w) => /^[A-Z]/.test(w)).length / words.length > 0.6;
}

/**
 * An article's text as sentences, the way the fact check reads it. Each one is
 * trimmed, with its runs of spaces made single, and empty ones are dropped.
 */
export function splitSentences(text: string): string[] {
  // A line break ends a sentence too: a crawled article puts its headline on a
  // line of its own with no full stop, and it ran into the first sentence
  // ("...busiest prime property market Business Bay overtook..."). Within a
  // line, a sentence ends after . ! or ? when the next starts with a capital, a
  // digit or an opening quote or bracket.
  return (text || "")
    .split(/\n+/)
    .flatMap((line) => line.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=["“‘(\[]?[A-Z0-9])/))
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Where one sentence names the Dubai brokerage betterhomes, or null when it
 * doesn't. This is the rule findBrandSentences applies, kept here alone so the
 * old bot and the new one can't disagree: "Better Homes & Gardens" and
 * "BetterHome Group" are struck out first, then "betterhomes" or "bhomes" as
 * one word counts in any case, and "Better Homes" counts only with both
 * capitals outside a title-case sentence. `index` is where the name starts.
 */
export function betterhomesAt(sentence: string): { index: number; length: number } | null {
  // Blanked to the same length, so a match's position is its place in the sentence.
  const probe = sentence.replace(NOT_US, (m) => " ".repeat(m.length));
  const word = probe.match(BRAND_WORD);
  const pair = !word && !titleCase(probe) ? probe.match(BRAND_PAIR) : null;
  const hit = word ?? pair;
  return hit ? { index: hit.index ?? 0, length: hit[0].length } : null;
}

/** True if this one sentence names betterhomes (see betterhomesAt). */
export function namesBetterhomes(sentence: string): boolean {
  return betterhomesAt(sentence) !== null;
}

/**
 * The part of a sentence to quote as proof of the name that runs from `at` to
 * `end`: all of it up to 400 characters, else 400 characters around the name,
 * starting and ending on whole words. Given as [from, to) rather than as text,
 * so a caller can tell which other names the quote kept.
 */
export function quoteSpan(sentence: string, at: number, end: number): [number, number] {
  if (sentence.length <= 400) return [0, sentence.length];
  let from = Math.max(0, at - 180);
  if (from > 0) from = sentence.indexOf(" ", from) + 1 || from;
  let to = Math.min(sentence.length, from + 400);
  if (to < sentence.length) to = Math.max(sentence.lastIndexOf(" ", to), end);
  return [from, to];
}

/**
 * The sentences that name the Dubai brokerage betterhomes, by strict rules: the
 * first step of the fact check, before any AI sees the article.
 *
 * The old test lowercased everything and accepted "better homes" anywhere, so
 * an UrduPoint story about Dubai rents counted as coverage because tenants could
 * "find better homes at lower prices". Now only our name counts: "betterhomes"
 * as one word in any case, "bhomes", or "Better Homes" capitalised as a name
 * outside a title-case headline. "Better Homes & Gardens" and "BetterHome Group"
 * are other companies and are struck out first. Each sentence is returned as
 * written, up to 400 characters around the name, so it can be quoted as proof.
 */
export function findBrandSentences(text: string, max = 8): string[] {
  const out: string[] = [];
  for (const sentence of splitSentences(text)) {
    const hit = betterhomesAt(sentence);
    if (!hit) continue;
    const [from, to] = quoteSpan(sentence, hit.index, hit.index + hit.length);
    const quote = sentence.slice(from, to).trim();
    if (!out.includes(quote)) out.push(quote);
    if (out.length >= max) break;
  }
  return out;
}

/** True if the text names the Dubai brokerage betterhomes (see findBrandSentences). */
export function mentionsBetterhomes(text: string): boolean {
  return findBrandSentences(text, 1).length > 0;
}

/** Web-address endings dropped when naming a publication from its domain: they name no publication. */
const DOMAIN_ENDINGS = new Set([
  "com", "net", "org", "io", "co", "ae", "uk", "au", "in", "me", "info", "news", "biz",
  "tv", "online", "site", "live", "today", "global", "world", "media", "press", "digital", "blog", "app", "ai",
]);
/** Subdomains that are the publication's own site, not another edition of it. */
const SAME_SITE = new Set(["www", "m", "mobile", "amp", "web", "news", "edition"]);

/**
 * A publication's identity, however the feed named it.
 *
 * The news feed names an outlet by its title one day and its web address the
 * next, so "Khaleej Times" and "khaleejtimes.com" were stored as two outlets
 * and one article as two placements. Both now give "khaleejtimes". The
 * article's own address wins when known, since "Gulf Daily News (Bahrain)" and
 * "GDNOnline" share nothing but their site.
 *
 * A country ending this list doesn't drop stays in the key, after the name:
 * "forbes.ro" is "forbesro", not "ro", which every Romanian site used to share,
 * so two of them carrying one headline were counted as one placement. And an
 * edition on its own subdomain is its own publication ("de.euronews.com" is
 * "euronewsde", "epaper.khaleejtimes.com" is "khaleejtimesepaper"), as the PR
 * team counts them, while "www." and "amp." are the site itself.
 */
export function outletKey(outlet: string | null | undefined, url?: string | null): string {
  let host = "";
  try {
    if (url) host = new URL(url).hostname.toLowerCase();
  } catch {
    // Not an address: the name decides.
  }
  // The feed's own wrapper link says nothing about the publisher.
  if (/(^|\.)google\.com$/.test(host)) host = "";
  const raw = (host || String(outlet ?? "")).toLowerCase().trim();
  let base = raw;
  if (host || !/\s/.test(raw)) {
    const labels = raw.split(".").filter(Boolean);
    let country = "";
    while (labels.length > 1) {
      const last = labels[labels.length - 1];
      if (DOMAIN_ENDINGS.has(last)) labels.pop();
      else if (!country && /^[a-z]{2}$/.test(last)) country = labels.pop() ?? "";
      else break;
    }
    const name = labels.pop() ?? raw;
    base = `${name}${labels.filter((l) => !SAME_SITE.has(l)).join("")}${country}`;
  }
  return base.replace(/[^a-z0-9]+/g, "").replace(/^the(?=[a-z]{4})/, "");
}

/** Returns the competitor's display name if the text clearly names one, else null. */
export function matchedCompetitor(text: string, brands: SovBrand[]): string | null {
  const t = nf(text);
  for (const b of brands) {
    if (b.isUs) continue;
    for (const needle of needles(b)) {
      if (needle.length >= 4 && t.includes(needle)) return b.name;
    }
  }
  return null;
}

function needles(b: SovBrand): string[] {
  const name = nf(b.name);
  const set = new Set<string>([
    name,
    name.replace(/&/g, "and"),
    name.replace(/&/g, " ").replace(/\s+/g, " ").trim(),
  ]);
  return [...set].map((s) => s.trim()).filter(Boolean);
}
