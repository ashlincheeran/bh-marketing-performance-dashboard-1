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
  const sentences = (text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=["“‘(\[]?[A-Z0-9])/)
    .map((x) => x.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const sentence of sentences) {
    const probe = sentence.replace(NOT_US, " ");
    const word = probe.match(BRAND_WORD);
    const pair = !word && !titleCase(probe) ? probe.match(BRAND_PAIR) : null;
    const hit = word ?? pair;
    if (!hit) continue;
    let quote = sentence;
    if (quote.length > 400) {
      const at = Math.max(0, (hit.index ?? 0) - 180);
      quote = sentence.slice(at, at + 400).trim();
    }
    if (!out.includes(quote)) out.push(quote);
    if (out.length >= max) break;
  }
  return out;
}

/** True if the text names the Dubai brokerage betterhomes (see findBrandSentences). */
export function mentionsBetterhomes(text: string): boolean {
  return findBrandSentences(text, 1).length > 0;
}

/** Web-address endings dropped when naming a publication from its domain. */
const DOMAIN_ENDINGS = new Set(["com", "net", "org", "io", "co", "ae", "uk", "au", "in", "me", "info", "news", "biz"]);

/**
 * A publication's identity, however the feed named it.
 *
 * The news feed names an outlet by its title one day and its web address the
 * next, so "Khaleej Times" and "khaleejtimes.com" were stored as two outlets
 * and one article as two placements. Both now give "khaleejtimes". The
 * article's own address wins when known, since "Gulf Daily News (Bahrain)" and
 * "GDNOnline" share nothing but their site.
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
    const labels = raw.replace(/^www\./, "").split(".").filter(Boolean);
    while (labels.length > 1 && DOMAIN_ENDINGS.has(labels[labels.length - 1])) labels.pop();
    base = labels[labels.length - 1] ?? raw;
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
