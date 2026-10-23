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
