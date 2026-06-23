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

/**
 * True if the text genuinely mentions the Dubai brokerage betterhomes.
 * Excludes the unrelated US brand "Better Homes & Gardens" (and "...and Gardens").
 */
export function mentionsBetterhomes(text: string): boolean {
  let t = nf(text);
  t = t.replace(/better ?homes (?:&|and) gardens/g, " "); // remove the US brand so it can't count
  return /\bbetter ?homes\b/.test(t) || /\bbhomes\b/.test(t);
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
