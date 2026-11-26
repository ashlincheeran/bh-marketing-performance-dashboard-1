// The keys that make "the same article" mean the same thing everywhere: when a
// search result arrives, when its real address is found, and when old stories
// are imported. A repeat on any key is dropped before anything reads it.
import { createHash } from "node:crypto";
import { outletKey, urlKey } from "@/lib/match";

// The address key lives with the outlet key, so the PR tab's read (lib/placement.ts) uses the same one.
export { outletKey, urlKey };

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/**
 * The headline without the " - Outlet" Google News adds, and without a
 * trailing "| Outlet" some sites put in their own titles.
 */
export function stripOutletSuffix(title: string, outlet: string | null): string {
  let t = (title || "").replace(/\s+/g, " ").trim();
  if (outlet) {
    const o = outlet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`\\s+[-–—|]\\s+${o}\\s*$`, "i"), "").trim();
  }
  return t;
}

/** The headline folded to letters and digits: case, accents, punctuation and the outlet suffix don't count. */
export function titleKey(title: string, outlet: string | null): string {
  return fold(stripOutletSuffix(title, outlet))
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A stable id for a new article: from the Google link when there is one, else the address, else the headline and outlet. */
export function articleId(parts: { googleLink?: string | null; url?: string | null; titleKey: string; outletKey: string }): string {
  const basis = parts.googleLink || urlKey(parts.url) || `${parts.titleKey}|${parts.outletKey}`;
  return "na_" + createHash("sha1").update(basis).digest("hex").slice(0, 20);
}
